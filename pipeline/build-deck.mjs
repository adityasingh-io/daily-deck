#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRaw, fetchWildcards, fetchArticleText } from "./sources.mjs";
import { scoreItems, writeCards, hash } from "./ai.mjs";
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

const [raw, wildcards] = await Promise.all([collectRaw(), fetchWildcards(date)]);
console.log(`Fetched ${raw.length} raw items + ${wildcards.length} wildcard cards`);

const fresh = raw.filter((it) => !seen[hash((it.link ?? it.title).toLowerCase())]);
console.log(`${fresh.length} unseen items going to triage (model: ${profile.model})`);

const scored = await scoreItems(fresh, profile);
const winners = selectByQuota(scored, profile.quotas);
console.log(`${winners.length} winners selected for the writer pass`);

// Teaser-feed winners get their article page fetched so the writer has the
// real thing to compress, not a standfirst.
async function enrich(items) {
  for (const w of items) {
    if (!w.fullInFeed && w.link) {
      try {
        const full = await fetchArticleText(w.link);
        if (full.length > w.text.length) w.text = full;
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
const MIN_TEXT = 400;
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

const written = await writeCards(usable, profile);
const cards = interleave(written, wildcards, profile.quotas);

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
