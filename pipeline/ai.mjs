import { spawn } from "node:child_process";

/* The AI layer runs on headless Claude Code (`claude -p`), so it bills to the
   user's Max subscription — no API key involved. */

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

function buildPrompt(profile, items) {
  return `You are the editorial engine of "Daily Deck", a private one-reader knowledge feed. Your rewriting is the product: the reader chose this feed because your cards are easier and more fun to read than the sources.

THE READER: ${profile.reader}

TONE: ${profile.tone}

EXCLUDE ruthlessly (score 0): ${profile.exclusions.join("; ")}.

For each raw item below, return an object:
- "i": the item's index (number, copy it exactly)
- "score": 0-10 how much THIS reader wants this card today (10 = drop everything and read)
- "kind": one of "concept" (an idea explained), "news" (something happened), "craft" (an engineering lesson), "essay" (pointer to a piece worth reading)
- "topic": keep the item's topic unless it clearly belongs elsewhere; allowed: psych, books, philosophy, tech-craft, tech-ai, world, econ
- "title": your rewritten hook, max 60 chars. Curiosity, not clickbait — the card body must pay off whatever the title promises.
- "body": 2-4 sentences, max 70 words. Formats: concept = name the idea, one concrete everyday example, one-line "so what". news = what happened + why it matters, no outrage. craft = the lesson + when you'd reach for it. essay = the piece's core claim + one teaser question.

HARD RULES:
1. Never state a fact not present in the item's text. If the text is too thin to write an honest body, set score 0.
2. Single psychology studies get hedged language ("one new study suggests…"), never "science proves".
3. No emoji, no hashtags, no "Read more". Write like a sharp friend, not a content farm.
4. Output ONLY a JSON array of these objects, nothing else. Every input index must appear exactly once.

RAW ITEMS:
${JSON.stringify(items.map((it, i) => ({ i, topic: it.topic, kindHint: it.kindHint, source: it.attribution, title: it.title, text: it.text })), null, 1)}`;
}

export async function formatItems(rawItems, profile) {
  const out = [];
  for (let off = 0; off < rawItems.length; off += profile.batchSize) {
    const batch = rawItems.slice(off, off + profile.batchSize);
    const prompt = buildPrompt(profile, batch);
    let parsed;
    try {
      parsed = extractJsonArray(await runClaude(prompt, profile.model));
    } catch (e) {
      console.error(`AI batch at ${off} failed (${e.message}); retrying once…`);
      try {
        parsed = extractJsonArray(await runClaude(prompt + "\n\nREMINDER: output ONLY the JSON array.", profile.model));
      } catch (e2) {
        console.error(`AI batch at ${off} failed twice, dropping ${batch.length} items`);
        continue;
      }
    }
    for (const r of parsed) {
      const raw = batch[r.i];
      if (!raw || !r.score || r.score <= 0) continue;
      out.push({
        id: `${raw.source}-${hash(raw.link ?? raw.title)}`,
        source: raw.source,
        topic: r.topic ?? raw.topic,
        kind: r.kind ?? "concept",
        title: String(r.title ?? raw.title).slice(0, 90),
        body: String(r.body ?? "").slice(0, 600),
        imageUrl: raw.image,
        deepLink: raw.link,
        attribution: raw.attribution,
        publishedAt: raw.published,
        score: Number(r.score) || 0,
      });
    }
    console.log(`AI formatted batch ${off / profile.batchSize + 1}: ${parsed.length} in, ${out.length} total kept`);
  }
  return out;
}

export function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
