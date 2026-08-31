import type { Card, Deck } from "./types";

/* Client-side fallback deck, built entirely from CORS-friendly free APIs.
   Used only when no generated deck exists for today or yesterday, so a
   missed pipeline run degrades to "slightly generic", never to "empty". */

const T = 15000;

async function j(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), T);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function todayParts() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return { y, m, day, iso: `${y}-${m}-${day}` };
}

async function wikimedia(): Promise<Card[]> {
  const { y, m, day } = todayParts();
  const data = await j(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${y}/${m}/${day}`);
  const cards: Card[] = [];

  if (data.tfa?.extract) {
    cards.push({
      id: `ev-tfa-${y}${m}${day}`,
      source: "wikipedia-featured",
      topic: "wildcard",
      kind: "fact",
      title: data.tfa.titles?.normalized ?? data.tfa.title,
      body: data.tfa.extract,
      imageUrl: data.tfa.thumbnail?.source,
      deepLink: data.tfa.content_urls?.desktop?.page ?? "https://en.wikipedia.org",
      attribution: "Wikipedia · CC BY-SA 4.0",
    });
  }

  for (const a of (data.mostread?.articles ?? []).slice(0, 6)) {
    if (!a.extract || !a.thumbnail) continue;
    cards.push({
      id: `ev-mr-${a.pageid}`,
      source: "wikipedia-mostread",
      topic: "wildcard",
      kind: "fact",
      title: a.titles?.normalized ?? a.title,
      body: a.extract,
      imageUrl: a.thumbnail?.source,
      deepLink: a.content_urls?.desktop?.page,
      attribution: "Wikipedia · CC BY-SA 4.0",
    });
  }

  for (const ev of (data.onthisday ?? []).slice(0, 5)) {
    const page = ev.pages?.[0];
    cards.push({
      id: `ev-otd-${ev.year}-${(ev.text ?? "").slice(0, 24)}`,
      source: "wikipedia-onthisday",
      topic: "wildcard",
      kind: "fact",
      title: `${ev.year} — on this day`,
      body: ev.text,
      imageUrl: page?.thumbnail?.source,
      deepLink: page?.content_urls?.desktop?.page ?? "https://en.wikipedia.org",
      attribution: "Wikipedia · CC BY-SA 4.0",
    });
  }

  if (data.image?.thumbnail) {
    cards.push({
      id: `ev-potd-${y}${m}${day}`,
      source: "wikimedia-potd",
      topic: "wildcard",
      kind: "art",
      title: "Picture of the day",
      body: data.image.description?.text ?? "",
      imageUrl: data.image.thumbnail.source,
      deepLink: data.image.file_page ?? "https://commons.wikimedia.org",
      attribution: `Wikimedia Commons · ${data.image.artist?.text ?? "unknown artist"}`,
    });
  }
  return cards;
}

async function artwork(): Promise<Card[]> {
  const page = 1 + Math.floor(Math.random() * 200);
  const fields = "id,title,image_id,thumbnail,artist_display,date_display,short_description,is_public_domain";
  const data = await j(`https://api.artic.edu/api/v1/artworks?page=${page}&limit=6&fields=${fields}`);
  const iiif = data.config?.iiif_url ?? "https://www.artic.edu/iiif/2";
  return (data.data ?? [])
    .filter((a: any) => a.image_id && a.is_public_domain)
    .slice(0, 2)
    .map((a: any) => ({
      id: `ev-aic-${a.id}`,
      source: "artic",
      topic: "wildcard" as const,
      kind: "art" as const,
      title: a.title,
      body: a.short_description?.replace(/<[^>]+>/g, "") || `${a.artist_display ?? ""} · ${a.date_display ?? ""}`,
      imageUrl: `${iiif}/${a.image_id}/full/843,/0/default.jpg`,
      deepLink: `https://www.artic.edu/artworks/${a.id}`,
      attribution: "Art Institute of Chicago · CC0",
    }));
}

async function apod(): Promise<Card[]> {
  const data = await j("https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY&thumbs=true");
  if (!data.title) return [];
  return [
    {
      id: `ev-apod-${data.date}`,
      source: "nasa-apod",
      topic: "wildcard",
      kind: "fact",
      title: data.title,
      body: (data.explanation ?? "").split(". ").slice(0, 3).join(". ") + ".",
      imageUrl: data.media_type === "image" ? data.url : data.thumbnail_url,
      deepLink: "https://apod.nasa.gov/apod/",
      attribution: data.copyright ? `NASA APOD · © ${data.copyright.trim()}` : "NASA APOD · public domain",
    },
  ];
}

export async function buildEvergreenDeck(): Promise<Deck> {
  const { iso } = todayParts();
  const results = await Promise.allSettled([wikimedia(), artwork(), apod()]);
  const cards = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return { date: iso, evergreen: true, cards: cards.slice(0, 25) };
}
