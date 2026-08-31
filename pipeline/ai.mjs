import { spawn } from "node:child_process";

/* The AI layer runs on headless Claude Code (`claude -p`), so it bills to the
   user's Max subscription — no API key involved.

   Two passes:
   1. scoreItems  — cheap triage over everything (snippets only)
   2. writeCards  — the product: full-text distillation of the winners,
      written so the reader never NEEDS the source article. */

function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", model], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude timed out after 15 min"));
    }, 15 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON array in model output");
  return JSON.parse(text.slice(start, end + 1));
}

async function runBatches(items, batchSize, makePrompt, model, label) {
  const results = [];
  for (let off = 0; off < items.length; off += batchSize) {
    const batch = items.slice(off, off + batchSize);
    const prompt = makePrompt(batch);
    let parsed;
    try {
      parsed = extractJsonArray(await runClaude(prompt, model));
    } catch (e) {
      console.error(`${label} batch at ${off} failed (${e.message}); retrying once…`);
      try {
        parsed = extractJsonArray(await runClaude(prompt + "\n\nREMINDER: output ONLY the JSON array.", model));
      } catch {
        console.error(`${label} batch at ${off} failed twice, dropping ${batch.length} items`);
        continue;
      }
    }
    for (const r of parsed) {
      if (batch[r.i] !== undefined) results.push({ raw: batch[r.i], r });
    }
    console.log(`${label}: batch ${Math.floor(off / batchSize) + 1} done (${results.length} total)`);
  }
  return results;
}

/* ---------------------------- pass 1: triage ---------------------------- */

export async function scoreItems(rawItems, profile) {
  const makePrompt = (batch) => `You are the triage editor of "Daily Deck", a private one-reader knowledge feed.

THE READER: ${profile.reader}

EXCLUDE ruthlessly (score 0): ${profile.exclusions.join("; ")}.

Score each raw item 0-10 for how much THIS reader wants it today (10 = drop everything). Also assign:
- "kind": "concept" | "news" | "craft" | "essay"
- "topic": keep the item's topic unless it clearly belongs elsewhere (allowed: psych, books, philosophy, tech-craft, tech-ai, world, econ)

Output ONLY a JSON array: [{"i": <index>, "score": <0-10>, "kind": "...", "topic": "..."}] — every input index exactly once.

RAW ITEMS:
${JSON.stringify(batch.map((it, i) => ({ i, topic: it.topic, kindHint: it.kindHint, source: it.attribution, title: it.title, snippet: it.text.slice(0, 700) })), null, 1)}`;

  const results = await runBatches(rawItems, 20, makePrompt, profile.model, "score");
  return results
    .filter(({ r }) => Number(r.score) > 0)
    .map(({ raw, r }) => ({ ...raw, score: Number(r.score), kind: r.kind ?? raw.kindHint, topic: r.topic ?? raw.topic }));
}

/* --------------------------- pass 2: the writer --------------------------- */

export async function writeCards(items, profile) {
  const makePrompt = (batch) => `You are the writer of "Daily Deck", a private one-reader knowledge feed. THIS IS THE ENTIRE PRODUCT: the reader does NOT open source articles. Your compression IS their reading. They should be able to spend an hour in this app and come away genuinely fed — informed, moved, entertained — without ever leaving.

THE READER: ${profile.reader}

TONE: ${profile.tone}

For each item, using ONLY its provided text, write:
- "title": the hook, max 60 chars. Curiosity that the piece pays off — never clickbait it can't cash.
- "body": the cover paragraph, 2-3 sentences. The single most interesting claim, stated plainly. This is what they see on the card before deciding to read.
- "full": the piece itself — 150-350 words, 3-6 short paragraphs separated by blank lines. This must REPLACE the source article for this reader:
  · Deliver the actual substance: the argument, the mechanism, the best concrete examples, the specific numbers and names. After reading it, they KNOW the thing.
  · Keep what makes it delicious — the counterintuitive turn, the vivid detail, the one line worth repeating at dinner.
  · Cut everything an editor would: throat-clearing, credentials, "in this article", recaps.
  · End with a line that lands — a sharpened takeaway or a question worth carrying into the day. Never a summary sentence.
  · Short paragraphs. Verbs over adjectives. Write like a brilliant friend retelling the best thing they read this week — not like a summary.

HARD RULES:
1. Nothing that is not in the provided text. If the text is too thin for an honest "full", write the best 100 words it supports — never pad, never invent.
2. Single psychology studies stay hedged ("one new study suggests…"), and sample caveats survive compression.
3. Your own words throughout — quote at most one short striking phrase per piece, in quotation marks.
4. No emoji, no headers, no bullet lists, no "Read more".

Output ONLY a JSON array: [{"i": <index>, "title": "...", "body": "...", "full": "..."}] — every input index exactly once.

ITEMS:
${JSON.stringify(batch.map((it, i) => ({ i, topic: it.topic, kind: it.kind, source: it.attribution, title: it.title, text: it.text })), null, 1)}`;

  const results = await runBatches(items, 5, makePrompt, profile.model, "write");
  return results
    .filter(({ r }) => r.title && r.full)
    .map(({ raw, r }) => ({
      id: `${raw.source}-${hash(raw.link ?? raw.title)}`,
      source: raw.source,
      topic: raw.topic,
      kind: raw.kind,
      title: String(r.title).slice(0, 90),
      body: String(r.body ?? "").slice(0, 600),
      full: String(r.full).slice(0, 3000),
      imageUrl: raw.image,
      deepLink: raw.link,
      attribution: raw.attribution,
      publishedAt: raw.published,
      score: raw.score,
    }));
}

export function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
