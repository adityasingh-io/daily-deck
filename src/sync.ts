import type { Card } from "./types";
import type { ReviewItem } from "./store";

/* Multi-device sync: one JSON blob in a Cloudflare KV, gated by a sync code
   the user enters once per device. Merge is union-by-id (both devices keep
   everything); the review queue keeps the more-advanced item per card. */

const SYNC_URL = "https://daily-deck-sync.adityasingh-io.workers.dev";
const TOKEN_KEY = "dd.syncToken";
const LAST_KEY = "dd.lastSync";

const KEYS = {
  saves: "dd.saves.v1",
  notes: "dd.notes.v1",
  review: "dd.review.v1",
  retired: "dd.reviewRetired.v1",
  readIds: "dd.readIds.v1",
} as const;

interface SyncState {
  updatedAt: string;
  saves: Card[];
  notes: Record<string, string>;
  review: Record<string, ReviewItem>;
  retired: string[];
  readIds: string[];
  signals: Record<string, number>;
  /** Recent save titles — lets the triage model infer sub-topic taste
      (saving Dostoevsky pieces ≠ "more books in general"). */
  savedTitles: string[];
}

function get<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function put(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function getSyncToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSyncToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t.trim());
}

export function lastSyncedAt(): string | null {
  return localStorage.getItem(LAST_KEY);
}

function collect(): SyncState {
  const saves = get<Card[]>(KEYS.saves, []);
  // Behavior signal for the pipeline: what topics actually get saved.
  const signals: Record<string, number> = {};
  for (const c of saves) signals[c.topic] = (signals[c.topic] ?? 0) + 1;
  return {
    updatedAt: new Date().toISOString(),
    saves,
    notes: get(KEYS.notes, {}),
    review: get(KEYS.review, {}),
    retired: get(KEYS.retired, []),
    readIds: get(KEYS.readIds, []),
    signals,
    savedTitles: saves.slice(0, 20).map((c) => `[${c.topic}] ${c.title}`),
  };
}

function merge(remote: Partial<SyncState>) {
  // saves: union by id, local order first
  const saves = get<Card[]>(KEYS.saves, []);
  const have = new Set(saves.map((c) => c.id));
  for (const c of remote.saves ?? []) if (!have.has(c.id)) saves.push(c);
  put(KEYS.saves, saves.slice(0, 500));

  // notes: fill gaps from remote; local text wins on conflict
  const notes = get<Record<string, string>>(KEYS.notes, {});
  for (const [id, text] of Object.entries(remote.notes ?? {})) if (!notes[id]) notes[id] = text;
  put(KEYS.notes, notes);

  // review: keep the more-advanced item; ties keep the earlier due date
  const review = get<Record<string, ReviewItem>>(KEYS.review, {});
  for (const [id, r] of Object.entries(remote.review ?? {})) {
    const l = review[id];
    if (!l || r.level > l.level || (r.level === l.level && r.due < l.due)) review[id] = r;
  }
  put(KEYS.review, review);

  // retired + readIds: plain unions
  put(KEYS.retired, [...new Set([...get<string[]>(KEYS.retired, []), ...(remote.retired ?? [])])]);
  put(KEYS.readIds, [...new Set([...get<string[]>(KEYS.readIds, []), ...(remote.readIds ?? [])])].slice(-1500));
}

let inFlight = false;

export async function syncNow(): Promise<boolean> {
  const token = getSyncToken();
  if (!token || inFlight) return false;
  inFlight = true;
  try {
    const res = await fetch(SYNC_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return false;
    if (res.ok) merge((await res.json()) as Partial<SyncState>);
    const push = await fetch(SYNC_URL, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(collect()),
    });
    if (push.ok) localStorage.setItem(LAST_KEY, new Date().toISOString());
    return push.ok;
  } catch {
    return false;
  } finally {
    inFlight = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function queueSync() {
  if (!getSyncToken()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => syncNow(), 4000);
}

// Best-effort flush when the app goes to background.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") syncNow();
  });
}
