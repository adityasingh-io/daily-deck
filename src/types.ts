export type Topic =
  | "psych"
  | "books"
  | "philosophy"
  | "tech-craft"
  | "tech-ai"
  | "world"
  | "econ"
  | "wildcard";

export type Kind =
  | "concept"
  | "passage"
  | "deepdive"
  | "news"
  | "craft"
  | "essay"
  | "fact"
  | "art"
  | "letter";

export interface Section {
  label?: string | null;
  style: "prose" | "note" | "list" | "pull";
  text?: string;
  items?: string[];
}

export interface Card {
  id: string;
  source: string;
  topic: Topic;
  kind: Kind;
  title: string;
  body: string;
  /** Legacy single-text read (v2 decks); superseded by sections. */
  full?: string;
  /** The in-app piece: blueprint-structured sections that replace the source. */
  sections?: Section[];
  /** "Guess before reading" prompt shown on the card cover. */
  predict?: string;
  /** Evidence marker for study-based pieces, extracted from source only. */
  evidence?: string;
  /** Hidden flashcard, collected for the future spaced-review loop. */
  recall?: { q: string; a: string };
  imageUrl?: string;
  deepLink: string;
  listenLink?: string;
  attribution: string;
  publishedAt?: string;
}

export interface Deck {
  date: string; // YYYY-MM-DD
  generatedAt?: string;
  evergreen?: boolean;
  cards: Card[];
}
