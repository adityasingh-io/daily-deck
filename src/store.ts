import type { Card } from "./types";

const SAVES_KEY = "dd.saves.v1";
const PROGRESS_KEY = "dd.progress.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or private mode — feed still works */
  }
}

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
    return false;
  }
  saves.unshift(card);
  write(SAVES_KEY, saves.slice(0, 500));
  return true;
}

export function getProgress(date: string): number {
  return read<Record<string, number>>(PROGRESS_KEY, {})[date] ?? 0;
}

export function setProgress(date: string, index: number) {
  const all = read<Record<string, number>>(PROGRESS_KEY, {});
  if ((all[date] ?? 0) >= index) return;
  all[date] = index;
  write(PROGRESS_KEY, all);
}
