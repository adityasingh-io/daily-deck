import { useEffect, useMemo, useRef, useState } from "react";
import type { Card, Deck, Section } from "./types";
import { loadDeck } from "./deck";
import {
  getSaves,
  isSaved,
  toggleSave,
  setProgress,
  getProgress,
  getDueReviews,
  answerReview,
  getNote,
  setNote,
  getAllNotes,
  markRead,
  type ReviewItem,
} from "./store";
import { TOPIC_LABEL } from "./labels";
import { shareCard } from "./share";

type Entry = { type: "card"; card: Card } | { type: "review"; item: ReviewItem };

function entryCard(e: Entry): Card {
  return e.type === "card" ? e.card : e.item.card;
}

function chipLabel(card: Card) {
  if (card.kind === "letter") return "Today's edition";
  const label = TOPIC_LABEL[card.topic] ?? card.topic;
  return card.carryover ? `Catch up · ${label}` : label;
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
    <article className={`card kind-${card.kind} topic-${card.topic}${hasImage ? " has-image" : ""}`}>
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

function ReviewCardView({
  item,
  index,
  total,
  onRead,
}: {
  item: ReviewItem;
  index: number;
  total: number;
  onRead: (i: number) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const recall = item.card.recall!;

  return (
    <article className="card review-card">
      <div className="card-body review-body">
        <div className="card-meta">
          <span className="chip chip-review">Do you remember</span>
          <span className="counter">
            {index + 1} / {total}
          </span>
        </div>
        <p className="review-q">{recall.q}</p>
        {!revealed && (
          <button className="btn primary" onClick={() => setRevealed(true)}>
            Reveal
          </button>
        )}
        {revealed && (
          <>
            <p className="review-a">{recall.a}</p>
            {feedback ? (
              <p className="review-feedback">{feedback}</p>
            ) : (
              <div className="actions">
                <button className="btn ghost" onClick={() => setFeedback(answerReview(item.card.id, false))}>
                  Forgot
                </button>
                <button className="btn primary" onClick={() => setFeedback(answerReview(item.card.id, true))}>
                  Got it
                </button>
              </div>
            )}
            {hasReadView(item.card) && (
              <button className="btn ghost reread" onClick={() => onRead(index)}>
                Read the piece again →
              </button>
            )}
          </>
        )}
        <span className="attribution">{item.card.title} · {item.card.attribution}</span>
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

function NoteBox({ card }: { card: Card }) {
  const [text, setText] = useState(() => getNote(card.id));
  return (
    <div className="box notebox">
      <span className="sec-label">My note</span>
      <textarea
        value={text}
        rows={3}
        placeholder="What did this make you think?"
        onChange={(e) => {
          setText(e.target.value);
          setNote(card.id, e.target.value);
        }}
      />
    </div>
  );
}

function LibraryView({ onClose, onOpen }: { onClose: () => void; onOpen: (c: Card) => void }) {
  const [q, setQ] = useState("");
  const saves = getSaves();
  const notes = getAllNotes();
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? saves.filter((c) => `${c.title} ${c.body} ${notes[c.id] ?? ""}`.toLowerCase().includes(needle))
    : saves;

  return (
    <div className="library" role="dialog" aria-modal="true" aria-label="Library">
      <div className="reader-bar">
        <button className="btn ghost" onClick={onClose}>
          ← Deck
        </button>
        <span className="lib-count">Library · {saves.length}</span>
      </div>
      <div className="lib-scroll">
        <input
          className="lib-search"
          type="search"
          placeholder="Search saves and notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {filtered.length === 0 && (
          <p className="lib-empty">
            {saves.length === 0 ? "Nothing saved yet — tap Save on any card worth keeping." : "No matches."}
          </p>
        )}
        {filtered.map((c) => (
          <button key={c.id} className={`lib-row topic-${c.topic}`} onClick={() => onOpen(c)}>
            {c.imageUrl && <img src={c.imageUrl} alt="" loading="lazy" />}
            <span className="lib-row-main">
              <span className="lib-row-title">{c.title}</span>
              <span className="lib-row-meta">
                <span className="lib-chip">{TOPIC_LABEL[c.topic] ?? c.topic}</span>
                {notes[c.id] ? ` ✎ ${notes[c.id].slice(0, 60)}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecallBox({ card }: { card: Card }) {
  const [open, setOpen] = useState(false);
  if (!card.recall) return null;
  return (
    <div className="box recall">
      <span className="sec-label">Test yourself</span>
      <p className="recall-q">{card.recall.q}</p>
      {open ? (
        <p className="recall-a">{card.recall.a}</p>
      ) : (
        <button className="btn ghost" onClick={() => setOpen(true)}>
          Reveal answer
        </button>
      )}
    </div>
  );
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
    <div className={`reader topic-${card.topic}`} role="dialog" aria-modal="true" aria-label={card.title}>
      <div className="reader-bar">
        <button className="btn ghost" onClick={onClose} aria-label="Close reader">
          ← Back
        </button>
        <div className="actions">
          <button className="btn ghost" onClick={() => shareCard(card).catch(() => {})}>
            Share
          </button>
          <SaveButton card={card} />
        </div>
      </div>
      <div className="reader-scroll" ref={scrollRef}>
        <span className="chip">{chipLabel(card)}</span>
        <h1>{card.title}</h1>
        {card.evidence && <div className="evidence">{card.evidence}</div>}
        {sections.map((s, i) => (
          <SectionView key={i} section={s} />
        ))}
        <RecallBox key={card.id} card={card} />
        <NoteBox key={`note-${card.id}`} card={card} />
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

function EndCard({ deck, total }: { deck: Deck; total: number }) {
  const saves = getSaves().length;
  return (
    <article className="card end-card">
      <div className="card-body end-body">
        <div className="deckmark" aria-hidden="true">
          <span /><span /><span />
        </div>
        <h2>That's all for today.</h2>
        <p className="body-text">
          {total} cards · {saves} saved all-time.
          {deck.evergreen ? " (Evergreen deck — the pipeline hasn't run today.)" : ""}
        </p>
        <p className="end-note">Come back tomorrow. Go do something with what stuck.</p>
      </div>
    </article>
  );
}

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [error, setError] = useState(false);
  const [readingIndex, setReadingIndex] = useState<number | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libCard, setLibCard] = useState<Card | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadDeck()
      .then((d) => {
        setReviews(getDueReviews(5));
        setDeck(d);
      })
      .catch(() => setError(true));
  }, []);

  // Reviews slot in right after the editor's letter, before the new pieces.
  const entries: Entry[] = useMemo(() => {
    if (!deck) return [];
    const reviewEntries: Entry[] = reviews.map((item) => ({ type: "review", item }));
    const cards: Entry[] = deck.cards.map((card) => ({ type: "card", card }));
    if (deck.cards[0]?.kind === "letter") {
      return [cards[0], ...reviewEntries, ...cards.slice(1)];
    }
    return [...reviewEntries, ...cards];
  }, [deck, reviews]);

  // Restore scroll position: reopen where you left off, every session.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || !deck) return;
    const saved = getProgress(deck.date);
    if (saved > 0) {
      requestAnimationFrame(() => {
        el.scrollTop = Math.min(saved, entries.length) * el.clientHeight;
      });
    }
    const onScroll = () => {
      const i = Math.round(el.scrollTop / el.clientHeight);
      setProgress(deck.date, i);
      if (entries[i]) markRead(entryCard(entries[i]).id);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [deck, entries.length]);

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
    for (let i = from + 1; i < entries.length; i++) {
      if (hasReadView(entryCard(entries[i]))) return i;
    }
    return null;
  };

  const goTo = (i: number | null) => {
    setReadingIndex(i);
    if (i !== null) {
      markRead(entryCard(entries[i]).id);
      feedRef.current?.scrollTo({ top: i * feedRef.current.clientHeight });
    }
  };

  const reading = libCard ?? (readingIndex !== null ? entryCard(entries[readingIndex]) : null);
  const nextIdx = libCard === null && readingIndex !== null ? nextReadable(readingIndex) : null;

  return (
    <>
      <div className="feed" ref={feedRef}>
        {entries.map((e, i) =>
          e.type === "review" ? (
            <ReviewCardView key={`rv-${e.item.card.id}`} item={e.item} index={i} total={entries.length} onRead={goTo} />
          ) : (
            <CardView key={e.card.id} card={e.card} index={i} total={entries.length} onRead={goTo} />
          )
        )}
        <EndCard deck={deck} total={entries.length} />
      </div>
      <button className="lib-btn" onClick={() => setLibraryOpen(true)}>
        Library
      </button>
      {libraryOpen && (
        <LibraryView onClose={() => setLibraryOpen(false)} onOpen={(c) => setLibCard(c)} />
      )}
      {reading && (
        <Reader
          card={reading}
          nextCard={nextIdx !== null ? entryCard(entries[nextIdx]) : null}
          onClose={() => (libCard ? setLibCard(null) : setReadingIndex(null))}
          onNext={() => goTo(nextIdx)}
        />
      )}
    </>
  );
}
