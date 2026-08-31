import type { Deck } from "./types";
import { buildEvergreenDeck } from "./evergreen";
import { getReadIds } from "./store";

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function tryDeck(date: string): Promise<Deck | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}decks/${date}.json`, { cache: "no-cache" });
    if (!res.ok) return null;
    const deck = (await res.json()) as Deck;
    return deck.cards?.length ? deck : null;
  } catch {
    return null;
  }
}

/** Yesterday's written pieces the reader never reached — appended as
    "Catch up" cards so nothing Opus wrote goes unread over a busy day. */
async function carryover(todayDeck: Deck): Promise<void> {
  const yesterday = await tryDeck(isoDaysAgo(1));
  if (!yesterday) return;
  const readIds = getReadIds();
  const todayIds = new Set(todayDeck.cards.map((c) => c.id));
  const missed = yesterday.cards.filter(
    (c) => c.kind !== "letter" && c.sections?.length && !readIds.has(c.id) && !todayIds.has(c.id)
  );
  todayDeck.cards.push(...missed.slice(0, 5).map((c) => ({ ...c, carryover: true })));
}

/** Today's deck (+ catch-up), else yesterday's, else an evergreen fallback. */
export async function loadDeck(): Promise<Deck> {
  const today = await tryDeck(isoDaysAgo(0));
  if (today) {
    await carryover(today).catch(() => {});
    return today;
  }
  const yesterday = await tryDeck(isoDaysAgo(1));
  if (yesterday) return yesterday;
  return buildEvergreenDeck();
}
