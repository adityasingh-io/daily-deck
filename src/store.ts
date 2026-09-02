import type { Card } from "./types";

const SAVES_KEY = "dd.saves.v1";
const PROGRESS_KEY = "dd.progress.v1";
const REVIEW_KEY = "dd.review.v1";
const RETIRED_KEY = "dd.reviewRetired.v1";

/* Graduated intervals (days). Success climbs a level; a miss resets to the
   start; passing the last level retires the card as learned. */
const INTERVALS = [1, 3, 7, 21, 60];

export interface ReviewItem {
  card: Card;
  level: number;
  due: string; // YYYY-MM-DD
  added: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let changeListener: (() => void) | null = null;

/** Called after any meaningful write — sync uses this to schedule a push. */
export function onStoreChange(f: () => void) {
  changeListener = f;
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    if (key !== PROGRESS_KEY) changeListener?.();
  } catch {
    /* storage full or private mode — feed still works */
  }
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ------------------------------- saves ------------------------------- */

export function getSaves(): Card[] {
  return read<Card[]>(SAVES_KEY, []);
}

export function isSaved(id: string): boolean {
  return getSaves().some((c) => c.id === id);
}

export function toggleSave(card: Card): boolean {
  const saves = getSaves();
  const i = saves.findIndex((c) => c.id === card.id);
  if (i >= 0) {
    saves.splice(i, 1);
    write(SAVES_KEY, saves);
    const queue = read<Record<string, ReviewItem>>(REVIEW_KEY, {});
    if (queue[card.id]) {
      delete queue[card.id];
      write(REVIEW_KEY, queue);
    }
    return false;
  }
  saves.unshift(card);
  write(SAVES_KEY, saves.slice(0, 500));
  syncReviewQueue();
  return true;
}

/* ------------------------------ progress ------------------------------ */

export function getProgress(date: string): number {
  return read<Record<string, number>>(PROGRESS_KEY, {})[date] ?? 0;
}

/** Stores the LAST position, not the furthest — reopen where you closed. */
export function setProgress(date: string, index: number) {
  if (!Number.isFinite(index) || index < 0) return;
  const all = read<Record<string, number>>(PROGRESS_KEY, {});
  if (all[date] === index) return;
  all[date] = index;
  write(PROGRESS_KEY, all);
}

/* ---------------------------- read tracking ---------------------------- */

const READ_KEY = "dd.readIds.v1";

export function markRead(id: string) {
  const ids = read<string[]>(READ_KEY, []);
  if (ids.includes(id)) return;
  ids.push(id);
  write(READ_KEY, ids.slice(-1500));
}

export function getReadIds(): Set<string> {
  return new Set(read<string[]>(READ_KEY, []));
}

/* ------------------------------- loves ------------------------------- */
/* One-tap taste signal: cheaper than a save, feeds ONLY the learning loop
   (never the review queue). No streaks, no counts shown — just signal. */

const LOVES_KEY = "dd.loves.v1";

export interface Love {
  id: string;
  topic: string;
  title: string;
  at: string;
}

export function getLoves(): Love[] {
  return read<Love[]>(LOVES_KEY, []);
}

export function isLoved(id: string): boolean {
  return getLoves().some((l) => l.id === id);
}

export function toggleLove(card: Card): boolean {
  const loves = getLoves();
  const i = loves.findIndex((l) => l.id === card.id);
  if (i >= 0) {
    loves.splice(i, 1);
    write(LOVES_KEY, loves);
    return false;
  }
  loves.unshift({ id: card.id, topic: card.topic, title: card.title, at: new Date().toISOString() });
  write(LOVES_KEY, loves.slice(0, 300));
  return true;
}

/* ------------------------------- notes ------------------------------- */

const NOTES_KEY = "dd.notes.v1";

export function getNote(id: string): string {
  return read<Record<string, string>>(NOTES_KEY, {})[id] ?? "";
}

export function getAllNotes(): Record<string, string> {
  return read<Record<string, string>>(NOTES_KEY, {});
}

export function setNote(id: string, text: string) {
  const all = read<Record<string, string>>(NOTES_KEY, {});
  if (text.trim()) all[id] = text;
  else delete all[id];
  write(NOTES_KEY, all);
}

/* ---------------------------- review loop ---------------------------- */

/** Every saved card with a recall Q&A enters the queue, due tomorrow. */
export function syncReviewQueue() {
  const queue = read<Record<string, ReviewItem>>(REVIEW_KEY, {});
  const retired = new Set(read<string[]>(RETIRED_KEY, []));
  let changed = false;
  for (const c of getSaves()) {
    if (c.recall && !queue[c.id] && !retired.has(c.id)) {
      queue[c.id] = { card: c, level: 0, due: addDays(todayIso(), 1), added: todayIso() };
      changed = true;
    }
  }
  if (changed) write(REVIEW_KEY, queue);
}

export function getDueReviews(max = 5): ReviewItem[] {
  syncReviewQueue();
  const queue = read<Record<string, ReviewItem>>(REVIEW_KEY, {});
  const today = todayIso();
  return Object.values(queue)
    .filter((r) => r.due <= today && r.card?.recall)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, max);
}

/** Returns the feedback line to show the reader. */
export function answerReview(id: string, gotIt: boolean): string {
  const queue = read<Record<string, ReviewItem>>(REVIEW_KEY, {});
  const item = queue[id];
  if (!item) return "";
  if (!gotIt) {
    item.level = 0;
    item.due = addDays(todayIso(), 1);
    write(REVIEW_KEY, queue);
    return "No shame — back tomorrow.";
  }
  const next = item.level + 1;
  if (next >= INTERVALS.length) {
    delete queue[id];
    write(REVIEW_KEY, queue);
    const retired = read<string[]>(RETIRED_KEY, []);
    retired.push(id);
    write(RETIRED_KEY, retired);
    return "Mastered — this one's yours now.";
  }
  item.level = next;
  item.due = addDays(todayIso(), INTERVALS[next]);
  write(REVIEW_KEY, queue);
  return `Good. See you in ${INTERVALS[next]} days.`;
}

export function reviewQueueSize(): number {
  return Object.keys(read<Record<string, ReviewItem>>(REVIEW_KEY, {})).length;
}
