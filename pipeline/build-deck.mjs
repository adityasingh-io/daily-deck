#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRaw, fetchWildcards, fetchArticleMeta } from "./sources.mjs";
import { scoreItems, writeCards, editCards, writeLetter, hash } from "./ai.mjs";
import { selectByQuota, interleave } from "./mixer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECKS = join(ROOT, "public", "decks");
const STATE = join(ROOT, "pipeline", "state");
const SEEN_FILE = join(STATE, "seen.json");

const args = process.argv.slice(2);
const force = args.includes("--force");
const push = args.includes("--push");
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const date = dateArg ?? todayIso();
const deckPath = join(DECKS, `${date}.json`);

if (existsSync(deckPath) && !force) {
  console.log(`Deck for ${date} already exists — nothing to do.`);
  process.exit(0);
}

mkdirSync(DECKS, { recursive: true });
mkdirSync(STATE, { recursive: true });

const profile = JSON.parse(readFileSync(join(ROOT, "pipeline", "profile.json"), "utf8"));
const seen = existsSync(SEEN_FILE) ? JSON.parse(readFileSync(SEEN_FILE, "utf8")) : {};

// prune seen entries older than 14 days
const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
for (const [k, v] of Object.entries(seen)) if (v < cutoff) delete seen[k];

console.log(`Building deck for ${date}…`);

const [raw, wildcardCands] = await Promise.all([collectRaw(), fetchWildcards(date)]);
console.log(`Fetched ${raw.length} raw items + ${wildcardCands.length} wildcard candidates`);

const fresh = raw.filter((it) => !seen[hash((it.link ?? it.title).toLowerCase())]);
console.log(`${fresh.length} unseen items going to triage (model: ${profile.model})`);

// Wildcards ride through the SAME triage as everything else — no free passes.
const wcAsRaw = wildcardCands
  .filter((c) => !seen[hash((c.deepLink ?? c.title).toLowerCase())])
  .map((c) => ({ title: c.title, text: c.body ?? "", topic: "wildcard", kindHint: c.kind, attribution: c.attribution, link: c.deepLink, _card: c }));

// Learning loop: the reader's synced save behavior feeds triage scoring
// (topic counts + save titles) and the writer's quality bar (saved openings).
async function readerState() {
  const out = { signalsText: "", exemplars: [] };
  try {
    const env = JSON.parse(readFileSync(join(ROOT, "pipeline", ".env.json"), "utf8"));
    const res = await fetch(env.url, { headers: { Authorization: `Bearer ${env.token}` } });
    if (!res.ok) return out;
    const state = await res.json();
    const entries = Object.entries(state.signals ?? {}).sort((a, b) => b[1] - a[1]);
    const titles = (state.savedTitles ?? []).slice(0, 20);
    if (entries.length) {
      const line = entries.map(([t, n]) => `${t}: ${n}`).join(", ");
      console.log(`reader signals: ${line} (+${titles.length} recent save titles)`);
      out.signalsText = `\nOBSERVED BEHAVIOR — what this reader actually saves.
By topic: ${line}.${titles.length ? `\nTheir 20 most recent saves (newest first):\n${titles.map((t) => `- ${t}`).join("\n")}` : ""}
Read the titles for the reader's taste WITHIN topics (e.g. saving Russian-literature pieces is not an appetite for publishing news). Give +1-2 on borderline items that match demonstrated taste; a never-saved vein gets no benefit of the doubt.\n`;
    }
    // First sentences of recently saved pieces = the style bar for the writer.
    out.exemplars = (state.saves ?? [])
      .slice(0, 5)
      .map((c) => c.sections?.find((s) => s.style === "prose")?.text?.split(/(?<=[.!?])\s/)[0])
      .filter((s) => s && s.length > 30)
      .slice(0, 3);
  } catch {
    /* offline or not yet synced — pipeline works without it */
  }
  return out;
}

// Anti-formula: openings from the last 3 editions, so the writer can't settle
// into a house tic.
function recentOpenings() {
  try {
    const files = readdirSync(DECKS)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${date}.json`)
      .sort()
      .slice(-3);
    const openings = [];
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(DECKS, f), "utf8"));
      for (const c of d.cards) {
        const first = c.sections?.find((s) => s.style === "prose")?.text?.split(/(?<=[.!?])\s/)[0];
        if (first && first.length > 30) openings.push(first.slice(0, 140));
      }
    }
    return openings.slice(-10);
  } catch {
    return [];
  }
}

const reader = await readerState();
const scoredAll = await scoreItems([...fresh, ...wcAsRaw], profile, reader.signalsText);
const minScore = profile.minScore ?? 5;
const scored = scoredAll.filter((s) => !s._card && s.score >= minScore);
const wildcards = scoredAll
  .filter((s) => s._card && s.score >= minScore)
  .sort((a, b) => b.score - a.score)
  .slice(0, profile.quotas.wildcard ?? 4)
  .map((s) => s._card);
console.log(`wildcards: ${wildcards.length}/${wcAsRaw.length} candidates survived triage`);

const winners = selectByQuota(scored, profile.quotas);
console.log(`${winners.length} winners selected for the writer pass (${scoredAll.filter((s) => !s._card).length - scored.length} below quality floor)`);

// Cross-day memory: titles + recall questions from the last 7 shipped decks,
// so the writer can weave today's pieces into what the reader already read.
function recentContext() {
  try {
    const files = readdirSync(DECKS)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${date}.json`)
      .sort()
      .slice(-7)
      .reverse();
    const out = [];
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(DECKS, f), "utf8"));
      for (const c of d.cards) {
        if (c.kind === "letter") continue;
        out.push(c.recall?.q ? `${c.title} — ${c.recall.q}` : c.title);
      }
    }
    return out.slice(0, 40);
  } catch {
    return [];
  }
}

// Teaser-feed winners get their article page fetched so the writer has the
// real thing to compress, not a standfirst.
async function enrich(items) {
  for (const w of items) {
    // Teaser feeds need the article page for text; anything without cover art
    // gets the page fetched for its og:image too — visual cards matter.
    if (w.link && (!w.fullInFeed || !w.image)) {
      try {
        const meta = await fetchArticleMeta(w.link);
        if (meta.text.length > w.text.length && !w.fullInFeed) w.text = meta.text;
        if (!w.image && meta.image) w.image = meta.image;
      } catch (e) {
        console.error(`article fetch failed for ${w.link}: ${e.message}`);
      }
    }
  }
}

await enrich(winners);

// A winner whose text stayed thin (bot-walled page, JS-only site, bare link
// aggregator) would force the writer into an empty card — drop it and
// backfill with the next-best scored item that has real text.
const MIN_TEXT = 1200;
let usable = winners.filter((w) => w.text.length >= MIN_TEXT);
const deficit = winners.length - usable.length;
if (deficit > 0) {
  const chosen = new Set(usable.map((w) => w.link ?? w.title));
  const bench = scored
    .filter((s) => !chosen.has(s.link ?? s.title))
    .sort((a, b) => b.score - a.score)
    .slice(0, deficit * 2);
  await enrich(bench);
  const backfill = bench.filter((b) => b.text.length >= MIN_TEXT).slice(0, deficit);
  console.log(`${deficit} thin winners dropped, ${backfill.length} backfilled`);
  usable = usable.concat(backfill);
}

// Book engine: serve today's installment from the current series, if any.
let installment = null;
const seriesPath = join(STATE, "book-series.json");
if (existsSync(seriesPath)) {
  const series = JSON.parse(readFileSync(seriesPath, "utf8"));
  if (series.lastDate === date && series.nextIndex > 0) {
    installment = series.installments[series.nextIndex - 1]; // same-day rebuild: same day
  } else if (series.nextIndex < series.installments.length) {
    installment = series.installments[series.nextIndex];
    series.nextIndex++;
    series.lastDate = date;
    writeFileSync(seriesPath, JSON.stringify(series, null, 1));
  } else {
    console.log("book engine: series finished — run `node pipeline/book-planner.mjs` for the next book");
  }
  if (installment) console.log(`book engine: ${installment.title}`);
}

const quotas = { ...profile.quotas };
if (installment) quotas.books = Math.max(0, (quotas.books ?? 0) - 1);

const drafted = await writeCards(usable, profile, recentContext(), {
  avoidOpenings: recentOpenings(),
  exemplars: reader.exemplars,
});
const written = await editCards(drafted, profile);
if (installment) written.unshift({ ...installment, score: 11 });
const cards = interleave(written, wildcards, quotas);

try {
  cards.unshift(await writeLetter(cards, profile, date));
} catch (e) {
  console.error("editor's letter failed (deck ships without it):", e.message);
}

if (cards.length < 8) {
  console.error(`Only ${cards.length} cards assembled — refusing to ship a thin deck.`);
  process.exit(1);
}

const deck = { date, generatedAt: new Date().toISOString(), cards };
writeFileSync(deckPath, JSON.stringify(deck, null, 1));

// mark everything that made the deck as seen
for (const c of cards) seen[hash((c.deepLink ?? c.title).toLowerCase())] = Date.now();
writeFileSync(SEEN_FILE, JSON.stringify(seen));

console.log(`✓ Deck written: ${deckPath} (${cards.length} cards)`);
for (const c of cards) console.log(`  [${c.topic}/${c.kind}] ${c.title}`);

if (push) {
  try {
    execFileSync("git", ["add", "public/decks", "pipeline/state"], { cwd: ROOT });
    execFileSync("git", ["commit", "-m", `deck: ${date}`], { cwd: ROOT });
    execFileSync("git", ["push"], { cwd: ROOT, stdio: "inherit" });
    console.log("✓ Pushed — GitHub Pages will redeploy with today's deck.");
  } catch (e) {
    console.error("Push failed (deck is still built locally):", e.message);
  }
}
