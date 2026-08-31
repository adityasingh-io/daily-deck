import type { Deck } from "./types";
import { buildEvergreenDeck } from "./evergreen";

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

/** Today's deck, else yesterday's, else a client-built evergreen fallback. */
export async function loadDeck(): Promise<Deck> {
  for (const n of [0, 1]) {
    const deck = await tryDeck(isoDaysAgo(n));
    if (deck) return deck;
  }
  return buildEvergreenDeck();
}
