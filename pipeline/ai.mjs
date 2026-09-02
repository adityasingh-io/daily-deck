import { spawn } from "node:child_process";

/* The AI layer runs on headless Claude Code (`claude -p`), billed to the
   user's Max subscription — no API key involved.

   The newsroom chain (every stage reads the charter):
   1. scoreItems  — triage: score everything against the charter
   2. chiefEditor — composes the day's lineup: picks, orders, and writes an
                    assignment brief for every piece
   3. writeCards  — one call per piece, guided by its brief and register
   4. editCards   — line editor: one ruthless revision round per piece
   5. writeLetter — the editor's letter that opens the deck */

export function runClaude(prompt, model) {
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

export function extractJson(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON in model output");
  return JSON.parse(text.slice(start, end + 1));
}

async function runBatches(items, batchSize, makePrompt, model, label) {
  const results = [];
  for (let off = 0; off < items.length; off += batchSize) {
    const batch = items.slice(off, off + batchSize);
    const prompt = makePrompt(batch);
    let parsed;
    try {
      parsed = extractJson(await runClaude(prompt, model), "[", "]");
    } catch (e) {
      console.error(`${label} batch at ${off} failed (${e.message}); retrying once…`);
      try {
        parsed = extractJson(await runClaude(prompt + "\n\nREMINDER: output ONLY the JSON array.", model), "[", "]");
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

function age(published) {
  if (!published) return "unknown";
  const h = (Date.now() - new Date(published).getTime()) / 3600_000;
  if (!Number.isFinite(h) || h < 0) return "unknown";
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ---------------------------- 1. triage ---------------------------- */

export async function scoreItems(rawItems, model, charter, signalsText = "", recentTitles = []) {
  const recentBlock = recentTitles.length
    ? `\nRECENTLY SERVED (last week's pieces) — an item that substantially re-covers one of these scores at most 3; the reader already got it:\n${recentTitles.slice(0, 40).map((t) => `- ${t}`).join("\n")}\n`
    : "";

  const makePrompt = (batch) => `You are the triage editor of "Daily Deck". The charter below is your constitution — its reader, priorities, and exclusions govern every score.

${charter}
${signalsText}${recentBlock}
THE SCALE — calibrate to it exactly:
- 0-2: charter-excluded genres, filler, churn, or substantially covered last week
- 3-4: fine but forgettable; the reader loses nothing by missing it
- 5-6: solid — teaches something real, worth a slot on an average day
- 7-8: would earn a full feature; the reader would save it
- 9-10: drop everything; the best thing they'd read this week
In a typical batch of 20, expect a few 7+, several 5-6, and MANY below 5. If most of your scores are high, you are not filtering.

WEIGH: does it teach something (a mechanism, a distinction, a finding — not just an occurrence)? Is it novel to THIS reader? Will it still matter in a month (reflective content) or is it genuinely fresh (news — check the age field)? Judge the substance the snippet IMPLIES, not the snippet's polish.

IN-BATCH DUPLICATES: if two items cover the same story or idea, give a real score only to the better one; the other scores at most 3.

Also assign:
- "topic": keep the item's topic unless it clearly belongs elsewhere (psych, books, philosophy, tech-ai, world, econ)
- "why": your reason, max 10 words

Output ONLY a JSON array: [{"i": <index>, "score": <0-10>, "topic": "...", "why": "..."}] — every input index exactly once.

RAW ITEMS:
${JSON.stringify(batch.map((it, i) => ({ i, topic: it.topic, source: it.attribution, age: age(it.published), title: it.title, snippet: it.text.slice(0, 700) })), null, 1)}`;

  const results = await runBatches(rawItems, 20, makePrompt, model, "score");
  for (const { raw, r } of results) {
    if (r.why) console.log(`  [${r.score}] ${String(raw.title).slice(0, 60)} — ${r.why}`);
  }
  return results
    .filter(({ r }) => Number(r.score) > 0)
    .map(({ raw, r }) => ({ ...raw, score: Number(r.score), topic: r.topic ?? raw.topic }));
}

/* ------------------------- 2. the chief editor ------------------------- */

export async function chiefEditor(pool, model, charter, { recentTitles = [], bookTitle = null } = {}) {
  const prompt = `You are the chief editor of "Daily Deck". Below is today's scored candidate pool. Compose today's edition: SELECT the pieces, ORDER them, and write an ASSIGNMENT BRIEF for each. The charter is your constitution — the mix numbers there are direction, not arithmetic; use judgment and explain it.

${charter}

${bookTitle ? `FIXED SLOT (placed by code near the top, not yours to select): today's book installment, "${bookTitle}". It counts toward the books lane.` : ""}
${recentTitles.length ? `RECENTLY SERVED (avoid topic-level repeats):\n${recentTitles.slice(0, 30).map((t) => `- ${t}`).join("\n")}` : ""}

For each selected piece:
- "i": the pool index (must exist in the pool)
- "register": "story" or "info" (per the charter's registers)
- "targetWords": your length call — a number (info: 80-180; story: 350-600, up to 800 only for the exceptional)
- "brief": one line of assignment direction for the writer — the angle, what to lead with, what to pull out. E.g. "info, lead with the 45% number, the story is one GPU" or "concept piece — anchor on the mechanism, not the study drama".

Then:
- "letterNote": one sentence for the letter writer — today's honest thread, if any, and the piece not to miss.
- "reasoning": 2-3 sentences on how you shaped today's edition (logged, not published).

ORDER the lineup for pacing (charter: long reflective pieces separated by quick info ones). Select per the charter's mix direction — aim near 24 pieces (the fixed book slot and the letter are added by code). Never fewer than 17, never more than 26. Quality floor: nothing below score 4 unless you state why in its brief.

Output ONLY: {"lineup": [{"i": ..., "register": "...", "targetWords": ..., "brief": "..."}], "letterNote": "...", "reasoning": "..."}

THE POOL:
${JSON.stringify(pool.map((p, i) => ({ i, topic: p.topic, score: p.score, source: p.attribution, age: age(p.published), title: p.title, why: p.why })), null, 1)}`;

  const r = extractJson(await runClaude(prompt, model), "{", "}");
  if (!Array.isArray(r.lineup)) throw new Error("no lineup");
  const seen = new Set();
  const lineup = r.lineup
    .filter((l) => pool[l.i] !== undefined && !seen.has(l.i) && (seen.add(l.i), true))
    .map((l) => ({
      ...pool[l.i],
      register: l.register === "info" ? "info" : "story",
      targetWords: Number(l.targetWords) || (l.register === "info" ? 140 : 450),
      brief: String(l.brief ?? "").slice(0, 300),
    }));
  if (lineup.length < 12) throw new Error(`lineup too small (${lineup.length})`);
  console.log(`chief editor: ${lineup.length} pieces. Reasoning: ${r.reasoning ?? "(none)"}`);
  return { lineup: lineup.slice(0, 26), letterNote: String(r.letterNote ?? "") };
}

/* --------------------------- 3. the writer --------------------------- */

const REGISTERS = `THE REGISTERS:

STORY (psychology, philosophy, books): the guided read. COLD OPEN with a scene, moment, or concrete detail — never "X argues that Y". Teach the whole argument in order: the mechanism, the best examples with their specifics, where the author hesitates. Sections available (use only what the material fills): main prose (label null, style "prose"), {"label": "The experiment", "style": "note"}, {"label": "See it in your life", "style": "list"}, {"label": "Steelman", "style": "note"}, {"label": "Key takeaways", "style": "list"}, {"label": "The caveat", "style": "note"} (MANDATORY for study-based pieces), {"label": "Worth carrying", "style": "pull"} (the closer — one line that lands).

INFO (AI industry, world, economics): the value IS the fact. Tight, data-forward prose — what happened and why it matters, no narrative dressing. Sections available: main prose (style "prose"), {"label": "The numbers", "style": "list"} (the 2-4 key figures — dates, amounts, percentages — as short list items), {"label": "Why it matters", "style": "note"}, {"label": "Watch next", "style": "note"}. A reader finishes in under a minute knowing the thing completely.`;

export async function writeCards(items, model, charter, opts = {}) {
  const antiFormula = opts.avoidOpenings?.length
    ? `\nRECENT OPENING MOVES from earlier editions — do NOT echo these shapes or rhythms:\n${opts.avoidOpenings.slice(0, 10).map((s) => `- "${s}"`).join("\n")}\n`
    : "";
  const goldStandard = opts.exemplars?.length
    ? `\nTHE BAR — openings of pieces this reader chose to SAVE. Match the quality that earned a save (not their subjects or moves):\n${opts.exemplars.map((e) => `- "${e}"`).join("\n")}\n`
    : "";
  const contextBlock = opts.recentContext?.length
    ? `\nRECENTLY SERVED PIECES (draw AT MOST ONE cross-reference, only when genuinely illuminating):\n${opts.recentContext.slice(0, 30).map((t) => `- ${t}`).join("\n")}\n`
    : "";

  const makePrompt = (batch) => {
    const it = batch[0];
    return `You are the writer of "Daily Deck". The charter below governs everything — especially EASY ENGLISH: short sentences, common words, jargon explained the moment it appears. The reader does not open source articles; your piece IS their reading.

${charter}
${contextBlock}${antiFormula}${goldStandard}
${REGISTERS}

YOUR ASSIGNMENT from the chief editor:
- register: ${it.register}
- target length: ~${it.targetWords} words for the main prose (write the SHORTEST version that delivers everything; never pad toward the target)
- brief: ${it.brief || "(none — use your judgment within the register)"}

Write a JSON object:
- "title": max 60 chars, understood at a glance — a reader who sees only the title knows what the piece is about. Never cryptic.
- "body": the card cover, 2-3 sentences — the single most interesting claim, stated plainly.
- "sections": per your register above. Paragraphs of 2-4 sentences separated by blank lines.
- "evidence": study-based pieces ONLY, ONLY from facts stated in the text: e.g. "single study · n=94 · self-report". Otherwise null. NEVER estimate.
- "recall": {"q": "...", "a": "..."} — tests the piece's CORE insight, answerable after one attentive read; the answer re-teaches the point in 1-3 sentences.

HARD RULES: nothing not in the provided text · quote at most two short phrases · no emoji, no markdown headers in prose · end main prose ON substance; a "Worth carrying" pull line (story register) is the true closer.

Output ONLY a JSON array with one object: [{"i": 0, "title": "...", "body": "...", "evidence": "..."|null, "sections": [...], "recall": {...}}]

THE ITEM (topic: ${it.topic}, source: ${it.attribution}):
${it.text}`;
  };

  const results = await runBatches(items, 1, makePrompt, model, "write");
  return results
    .map(({ raw, r }) => {
      const sections = Array.isArray(r.sections)
        ? r.sections.filter(
            (s) => s && ["prose", "note", "list", "pull"].includes(s.style) && (typeof s.text === "string" || Array.isArray(s.items))
          )
        : [];
      if (!r.title || !sections.some((s) => s.style === "prose")) return null;
      return {
        id: `${raw.source}-${hash(raw.link ?? raw.title)}`,
        source: raw.source,
        topic: raw.topic,
        kind: raw.register === "info" ? "news" : "essay",
        title: String(r.title).slice(0, 90),
        body: String(r.body ?? "").slice(0, 600),
        evidence: r.evidence ? String(r.evidence).slice(0, 120) : undefined,
        sections,
        recall: r.recall?.q && r.recall?.a ? { q: String(r.recall.q).slice(0, 300), a: String(r.recall.a).slice(0, 500) } : undefined,
        imageUrl: raw.image,
        deepLink: raw.link,
        attribution: raw.attribution,
        publishedAt: raw.published,
        register: raw.register,
        brief: raw.brief,
      };
    })
    .filter(Boolean);
}

/* ------------------------- 4. the line editor ------------------------- */

export async function editCards(cards, model, charter) {
  const makePrompt = (batch) => {
    const c = batch[0];
    return `You are the line editor of "Daily Deck". Below is a drafted piece and its assignment. Make it ship-ready. The charter governs — above all EASY ENGLISH: if a sentence would make a non-native reader pause, rewrite it simpler.

${charter}

THE ASSIGNMENT WAS: register ${c.register ?? "story"}${c.brief ? `, brief: "${c.brief}"` : ""}. Hold the piece to it.

Edit ruthlessly, then output the REVISED piece:
- Kill throat-clearing, hedged mush, and any sentence that repeats another.
- Replace every long word that has a short equivalent; break every sentence that runs long.
- Cut toward the SHORTEST version that delivers everything — prefer cutting over padding, always.
- Takeaways/numbers must each say something the title doesn't.
- Verify the recall question tests the CORE and is answerable from the piece.
- Keep ALL factual specifics (names, numbers, examples). NEVER introduce a fact not in the draft.
- If the draft is already excellent, change little.

Output ONLY a JSON array with one object: [{"i": 0, "title": "...", "body": "...", "sections": [...same shapes...], "recall": {"q": "...", "a": "..."}}]

DRAFT:
${JSON.stringify({ register: c.register, topic: c.topic, title: c.title, body: c.body, sections: c.sections, recall: c.recall }, null, 1)}`;
  };

  const results = await runBatches(cards, 1, makePrompt, model, "edit");
  const edited = new Map();
  for (const { raw, r } of results) {
    const sections = Array.isArray(r.sections)
      ? r.sections.filter(
          (s) => s && ["prose", "note", "list", "pull"].includes(s.style) && (typeof s.text === "string" || Array.isArray(s.items))
        )
      : [];
    if (!r.title || !sections.some((s) => s.style === "prose")) continue;
    edited.set(raw.id, {
      ...raw,
      title: String(r.title).slice(0, 90),
      body: String(r.body ?? raw.body).slice(0, 600),
      sections,
      recall: r.recall?.q && r.recall?.a ? { q: String(r.recall.q).slice(0, 300), a: String(r.recall.a).slice(0, 500) } : raw.recall,
    });
  }
  return cards.map((c) => edited.get(c.id) ?? c);
}

/* ------------------------ 5. the editor's letter ------------------------ */

export async function writeLetter(cards, model, charter, dateIso, letterNote = "") {
  const prompt = `You are the editor of "Daily Deck". Today is ${dateIso}. Write the editor's letter per the charter (2-4 sentences, easy English, warm, specific, zero hype, no "welcome to"). Address the reader as "you".
${letterNote ? `\nThe chief editor's note on today's edition: ${letterNote}` : ""}

${charter}

Also give it a short title (max 35 chars) naming today's thread or dateline.

Output ONLY: {"title": "...", "text": "..."}

TODAY'S PIECES:
${JSON.stringify(cards.map((c) => ({ topic: c.topic, title: c.title, cover: c.body?.slice(0, 140) })), null, 1)}`;

  const r = extractJson(await runClaude(prompt, model), "{", "}");
  if (!r.title || !r.text) throw new Error("letter malformed");
  return {
    id: `letter-${dateIso}`,
    source: "editor",
    topic: "wildcard",
    kind: "letter",
    title: String(r.title).slice(0, 60),
    body: String(r.text).slice(0, 700),
    deepLink: "",
    attribution: "Your editor",
  };
}

export function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
