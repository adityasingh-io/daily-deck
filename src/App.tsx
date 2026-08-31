import { useEffect, useRef, useState } from "react";
import type { Card, Deck } from "./types";
import { loadDeck } from "./deck";
import { getSaves, isSaved, toggleSave, setProgress } from "./store";

const TOPIC_LABEL: Record<string, string> = {
  psych: "Psychology",
  books: "Books & Ideas",
  philosophy: "Philosophy",
  "tech-craft": "Craft",
  "tech-ai": "AI Industry",
  world: "World",
  econ: "Economics",
  wildcard: "Wildcard",
};

function CardView({ card, index, total }: { card: Card; index: number; total: number }) {
  const [saved, setSaved] = useState(() => isSaved(card.id));
  const isPassage = card.kind === "passage";
  const hasImage = Boolean(card.imageUrl);

  return (
    <article className={`card kind-${card.kind}${hasImage ? " has-image" : ""}`}>
      {hasImage && (
        <div className="card-media">
          <img src={card.imageUrl} alt="" loading={index < 2 ? "eager" : "lazy"} />
          <div className="media-fade" />
        </div>
      )}
      <div className="card-body">
        <div className="card-meta">
          <span className={`chip topic-${card.topic}`}>{TOPIC_LABEL[card.topic] ?? card.topic}</span>
          <span className="counter">
            {index + 1} / {total}
          </span>
        </div>
        <h2 className={isPassage ? "passage-title" : undefined}>{card.title}</h2>
        <p className={isPassage ? "passage-text" : "body-text"}>{card.body}</p>
        <div className="card-foot">
          <span className="attribution">{card.attribution}</span>
          <div className="actions">
            {card.listenLink && (
              <a className="btn ghost" href={card.listenLink} target="_blank" rel="noreferrer">
                Listen
              </a>
            )}
            <button
              className={`btn ${saved ? "saved" : "ghost"}`}
              onClick={() => setSaved(toggleSave(card))}
              aria-pressed={saved}
            >
              {saved ? "Saved ✓" : "Save"}
            </button>
            <a className="btn primary" href={card.deepLink} target="_blank" rel="noreferrer">
              Go deeper →
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

function EndCard({ deck }: { deck: Deck }) {
  const saves = getSaves().length;
  return (
    <article className="card end-card">
      <div className="card-body end-body">
        <div className="deckmark" aria-hidden="true">
          <span /><span /><span />
        </div>
        <h2>That's all for today.</h2>
        <p className="body-text">
          {deck.cards.length} cards read · {saves} saved all-time.
          {deck.evergreen ? " (Evergreen deck — the pipeline hasn't run today.)" : ""}
        </p>
        <p className="end-note">Come back tomorrow. Go do something with what stuck.</p>
      </div>
    </article>
  );
}

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDeck().then(setDeck).catch(() => setError(true));
  }, []);

  useEffect(() => {
    const el = feedRef.current;
    if (!el || !deck) return;
    const onScroll = () => {
      const i = Math.round(el.scrollTop / el.clientHeight);
      setProgress(deck.date, i);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [deck]);

  if (error)
    return (
      <div className="splash">
        <p>Couldn't load a deck. Check your connection and pull to refresh.</p>
      </div>
    );

  if (!deck)
    return (
      <div className="splash">
        <div className="deckmark pulse" aria-hidden="true">
          <span /><span /><span />
        </div>
        <p>Shuffling today's deck…</p>
      </div>
    );

  return (
    <div className="feed" ref={feedRef}>
      {deck.cards.map((c, i) => (
        <CardView key={c.id} card={c} index={i} total={deck.cards.length} />
      ))}
      <EndCard deck={deck} />
    </div>
  );
}
