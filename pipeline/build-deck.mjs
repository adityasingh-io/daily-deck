#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRaw, fetchArticleMeta } from "./sources.mjs";
import { scoreItems, chiefEditor, writeCards, editCards, writeLetter, hash } from "./ai.mjs";
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
const charter = readFileSync(join(ROOT, "pipeline", "charter.md"), "utf8");
const formats = readFileSync(join(ROOT, "pipeline", "formats.md"), "utf8");

// Format entries by name, so each writer call gets only its assigned format.
const formatMap = new Map();
for (const section of formats.split(/^## /m).slice(1)) {
  const name = section.split("\n")[0].replace(/^\d+\.\s*/, "").replace(/\s*\[.*$/, "").trim();
  if (name && !name.startsWith("Pairing")) formatMap.set(name.toLowerCase(), "## " + section.trim());
}
const model = profile.model;
const seen = existsSync(SEEN_FILE) ? JSON.parse(readFileSync(SEEN_FILE, "utf8")) : {};

// prune seen entries older than 14 days
const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
for (const [k, v] of Object.entries(seen)) if (v < cutoff) delete seen[k];

console.log(`Building deck for ${date}…`);

const raw = await collectRaw();
const fresh = raw.filter((it) => !seen[hash((it.link ?? it.title).toLowerCase())]);
console.log(`Fetched ${raw.length} raw items, ${fresh.length} unseen → triage (model: ${model})`);

/* ---- reader state: synced save behavior → signals + style exemplars ---- */
async function readerState() {
  const out = { signalsText: "", exemplars: [] };
  try {
    const env = JSON.parse(readFileSync(join(ROOT, "pipeline", ".env.json"), "utf8"));
    const res = await fetch(env.url, { headers: { Authorization: `Bearer ${env.token}` } });
    if (!res.ok) return out;
    const state = await res.json();
    const entries = Object.entries(state.signals ?? {}).sort((a, b) => b[1] - a[1]);
    const titles = (state.savedTitles ?? []).slice(0, 20);
    const loved = (state.lovedTitles ?? []).slice(0, 20);
    if (entries.length) {
      const line = entries.map(([t, n]) => `${t}: ${n}`).join(", ");
      console.log(`reader signals: ${line} (${titles.length} saves, ${loved.length} loves)`);
      out.signalsText = `\nOBSERVED BEHAVIOR — live, decaying taste signals (these update; the charter's territories do not).
By topic (saves + one-tap loves): ${line}.${titles.length ? `\nRecent saves (kept for re-reading):\n${titles.map((t) => `- ${t}`).join("\n")}` : ""}${loved.length ? `\nRecent loves (one-tap "this delighted me"):\n${loved.map((t) => `- ${t}`).join("\n")}` : ""}
Read titles for taste WITHIN topics. A +1-2 nudge on borderline items matching demonstrated taste — but remember the charter: the goal is EXPANSION, so these signals season selection, they never narrow it.\n`;
    }
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

/* ---- book engine: today's installment (fixed slot, inserted by code) ---- */
let installment = null;
const seriesPath = join(STATE, "book-series.json");
if (existsSync(seriesPath)) {
  const series = JSON.parse(readFileSync(seriesPath, "utf8"));
  if (series.lastDate === date && series.nextIndex > 0) {
    installment = series.installments[series.nextIndex - 1];
  } else if (series.nextIndex < series.installments.length) {
    installment = series.installments[series.nextIndex];
    series.nextIndex++;
    series.lastDate = date;
    writeFileSync(seriesPath, JSON.stringify(series, null, 1));
  } else {
    console.log("book engine: series finished — the nightly autopilot will plan the next book");
  }
  if (installment) console.log(`book engine: ${installment.title}`);
}

/* ------------------------------ the chain ------------------------------ */

const reader = await readerState();
const recent = recentContext();
const scoredAll = await scoreItems(fresh, model, charter, reader.signalsText, recent);
const pool = scoredAll.filter((s) => s.score >= (profile.minScore ?? 3));
console.log(`${pool.length} items in the editor's pool (${scoredAll.length - pool.length} below hard floor)`);

let lineup;
let letterNote = "";
try {
  const composed = await chiefEditor(pool, model, charter, {
    recentTitles: recent,
    bookTitle: installment?.title ?? null,
    formats,
  });
  lineup = composed.lineup;
  letterNote = composed.letterNote;
  for (const w of lineup) {
    if (w.format) {
      const key = [...formatMap.keys()].find((k) => k === w.format.toLowerCase() || w.format.toLowerCase().includes(k) || k.includes(w.format.toLowerCase()));
      w.formatEntry = key ? formatMap.get(key) : null;
    }
  }
  const assigned = lineup.filter((w) => w.formatEntry).length;
  console.log(`formats assigned: ${assigned}/${lineup.length}`);
} catch (e) {
  console.error(`chief editor failed (${e.message}) — falling back to quota algorithm`);
  const winners = selectByQuota(pool.filter((s) => s.score >= 5), profile.fallbackQuotas);
  lineup = interleave(winners, profile.fallbackQuotas).map((w) => ({
    ...w,
    register: ["psych", "books", "philosophy"].includes(w.topic) ? "story" : "info",
    targetWords: ["psych", "books", "philosophy"].includes(w.topic) ? 450 : 140,
    brief: "",
  }));
}

// Enrich: teaser feeds get their article page; anything imageless gets og:image.
for (const w of lineup) {
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

const MIN_TEXT = 1200;
const usable = lineup.filter((w) => w.source === "fred-india" || w.text.length >= MIN_TEXT);
if (usable.length < lineup.length) console.log(`${lineup.length - usable.length} thin/paywalled pieces dropped`);

const writeOpts = { avoidOpenings: recentOpenings(), exemplars: reader.exemplars, recentContext: recent };
let drafted = await writeCards(usable, model, charter, writeOpts);

// Failed-piece recovery: anything from the lineup that didn't survive the
// writing pass gets one more attempt instead of silently vanishing.
const draftedIds = new Set(drafted.map((d) => d.id));
const missing = usable.filter((u) => !draftedIds.has(`${u.source}-${hash(u.link ?? u.title)}`));
if (missing.length) {
  console.log(`retrying ${missing.length} failed piece(s)…`);
  drafted = drafted.concat(await writeCards(missing, model, charter, writeOpts));
}

const written = await editCards(drafted, model, charter);

// Final cards in the editor's order, internal fields stripped.
const cards = written.map(({ register, brief, score, fullInFeed, why, format, formatEntry, targetWords, ...card }) => card);

if (installment) cards.splice(Math.min(2, cards.length), 0, { ...installment });

try {
  cards.unshift(await writeLetter(cards, model, charter, date, letterNote));
} catch (e) {
  console.error("editor's letter failed (deck ships without it):", e.message);
}

if (cards.length < 10) {
  console.error(`Only ${cards.length} cards assembled — refusing to ship a thin deck.`);
  process.exit(1);
}

// Honest health note when the build ran degraded — the app shows it.
const deck = { date, generatedAt: new Date().toISOString(), cards };
if (cards.length < 20) {
  deck.note = `Lighter edition today — ${cards.length} cards; some pieces didn't survive the build.`;
  console.log(`health note attached: ${deck.note}`);
}
writeFileSync(deckPath, JSON.stringify(deck, null, 1));

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
