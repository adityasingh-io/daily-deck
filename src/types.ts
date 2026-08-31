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
  | "art";

export interface Card {
  id: string;
  source: string;
  topic: Topic;
  kind: Kind;
  title: string;
  body: string;
  /** The in-app read: an AI distillation that replaces the source article. */
  full?: string;
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
