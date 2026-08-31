import { useEffect, useRef, useState } from "react";
import type { Card, Deck, Section } from "./types";
import { loadDeck } from "./deck";
import { getSaves, isSaved, toggleSave, setProgress, getProgress } from "./store";

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

function chipLabel(card: Card) {
  if (card.kind === "letter") return "Today's edition";
  return TOPIC_LABEL[card.topic] ?? card.topic;
}

function hasReadView(card: Card) {
  return Boolean(card.sections?.length || card.full);
}

function readMinutes(card: Card) {
  const words = (card.sections?.map((s) => s.text ?? (s.items ?? []).join(" ")).join(" ") ?? card.full ?? "")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

function SaveButton({ card }: { card: Card }) {
  const [saved, setSaved] = useState(() => isSaved(card.id));
  return (
    <button className={`btn ${saved ? "saved" : "ghost"}`} onClick={() => setSaved(toggleSave(card))} aria-pressed={saved}>
      {saved ? "Saved ✓" : "Save"}
    </button>
  );
}

function CardView({
  card,
  index,
  total,
  onRead,
}: {
  card: Card;
  index: number;
  total: number;
  onRead: (i: number) => void;
}) {
  const hasImage = Boolean(card.imageUrl);
  const readable = hasReadView(card);

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
          <span className="chip">{chipLabel(card)}</span>
          <span className="counter">
            {index + 1} / {total}
          </span>
        </div>
        <h2>{card.title}</h2>
        <p className="body-text">{card.body}</p>
        {card.predict && <div className="predict">{card.predict}</div>}
        <div className="card-foot">
          <span className="attribution">
            {readable ? `${readMinutes(card)} min read · ` : ""}
            {card.attribution}
          </span>
          {card.kind !== "letter" && (
            <div className="actions">
              <SaveButton card={card} />
              {readable ? (
                <button className="btn primary" onClick={() => onRead(index)}>
                  Read →
                </button>
              ) : card.deepLink ? (
                <a className="btn primary" href={card.deepLink} target="_blank" rel="noreferrer">
                  Go deeper →
                </a>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function SectionView({ section }: { section: Section }) {
  if (section.style === "prose") {
    return (
      <div className="sec-prose">
        {(section.text ?? "").split(/\n\n+/).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  }
  if (section.style === "list") {
    return (
      <div className="box box-list">
        {section.label && <span className="sec-label">{section.label}</span>}
        <ul>
          {(section.items ?? []).map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (section.style === "note") {
    return (
      <div className="box box-note">
        {section.label && <span className="sec-label">{section.label}</span>}
        <p>{section.text}</p>
      </div>
    );
  }
  return <div className="pull">{section.text}</div>;
}

function Reader({
  card,
  nextCard,
  onClose,
  onNext,
}: {
  card: Card;
  nextCard: Card | null;
  onClose: () => void;
  onNext: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [card.id]);

  const sections: Section[] = card.sections?.length
    ? card.sections
    : [{ style: "prose", text: card.full ?? card.body }];

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={card.title}>
      <div className="reader-bar">
        <button className="btn ghost" onClick={onClose} aria-label="Close reader">
          ← Deck
        </button>
        <SaveButton card={card} />
      </div>
      <div className="reader-scroll" ref={scrollRef}>
        <span className="chip">{chipLabel(card)}</span>
        <h1>{card.title}</h1>
        {card.evidence && <div className="evidence">{card.evidence}</div>}
        {sections.map((s, i) => (
          <SectionView key={i} section={s} />
        ))}
        <div className="reader-foot">
          <span className="attribution">{card.attribution}</span>
          {card.deepLink && (
            <a href={card.deepLink} target="_blank" rel="noreferrer">
              Original source →
            </a>
          )}
        </div>
        {nextCard ? (
          <button className="next-btn" onClick={onNext}>
            Next: {nextCard.title} →
          </button>
        ) : (
          <button className="next-btn done" onClick={onClose}>
            That was the last piece — back to the deck
          </button>
        )}
      </div>
    </div>
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
          {deck.cards.length} cards · {saves} saved all-time.
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
  const [readingIndex, setReadingIndex] = useState<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDeck().then(setDeck).catch(() => setError(true));
  }, []);

  // Restore scroll position: reopen where you left off, every session.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || !deck) return;
    const saved = getProgress(deck.date);
    if (saved > 0) {
      requestAnimationFrame(() => {
        el.scrollTop = Math.min(saved, deck.cards.length) * el.clientHeight;
      });
    }
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

  const nextReadable = (from: number): number | null => {
    for (let i = from + 1; i < deck.cards.length; i++) {
      if (hasReadView(deck.cards[i])) return i;
    }
    return null;
  };

  const goTo = (i: number | null) => {
    setReadingIndex(i);
    if (i !== null && feedRef.current) {
      feedRef.current.scrollTo({ top: i * feedRef.current.clientHeight });
    }
  };

  const reading = readingIndex !== null ? deck.cards[readingIndex] : null;
  const nextIdx = readingIndex !== null ? nextReadable(readingIndex) : null;

  return (
    <>
      <div className="feed" ref={feedRef}>
        {deck.cards.map((c, i) => (
          <CardView key={c.id} card={c} index={i} total={deck.cards.length} onRead={goTo} />
        ))}
        <EndCard deck={deck} />
      </div>
      {reading && (
        <Reader
          card={reading}
          nextCard={nextIdx !== null ? deck.cards[nextIdx] : null}
          onClose={() => setReadingIndex(null)}
          onNext={() => goTo(nextIdx)}
        />
      )}
    </>
  );
}
