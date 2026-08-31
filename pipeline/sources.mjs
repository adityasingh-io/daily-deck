import { XMLParser } from "fast-xml-parser";

const UA = "DailyDeck/0.1 (personal knowledge feed; +https://github.com/adityasingh-io/daily-deck)";
const TIMEOUT = 25000;

async function get(url, type = "json") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return type === "json" ? await res.json() : await res.text();
  } finally {
    clearTimeout(t);
  }
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: false });

export function stripHtml(s) {
  return String(s ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstImg(html) {
  const m = String(html ?? "").match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : undefined;
}

function normalizeFeedItems(parsed) {
  // RSS 2.0 / RSS 1.0
  const ch = parsed?.rss?.channel ?? parsed?.["rdf:RDF"];
  if (ch) {
    let items = ch.item ?? [];
    if (!Array.isArray(items)) items = [items];
    return items.map((it) => {
      const contentHtml = it["content:encoded"] ?? it.description ?? "";
      const media = it["media:content"] ?? it["media:thumbnail"] ?? it.enclosure;
      const mediaUrl = Array.isArray(media) ? media[0]?.["@_url"] : media?.["@_url"];
      return {
        title: stripHtml(it.title),
        link: typeof it.link === "object" ? it.link["@_href"] : it.link,
        text: stripHtml(contentHtml),
        image: mediaUrl ?? firstImg(contentHtml),
        published: it.pubDate ?? it["dc:date"],
      };
    });
  }
  // Atom
  const feed = parsed?.feed;
  if (feed) {
    let entries = feed.entry ?? [];
    if (!Array.isArray(entries)) entries = [entries];
    return entries.map((e) => {
      const links = Array.isArray(e.link) ? e.link : [e.link];
      const alt = links.find((l) => l?.["@_rel"] === "alternate" || !l?.["@_rel"]) ?? links[0];
      const contentHtml = e.content?.["#text"] ?? e.content ?? e.summary?.["#text"] ?? e.summary ?? "";
      return {
        title: stripHtml(e.title?.["#text"] ?? e.title),
        link: alt?.["@_href"],
        text: stripHtml(contentHtml),
        image: firstImg(contentHtml),
        published: e.published ?? e.updated,
      };
    });
  }
  return [];
}

/* ------------------------- source roster ------------------------- */

/* fullInFeed: the feed carries the complete article, so the writer pass gets
   it for free. Teaser feeds get their article page fetched (winners only). */
const RSS_SOURCES = [
  { id: "psypost",       url: "https://www.psypost.org/feed",                    topic: "psych",      kindHint: "concept", take: 5, fullInFeed: true,  attribution: "PsyPost" },
  { id: "psyche",        url: "https://psyche.co/feed.rss",                      topic: "psych",      kindHint: "essay",   take: 4, fullInFeed: false, attribution: "Psyche (Aeon)" },
  { id: "exp-history",   url: "https://www.experimental-history.com/feed",       topic: "psych",      kindHint: "essay",   take: 2, fullInFeed: true,  attribution: "Experimental History" },
  { id: "phil-break",    url: "https://philosophybreak.com/rss.xml",             topic: "philosophy", kindHint: "concept", take: 4, fullInFeed: false, attribution: "Philosophy Break" },
  { id: "marginalian",   url: "https://www.themarginalian.org/feed/",            topic: "books",      kindHint: "essay",   take: 3, fullInFeed: true,  attribution: "The Marginalian" },
  { id: "aeon",          url: "https://aeon.co/feed.rss",                        topic: "philosophy", kindHint: "essay",   take: 3, fullInFeed: false, attribution: "Aeon" },
  { id: "semafor",       url: "https://www.semafor.com/rss.xml",                 topic: "world",      kindHint: "news",    take: 6, fullInFeed: true,  attribution: "Semafor" },
  { id: "wotr",          url: "https://warontherocks.com/feed/",                 topic: "world",      kindHint: "essay",   take: 3, fullInFeed: false, attribution: "War on the Rocks" },
  { id: "bbc-world",     url: "https://feeds.bbci.co.uk/news/world/rss.xml",     topic: "world",      kindHint: "news",    take: 5, fullInFeed: false, attribution: "BBC News" },
  { id: "marginal-rev",  url: "https://marginalrevolution.com/feed",             topic: "econ",       kindHint: "concept", take: 4, fullInFeed: true,  attribution: "Marginal Revolution" },
  { id: "import-ai",     url: "https://importai.substack.com/feed",              topic: "tech-ai",    kindHint: "essay",   take: 2, fullInFeed: true,  attribution: "Import AI" },
  { id: "one-useful",    url: "https://www.oneusefulthing.org/feed",             topic: "tech-ai",    kindHint: "essay",   take: 2, fullInFeed: true,  attribution: "One Useful Thing" },
  { id: "jvns",          url: "https://jvns.ca/atom.xml",                        topic: "tech-craft", kindHint: "craft",   take: 2, fullInFeed: true,  attribution: "Julia Evans" },
  { id: "fowler",        url: "https://martinfowler.com/feed.atom",              topic: "tech-craft", kindHint: "craft",   take: 2, fullInFeed: true,  attribution: "martinfowler.com" },
  { id: "jim-nielsen",   url: "https://blog.jim-nielsen.com/feed.xml",           topic: "tech-craft", kindHint: "craft",   take: 2, fullInFeed: true,  attribution: "Jim Nielsen" },
];

async function fetchRss(src) {
  const raw = await get(src.url, "text");
  return normalizeFeedItems(xml.parse(raw))
    .filter((it) => it.title && it.link)
    .slice(0, src.take)
    .map((it) => ({
      ...it,
      source: src.id,
      topic: src.topic,
      kindHint: src.kindHint,
      attribution: src.attribution,
      fullInFeed: src.fullInFeed,
      text: it.text.slice(0, src.fullInFeed ? 24000 : 1600),
    }));
}

/* Naive readability: for teaser feeds, pull the article page and keep the
   substantial <p> blocks. Good enough as LLM input; never shown raw.
   Lessons from live testing: pages can contain several <article> tags (pick
   the longest), and some bury body text outside <article> entirely (fall
   back to whole-page <p> extraction). */
export async function fetchArticleMeta(url) {
  const html = await get(url, "text");
  const extract = (s) =>
    [...s.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripHtml(m[1])).filter((p) => p.length > 80);
  const articles = [...html.matchAll(/<article[\s\S]*?<\/article>/gi)].map((m) => m[0]);
  const scope = articles.sort((a, b) => b.length - a.length)[0];
  let paras = scope ? extract(scope) : [];
  if (paras.join(" ").length < 1500) paras = extract(html);

  // Cover art: og:image / twitter:image, either attribute order
  const image =
    html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i)?.[1];

  return { text: paras.join("\n\n").slice(0, 24000), image: image?.startsWith("http") ? image : undefined };
}

async function fetchLobsters() {
  const items = await get("https://lobste.rs/t/practices,programming.json").catch(() => get("https://lobste.rs/hottest.json"));
  return items.slice(0, 6).map((s) => ({
    source: "lobsters",
    topic: "tech-craft",
    kindHint: "craft",
    attribution: "via Lobsters",
    title: s.title,
    link: s.url || s.comments_url,
    text: stripHtml(s.description_plain ?? s.description ?? "").slice(0, 800) || `${s.score} points on Lobsters, tags: ${(s.tags ?? []).join(", ")}`,
    published: s.created_at,
  }));
}

async function fetchHn() {
  const cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
  const data = await get(`https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E150,created_at_i%3E${cutoff}&hitsPerPage=12`);
  return (data.hits ?? []).slice(0, 8).map((h) => ({
    source: "hackernews",
    topic: "tech-craft",
    kindHint: "craft",
    attribution: "via Hacker News",
    title: h.title,
    link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    text: `${h.points} points, ${h.num_comments} comments on Hacker News. ${stripHtml(h.story_text ?? "").slice(0, 400)}`,
    published: h.created_at,
  }));
}

/* Wildcard CANDIDATES: already card-shaped, but they do NOT get a free pass —
   build-deck scores them through the same triage as everything else and only
   the best few earn slots. (Lesson: Wikipedia's featured article is whatever
   Wikipedia chose that day — unranked, that put a Mariah Carey album in the
   deck.) */
async function fetchWildcards(dateIso) {
  const [y, m, d] = dateIso.split("-");
  const cards = [];

  try {
    const data = await get(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${y}/${m}/${d}`);
    if (data.tfa?.extract) {
      cards.push({
        id: `tfa-${dateIso}`, source: "wikipedia-featured", topic: "wildcard", kind: "fact",
        title: data.tfa.titles?.normalized ?? data.tfa.title, body: data.tfa.extract,
        imageUrl: data.tfa.thumbnail?.source, deepLink: data.tfa.content_urls?.desktop?.page,
        attribution: "Wikipedia · CC BY-SA 4.0",
      });
    }
    for (const a of (data.mostread?.articles ?? []).filter((x) => x.extract && x.thumbnail).slice(0, 4)) {
      cards.push({
        id: `mr-${a.pageid}`, source: "wikipedia-mostread", topic: "wildcard", kind: "fact",
        title: a.titles?.normalized ?? a.title, body: a.extract,
        imageUrl: a.thumbnail.source, deepLink: a.content_urls?.desktop?.page,
        attribution: "Wikipedia · CC BY-SA 4.0",
      });
    }
    for (const [idx, otd] of (data.onthisday ?? []).filter((e) => e.pages?.[0]?.thumbnail).slice(0, 4).entries()) {
      cards.push({
        id: `otd-${dateIso}-${idx}`, source: "wikipedia-onthisday", topic: "wildcard", kind: "fact",
        title: `${otd.year} — on this day`, body: otd.text,
        imageUrl: otd.pages[0].thumbnail.source, deepLink: otd.pages[0].content_urls?.desktop?.page,
        attribution: "Wikipedia · CC BY-SA 4.0",
      });
    }
  } catch (e) {
    console.error("wikimedia wildcard failed:", e.message);
  }

  try {
    const apodKey = process.env.NASA_API_KEY ?? "DEMO_KEY";
    const a = await get(`https://api.nasa.gov/planetary/apod?api_key=${apodKey}&thumbs=true`);
    if (a.title) {
      cards.push({
        id: `apod-${a.date}`, source: "nasa-apod", topic: "wildcard", kind: "fact",
        title: a.title, body: a.explanation?.split(". ").slice(0, 3).join(". ") + ".",
        imageUrl: a.media_type === "image" ? a.url : a.thumbnail_url, deepLink: "https://apod.nasa.gov/apod/",
        attribution: a.copyright ? `NASA APOD · © ${String(a.copyright).trim()}` : "NASA APOD · public domain",
      });
    }
  } catch (e) {
    console.error("apod failed:", e.message);
  }

  try {
    const page = 1 + Math.floor(Math.random() * 200);
    const fields = "id,title,image_id,artist_display,date_display,short_description,is_public_domain";
    const art = await get(`https://api.artic.edu/api/v1/artworks?page=${page}&limit=8&fields=${fields}`);
    const iiif = art.config?.iiif_url ?? "https://www.artic.edu/iiif/2";
    for (const pick of (art.data ?? []).filter((x) => x.image_id && x.is_public_domain).slice(0, 2)) {
      cards.push({
        id: `aic-${pick.id}`, source: "artic", topic: "wildcard", kind: "art",
        title: pick.title,
        body: stripHtml(pick.short_description ?? "") || `${pick.artist_display ?? ""} · ${pick.date_display ?? ""}`,
        imageUrl: `${iiif}/${pick.image_id}/full/843,/0/default.jpg`,
        deepLink: `https://www.artic.edu/artworks/${pick.id}`,
        attribution: "Art Institute of Chicago · CC0",
      });
    }
  } catch (e) {
    console.error("aic failed:", e.message);
  }

  return cards;
}

export async function collectRaw() {
  const jobs = [
    ...RSS_SOURCES.map((s) => fetchRss(s).catch((e) => (console.error(`${s.id} failed:`, e.message), []))),
    fetchLobsters().catch((e) => (console.error("lobsters failed:", e.message), [])),
    fetchHn().catch((e) => (console.error("hn failed:", e.message), [])),
  ];
  const results = await Promise.all(jobs);
  return results.flat();
}

export { fetchWildcards };
