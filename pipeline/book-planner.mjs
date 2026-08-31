#!/usr/bin/env node
/* The book engine's planner: serializes one public-domain book into daily
   installment cards, written sequentially with rolling continuity so the
   series reads as one coherent guided journey. Run once per book:

     node pipeline/book-planner.mjs            # next book in books.json queue
     node pipeline/book-planner.mjs <book-id>  # a specific book

   Output: pipeline/state/book-series.json — build-deck serves one
   installment per day from it. */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaude, extractJson } from "./ai.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, "pipeline", "state");
const SERIES_PATH = join(STATE, "book-series.json");
const UA = { "User-Agent": "DailyDeck/0.1 (personal knowledge feed; +https://github.com/adityasingh-io/daily-deck)" };

const profile = JSON.parse(readFileSync(join(ROOT, "pipeline", "profile.json"), "utf8"));
const booksConfig = JSON.parse(readFileSync(join(ROOT, "pipeline", "books.json"), "utf8"));

const argId = process.argv[2];
const DONE_PATH = join(STATE, "books-done.json");
const current = existsSync(SERIES_PATH) ? JSON.parse(readFileSync(SERIES_PATH, "utf8")) : null;
const doneList = existsSync(DONE_PATH) ? JSON.parse(readFileSync(DONE_PATH, "utf8")) : [];

// Don't clobber a series that's still being served (explicit book id overrides).
if (current && current.nextIndex < current.installments.length && !argId) {
  console.log(`Series "${current.title}" still in progress (${current.nextIndex}/${current.installments.length}) — nothing to plan.`);
  process.exit(0);
}

// A finished series goes on the done list so the queue advances, never loops.
if (current && current.nextIndex >= current.installments.length && !doneList.includes(current.bookId)) {
  doneList.push(current.bookId);
  mkdirSync(STATE, { recursive: true });
  writeFileSync(DONE_PATH, JSON.stringify(doneList));
}

const book = argId
  ? booksConfig.queue.find((b) => b.id === argId)
  : booksConfig.queue.find((b) => !doneList.includes(b.id) && b.id !== current?.bookId);
if (!book) {
  console.log("Book queue exhausted — add the next book to pipeline/books.json.");
  process.exit(0);
}

console.log(`Planning "${book.title}" (${book.author}, ${book.translator} tr.) — ${book.installments} installments`);

// ---- full text from Project Gutenberg, boilerplate stripped ----
const rawRes = await fetch(`https://www.gutenberg.org/ebooks/${book.gutenbergId}.txt.utf-8`, { headers: UA, redirect: "follow" });
if (!rawRes.ok) throw new Error(`gutenberg fetch failed: ${rawRes.status}`);
let text = await rawRes.text();
const start = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
const end = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i);
if (start > -1 && end > start) text = text.slice(text.indexOf("\n", start), end);
text = text.trim();
const totalWords = text.split(/\s+/).length;
console.log(`Text: ${totalWords.toLocaleString()} words`);

// ---- even chunks on paragraph boundaries ----
const paras = text.split(/\r?\n\r?\n+/).filter((p) => p.trim());
const perChunk = totalWords / book.installments;
const chunks = [];
let buf = [];
let count = 0;
for (const p of paras) {
  buf.push(p.replace(/\r?\n/g, " ").trim());
  count += p.split(/\s+/).length;
  if (count >= perChunk && chunks.length < book.installments - 1) {
    chunks.push(buf.join("\n\n"));
    buf = [];
    count = 0;
  }
}
if (buf.length) chunks.push(buf.join("\n\n"));
console.log(`Chunked into ${chunks.length} installments (~${Math.round(perChunk)} words each)`);

// ---- LibriVox listen link ----
let listenLink;
try {
  const lv = await fetch(
    `https://librivox.org/api/feed/audiobooks/?title=${encodeURIComponent(book.title)}&format=json&limit=3`,
    { headers: UA }
  ).then((r) => r.json());
  listenLink = lv.books?.find((b) => b.url_librivox)?.url_librivox;
  console.log(`LibriVox: ${listenLink ?? "not found"}`);
} catch {
  console.log("LibriVox lookup failed — cards ship without listen link");
}

// ---- sequential writing with rolling continuity ----
const installments = [];
let storySoFar = "";
for (let n = 0; n < chunks.length; n++) {
  const prompt = `You are serializing "${book.title}" by ${book.author} (${book.translator} translation, public domain) for "Daily Deck", a private one-reader knowledge feed. One installment per day. Each installment is a 4-6 minute guided read that lets the reader genuinely EXPERIENCE this stretch of the book — its voice, its psychology, its best moments — not a summary about it.

THE READER: ${profile.reader}

${storySoFar ? `THE STORY SO FAR (they read this in earlier installments): ${storySoFar}` : "THIS IS DAY 1: open the series — drop the reader straight into the book's world and its narrator with zero throat-clearing about 'this classic novel'."}

TODAY: installment ${n + 1} of ${chunks.length}.

Write a JSON object:
- "title": "Day ${n + 1} · <hook>" where <hook> is max 40 chars and understandable at a glance.
- "body": the card cover, 2 sentences — where we are and why today's stretch matters.
- "sections":
  1. {"label": null, "style": "prose", "text": "..."} — guide the reader THROUGH this stretch: what happens or what is argued, in order, with the psychology laid bare. Quote short phrases freely (it's public domain). 400-700 words, cold open, paragraphs separated by blank lines. Assume they read yesterday's installment; never re-explain the premise.
  2. {"label": "From the book", "style": "note", "text": "..."} — ONE verbatim passage from today's text, 40-120 words, the best one. Transcribe EXACTLY, no alterations.
  3. {"label": "Worth carrying", "style": "pull", "text": "..."} — one line to carry into the day.
- "recall": {"q": "...", "a": "..."} — testing this installment's core, answerable after reading.
- "storySoFar": cumulative summary INCLUDING today, max 120 words — tomorrow's installment depends on it.

HARD RULES: everything from today's text only — no outside biography or interpretation history; the passage must appear verbatim in the text below; no spoilers beyond today's stretch.

Output ONLY the JSON object.

TODAY'S TEXT:
${chunks[n].slice(0, 30000)}`;

  let r;
  try {
    r = extractJson(await runClaude(prompt, profile.model), "{", "}");
  } catch (e) {
    console.error(`Installment ${n + 1} failed (${e.message}); retrying once…`);
    r = extractJson(await runClaude(prompt + "\n\nREMINDER: output ONLY the JSON object.", profile.model), "{", "}");
  }

  installments.push({
    id: `book-${book.id}-${n + 1}`,
    source: "book-engine",
    topic: "books",
    kind: "deepdive",
    title: String(r.title).slice(0, 90),
    body: String(r.body ?? "").slice(0, 600),
    sections: r.sections,
    recall: r.recall?.q ? { q: String(r.recall.q).slice(0, 300), a: String(r.recall.a).slice(0, 500) } : undefined,
    imageUrl: `https://www.gutenberg.org/cache/epub/${book.gutenbergId}/pg${book.gutenbergId}.cover.medium.jpg`,
    deepLink: `https://www.gutenberg.org/ebooks/${book.gutenbergId}`,
    listenLink,
    attribution: `${book.author} · ${book.translator} tr. · public domain`,
  });
  storySoFar = String(r.storySoFar ?? storySoFar).slice(0, 900);
  console.log(`✓ ${installments[n].title}`);
}

mkdirSync(STATE, { recursive: true });
writeFileSync(
  SERIES_PATH,
  JSON.stringify({ bookId: book.id, title: book.title, author: book.author, nextIndex: 0, lastDate: null, installments }, null, 1)
);
console.log(`✓ Series written: ${SERIES_PATH} (${installments.length} installments, starts with tomorrow's deck)`);
