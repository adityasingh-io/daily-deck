import { spawn } from "node:child_process";

/* The AI layer runs on headless Claude Code (`claude -p`), so it bills to the
   user's Max subscription — no API key involved.

   Three jobs:
   1. scoreItems  — cheap triage over everything (snippets only)
   2. writeCards  — the product: blueprint-structured pieces that replace
      their source articles entirely
   3. writeLetter — the editor's letter that opens the deck */

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

/* ---------------------------- pass 1: triage ---------------------------- */

export async function scoreItems(rawItems, profile, signalsText = "") {
  const makePrompt = (batch) => `You are the triage editor of "Daily Deck", a private one-reader knowledge feed.

THE READER: ${profile.reader}
${signalsText}

EXCLUDE ruthlessly (score 0): ${profile.exclusions.join("; ")}.

Score each raw item 0-10 for how much THIS reader wants it today (10 = drop everything). Be tough: a 7+ means it would earn a full written feature. Also assign:
- "kind": "concept" | "news" | "craft" | "essay"
- "topic": keep the item's topic unless it clearly belongs elsewhere (allowed: psych, books, philosophy, tech-craft, tech-ai, world, econ)

Items whose topic is "wildcard" are serendipity candidates (a striking image, an astonishing fact, a beautiful artwork): score them for genuine delight and wonder rather than topical fit — but pop-culture trivia, celebrity/album/sports pages, and anniversary filler score 2 or less. Keep their topic "wildcard" and their kind as given.

Output ONLY a JSON array: [{"i": <index>, "score": <0-10>, "kind": "...", "topic": "..."}] — every input index exactly once.

RAW ITEMS:
${JSON.stringify(batch.map((it, i) => ({ i, topic: it.topic, kindHint: it.kindHint, source: it.attribution, title: it.title, snippet: it.text.slice(0, 700) })), null, 1)}`;

  const results = await runBatches(rawItems, 20, makePrompt, profile.model, "score");
  return results
    .filter(({ r }) => Number(r.score) > 0)
    .map(({ raw, r }) => ({ ...raw, score: Number(r.score), kind: r.kind ?? raw.kindHint, topic: r.topic ?? raw.topic }));
}

/* --------------------------- pass 2: the writer --------------------------- */

const BLUEPRINTS = `THE BLUEPRINTS — apply the one matching each item's "kind". Sections are a menu: include one ONLY if the material genuinely fills it; an empty-calorie section is worse than none. Length is earned by the material — a rich 2,000-word essay deserves a 600-900 word retelling; a thin study write-up deserves 250 honest words. Cut filler, never substance. The test for every piece: could the reader re-explain it to a friend tomorrow, with the examples?

ESSAY — sections in order:
1. Main prose (label null, style "prose"): COLD OPEN with a scene, moment, or concrete detail — never "X argues that Y". Then teach the WHOLE essay: every step of the argument in order, the mechanism, ALL the good examples with their specifics (actual words, names, numbers, scenes), where the author hesitates. Paragraphs of 2-4 sentences separated by blank lines.
2. Steelman (label "Steelman", style "note"): the best counterargument, stated fairly, 2-3 sentences. Only if a real one exists.
3. Key takeaways (label "Key takeaways", style "list"): 3-4 bullets you could quote tomorrow, each specific, none restating the title.
4. Worth carrying (label "Worth carrying", style "pull"): ONE line — a sharpened takeaway or question. Never a summary.

CONCEPT — sections in order:
1. Main prose (style "prose"): cold open, then the idea named in one crisp line, then how it works — mechanism plus the best example with its specifics.
2. The experiment (label "The experiment", style "note"): what the study actually did — who, how many, what was measured. Only when the source says.
3. See it in your life (label "See it in your life", style "list"): 2-3 concrete places the reader will notice this today.
4. The caveat (label "The caveat", style "note"): sample size, single-study, boundaries. MANDATORY for study-based pieces.
5. Worth carrying (label "Worth carrying", style "pull"): one line.

CRAFT — sections in order:
1. Main prose (style "prose"): the problem — when you'd actually hit this — then the lesson with real specifics: the commands, the pattern, the numbers.
2. Do this (label "Do this", style "list"): 2-4 actionable checklist items for the reader's own codebase.
3. When not to (label "When not to", style "note"): the boundary, only if the source draws one.
4. Worth carrying (label "Worth carrying", style "pull"): one line.

NEWS — sections in order:
1. Main prose (style "prose"): what happened, plainly, then why it matters — the mechanism behind the headline. Naturally short; no outrage framing.
2. Watch next (label "Watch next", style "note"): what would confirm or flip the story.`;

export async function writeCards(items, profile, recentContext = [], opts = {}) {
  const contextBlock = recentContext.length
    ? `\nRECENTLY SERVED PIECES (across the batch, draw AT MOST ONE cross-reference per piece and only when genuinely illuminating — a forced connection is noise):\n${recentContext.slice(0, 40).map((t) => `- ${t}`).join("\n")}\n`
    : "";

  const antiFormula = opts.avoidOpenings?.length
    ? `\nRECENT OPENING MOVES from earlier editions — do NOT echo these shapes or rhythms; find a genuinely different way in:\n${opts.avoidOpenings.slice(0, 10).map((s) => `- "${s}"`).join("\n")}\n`
    : "";

  const goldStandard = opts.exemplars?.length
    ? `\nTHE BAR — openings of pieces this reader chose to SAVE. Match the quality that earned a save (do not imitate their subjects or copy their moves):\n${opts.exemplars.map((e) => `- "${e}"`).join("\n")}\n`
    : "";

  const makePrompt = (batch) => `You are the writer of "Daily Deck", a private one-reader knowledge feed. THIS IS THE ENTIRE PRODUCT: the reader does NOT open source articles. Your rewrite IS their reading — a long essay becomes a piece they can finish in a few minutes WITHOUT losing what made it worth reading. They read many pieces a day and want to come away having genuinely LEARNED things.

THE READER: ${profile.reader}

TONE: ${profile.tone}
${contextBlock}${antiFormula}${goldStandard}
${BLUEPRINTS}

ALSO produce for each item:
- "title": max 60 chars. THE TITLE MUST BE UNDERSTOOD AT A GLANCE — a reader who sees only the title knows what the piece is about. State the actual subject or claim plainly; wit is welcome ONLY when the meaning survives without reading the piece. Never cryptic fragments, never riddles, never metaphors that only make sense afterward. Test: would a stranger correctly guess the piece's subject from the title alone?
- "body": the card cover, 2-3 sentences — the single most interesting claim, stated plainly.
- "evidence": for study-based pieces ONLY, and ONLY from facts stated in the text: a short marker like "single study · n=94 · self-report". If the source doesn't state method details, null. NEVER estimate.
- "recall": {"q": "...", "a": "..."} — shown at the END of the piece as a "test yourself" moment, and stored for future spaced review. The question must test the piece's CENTRAL insight (not a trivia detail), be answerable by anyone who just read attentively, and be worth answering — the kind of question that makes the idea stick. The answer is 1-3 sentences, complete enough to re-teach the point.

HARD RULES:
1. Nothing that is not in the provided text. Never pad, never invent.
2. Single studies stay hedged ("one new study suggests…"), and sample caveats survive compression.
3. Your own words — at most two short quoted phrases per piece, in quotation marks.
4. No emoji, no markdown headers inside prose. Vary your openings — if one piece opens on a scene, the next opens differently.
5. End main prose ON substance; the "Worth carrying" line is the true closer.

Output ONLY a JSON array, one object per item:
[{"i": <index>, "title": "...", "body": "...", "evidence": "..."|null, "sections": [{"label": null|"...", "style": "prose"|"note"|"list"|"pull", "text": "..."} | {"label": "...", "style": "list", "items": ["..."]}], "recall": {"q": "...", "a": "..."}}]

ITEMS:
${JSON.stringify(batch.map((it, i) => ({ i, kind: it.kind, topic: it.topic, source: it.attribution, title: it.title, text: it.text })), null, 1)}`;

  const results = await runBatches(items, 1, makePrompt, profile.model, "write");
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
        kind: raw.kind,
        title: String(r.title).slice(0, 90),
        body: String(r.body ?? "").slice(0, 600),
        evidence: r.evidence ? String(r.evidence).slice(0, 120) : undefined,
        sections,
        recall: r.recall?.q && r.recall?.a ? { q: String(r.recall.q).slice(0, 300), a: String(r.recall.a).slice(0, 500) } : undefined,
        imageUrl: raw.image,
        deepLink: raw.link,
        attribution: raw.attribution,
        publishedAt: raw.published,
        score: raw.score,
      };
    })
    .filter(Boolean);
}

/* ------------------------ pass 3: the editor ------------------------ */

/** Every drafted piece gets one ruthless edit round — draft → critique →
    revise is the single biggest quality lever in AI writing. */
export async function editCards(cards, profile) {
  const makePrompt = (batch) => {
    const c = batch[0];
    return `You are the line editor of "Daily Deck", a private one-reader knowledge feed. Below is a drafted piece. Make it genuinely excellent for this reader — most drafts are good; yours ship great.

THE READER: ${profile.reader}

Edit ruthlessly, then output the REVISED piece:
- Kill throat-clearing, hedged mush, and any sentence that repeats another (especially body-vs-prose and takeaways-vs-title redundancy).
- The opening must earn attention in its first line; if it doesn't, rewrite it.
- Takeaways must each say something the title doesn't; cut any that don't.
- Sharpen the "Worth carrying" line until it actually lands.
- Verify the recall question tests the piece's CORE and is answerable from the piece; fix if not.
- Keep ALL factual specifics (names, numbers, examples) — cut connective tissue, never substance. Prefer cutting over padding.
- NEVER introduce a fact, quote, or claim not already in the draft.
- If the draft is already excellent, change little — do not churn for the sake of it.

Output ONLY a JSON array with one object: [{"i": 0, "title": "...", "body": "...", "sections": [...same shapes...], "recall": {"q": "...", "a": "..."}}]

DRAFT:
${JSON.stringify({ kind: c.kind, topic: c.topic, title: c.title, body: c.body, sections: c.sections, recall: c.recall }, null, 1)}`;
  };

  const results = await runBatches(cards, 1, makePrompt, profile.model, "edit");
  const edited = new Map();
  for (const { raw, r } of results) {
    const sections = Array.isArray(r.sections)
      ? r.sections.filter(
          (s) => s && ["prose", "note", "list", "pull"].includes(s.style) && (typeof s.text === "string" || Array.isArray(s.items))
        )
      : [];
    if (!r.title || !sections.some((s) => s.style === "prose")) continue; // keep original on malformed edit
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

/* ------------------------ pass 4: editor's letter ------------------------ */

export async function writeLetter(cards, profile, dateIso) {
  const prompt = `You are the editor of "Daily Deck", a private one-reader knowledge feed. Today is ${dateIso}. Below are today's pieces. Write the editor's letter that opens the deck: 2-4 sentences — the thread connecting today's edition (if one honestly exists), and the one piece not to miss and why. Warm, specific, zero hype, no "welcome to". Address the reader as "you".

Also give it a short title (max 35 chars), like a dateline — e.g. "Sunday's deck" or a phrase naming today's thread.

Output ONLY: {"title": "...", "text": "..."}

TODAY'S PIECES:
${JSON.stringify(cards.map((c) => ({ topic: c.topic, title: c.title, cover: c.body?.slice(0, 160) })), null, 1)}`;

  const r = extractJson(await runClaude(prompt, profile.model), "{", "}");
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
