#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectRaw, fetchWildcards } from "./sources.mjs";
import { formatItems, hash } from "./ai.mjs";
import { mixDeck } from "./mixer.mjs";

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
console.log(`${fresh.length} unseen items going to the AI (model: ${profile.model})`);

const scored = await formatItems(fresh, profile);
const cards = mixDeck(scored, wildcards, profile.quotas);

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
