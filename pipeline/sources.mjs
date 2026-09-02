import { XMLParser } from "fast-xml-parser";

const UA = "DailyDeck/0.1 (personal knowledge feed; +https://github.com/adityasingh-io/daily-deck)";
/* Some publishers (RBI, Business Standard, BusinessLine) 403 non-browser UAs. */
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TIMEOUT = 25000;

async function get(url, type = "json", ua = UA) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { "User-Agent": ua }, signal: ctrl.signal, redirect: "follow" });
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
  // psychology — the spine, supplied accordingly
  { id: "psypost",       url: "https://www.psypost.org/feed",                     topic: "psych",      take: 8, fullInFeed: true,  attribution: "PsyPost" },
  { id: "psyche",        url: "https://psyche.co/feed.rss",                       topic: "psych",      take: 4, fullInFeed: false, attribution: "Psyche (Aeon)" },
  { id: "exp-history",   url: "https://www.experimental-history.com/feed",        topic: "psych",      take: 2, fullInFeed: true,  attribution: "Experimental History" },
  { id: "nautilus",      url: "https://nautil.us/feed",                           topic: "psych",      take: 4, fullInFeed: false, attribution: "Nautilus" },
  { id: "intrinsic",     url: "https://www.theintrinsicperspective.com/feed",     topic: "psych",      take: 2, fullInFeed: true,  attribution: "The Intrinsic Perspective" },
  { id: "ness-labs",     url: "https://nesslabs.com/feed",                        topic: "psych",      take: 2, fullInFeed: true,  attribution: "Ness Labs" },
  { id: "acx",           url: "https://www.astralcodexten.com/feed",              topic: "psych",      take: 3, fullInFeed: true,  attribution: "Astral Codex Ten" },
  { id: "sd-mind",       url: "https://www.sciencedaily.com/rss/mind_brain.xml",  topic: "psych",      take: 5, fullInFeed: false, attribution: "ScienceDaily" },
  { id: "knowable",      url: "https://knowablemagazine.org/rss",                 topic: "psych",      take: 3, fullInFeed: false, attribution: "Knowable Magazine" },
  { id: "behavioral-sci",url: "https://behavioralscientist.org/feed/",            topic: "psych",      take: 2, fullInFeed: true,  attribution: "Behavioral Scientist" },
  { id: "neuro-news",    url: "https://neurosciencenews.com/feed/",               topic: "psych",      take: 4, fullInFeed: false, attribution: "Neuroscience News" },
  { id: "tinybuddha",    url: "https://tinybuddha.com/feed/",                     topic: "psych",      take: 2, fullInFeed: true,  attribution: "Tiny Buddha" },
  { id: "transmitter",   url: "https://www.thetransmitter.org/feed/",             topic: "psych",      take: 3, fullInFeed: false, attribution: "The Transmitter" },
  { id: "conv-psych",    url: "https://theconversation.com/topics/psychology-28/articles.atom", topic: "psych", take: 3, fullInFeed: true, attribution: "The Conversation" },
  { id: "conv-neuro",    url: "https://theconversation.com/topics/neuroscience-427/articles.atom", topic: "psych", take: 2, fullInFeed: true, attribution: "The Conversation" },
  { id: "small-potatoes",url: "https://smallpotatoes.paulbloom.net/feed",         topic: "psych",      take: 2, fullInFeed: true,  attribution: "Small Potatoes (Paul Bloom)" },
  { id: "mit-neuro",     url: "https://news.mit.edu/rss/topic/neuroscience",      topic: "psych",      take: 2, fullInFeed: true,  attribution: "MIT News" },
  { id: "splintered",    url: "https://schwitzsplinters.blogspot.com/feeds/posts/default?alt=rss", topic: "psych", take: 2, fullInFeed: true, attribution: "The Splintered Mind" },
  { id: "mind-matter",   url: "https://mindandmatter.substack.com/feed",          topic: "psych",      take: 2, fullInFeed: true,  attribution: "Mind & Matter" },
  { id: "rob-henderson", url: "https://www.robkhenderson.com/feed",               topic: "psych",      take: 2, fullInFeed: true,  attribution: "Rob Henderson" },
  // philosophy & books
  { id: "phil-break",    url: "https://philosophybreak.com/rss.xml",              topic: "philosophy", take: 4, fullInFeed: false, attribution: "Philosophy Break" },
  { id: "aeon",          url: "https://aeon.co/feed.rss",                         topic: "philosophy", take: 3, fullInFeed: false, attribution: "Aeon" },
  { id: "daily-phil",    url: "https://daily-philosophy.com/index.xml",           topic: "philosophy", take: 3, fullInFeed: true,  attribution: "Daily Philosophy" },
  { id: "marginalian",   url: "https://www.themarginalian.org/feed/",             topic: "books",      take: 3, fullInFeed: true,  attribution: "The Marginalian" },
  { id: "3quarks",       url: "https://3quarksdaily.com/feed",                    topic: "philosophy", take: 3, fullInFeed: true,  attribution: "3 Quarks Daily" },
  { id: "pd-review",     url: "https://publicdomainreview.org/rss.xml",           topic: "books",      take: 2, fullInFeed: true,  attribution: "The Public Domain Review" },
  { id: "epoche",        url: "https://epochemagazine.org/feed/",                 topic: "philosophy", take: 3, fullInFeed: true,  attribution: "Epoché Magazine" },
  { id: "ndpr",          url: "https://ndpr.nd.edu/reviews.rss",                  topic: "philosophy", take: 2, fullInFeed: true,  attribution: "Notre Dame Philosophical Reviews" },
  { id: "the-point",     url: "https://thepointmag.com/feed/",                    topic: "philosophy", take: 2, fullInFeed: false, attribution: "The Point" },
  { id: "iai",           url: "https://iai.tv/articles-proxy/rss",                topic: "philosophy", take: 3, fullInFeed: false, attribution: "IAI News" },
  { id: "five-books",    url: "https://fivebooks.com/feed/",                      topic: "books",      take: 2, fullInFeed: false, attribution: "Five Books" },
  { id: "paris-review",  url: "https://www.theparisreview.org/blog/feed/",        topic: "books",      take: 2, fullInFeed: true,  attribution: "The Paris Review" },
  // the citizen's briefing (info register)
  { id: "semafor",       url: "https://www.semafor.com/rss.xml",                  topic: "world",      take: 6, fullInFeed: true,  attribution: "Semafor" },
  { id: "wotr",          url: "https://warontherocks.com/feed/",                  topic: "world",      take: 2, fullInFeed: false, attribution: "War on the Rocks" },
  { id: "bbc-world",     url: "https://feeds.bbci.co.uk/news/world/rss.xml",      topic: "world",      take: 5, fullInFeed: false, attribution: "BBC News" },
  { id: "marginal-rev",  url: "https://marginalrevolution.com/feed",              topic: "econ",       take: 4, fullInFeed: true,  attribution: "Marginal Revolution" },
  { id: "et-economy",    url: "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", topic: "econ", take: 5, fullInFeed: false, attribution: "The Economic Times" },
  { id: "mint-economy",  url: "https://www.livemint.com/rss/economy",             topic: "econ",       take: 4, fullInFeed: false, attribution: "Mint" },
  { id: "finshots",      url: "https://finshots.in/rss/",                         topic: "econ",       take: 3, fullInFeed: true,  attribution: "Finshots" },
  { id: "zconnect",      url: "https://zerodha.com/z-connect/feed",               topic: "econ",       take: 2, fullInFeed: true,  attribution: "Z-Connect (Zerodha)" },
  { id: "rbi-press",     url: "https://www.rbi.org.in/pressreleases_rss.xml",     topic: "econ",       take: 3, fullInFeed: true,  browserUa: true, attribution: "Reserve Bank of India" },
  { id: "rbi-speeches",  url: "https://www.rbi.org.in/speeches_rss.xml",          topic: "econ",       take: 1, fullInFeed: true,  browserUa: true, attribution: "RBI Speeches" },
  { id: "leap-blog",     url: "https://blog.theleapjournal.org/feeds/posts/default", topic: "econ",    take: 2, fullInFeed: true,  attribution: "The Leap Blog" },
  { id: "anticipating",  url: "https://publicpolicy.substack.com/feed",           topic: "econ",       take: 1, fullInFeed: true,  attribution: "Anticipating the Unintended" },
  { id: "biz-standard",  url: "https://www.business-standard.com/rss/economy-102.rss", topic: "econ",  take: 4, fullInFeed: false, browserUa: true, attribution: "Business Standard" },
  { id: "voxeu",         url: "https://cepr.org/rss/vox-content",                 topic: "econ",       take: 3, fullInFeed: false, attribution: "VoxEU (CEPR)" },
  { id: "noahpinion",    url: "https://www.noahpinion.blog/feed",                 topic: "econ",       take: 2, fullInFeed: true,  attribution: "Noahpinion" },
  { id: "import-ai",     url: "https://importai.substack.com/feed",               topic: "tech-ai",    take: 2, fullInFeed: true,  attribution: "Import AI" },
  { id: "one-useful",    url: "https://www.oneusefulthing.org/feed",              topic: "tech-ai",    take: 2, fullInFeed: true,  attribution: "One Useful Thing" },
];

async function fetchRss(src) {
  const raw = await get(src.url, "text", src.browserUa ? BROWSER_UA : UA);
  return normalizeFeedItems(xml.parse(raw))
    .filter((it) => it.title && it.link)
    .slice(0, src.take)
    .map((it) => ({
      ...it,
      // IAI's feed emits links missing the slash after the domain
      link: String(it.link).replace(/^(https?:\/\/[^/\s]+?\.[a-z]+)(?=[^/.])/i, "$1/"),
      source: src.id,
      topic: src.topic,
      attribution: src.attribution,
      fullInFeed: src.fullInFeed,
      text: it.text.slice(0, src.fullInFeed ? 24000 : 1600),
    }));
}

/* Tech-fact suppliers: link aggregators kept for genuinely fascinating
   technical FACTS (info register), not tutorials or release news —
   triage + charter handle that filtering. */
async function fetchLobstersHn() {
  const out = [];
  try {
    const items = await get("https://lobste.rs/hottest.json");
    out.push(
      ...items.slice(0, 5).map((s) => ({
        source: "lobsters",
        topic: "tech-ai",
        attribution: "via Lobsters",
        title: s.title,
        link: s.url || s.comments_url,
        text: stripHtml(s.description_plain ?? s.description ?? "").slice(0, 800) || `${s.score} points on Lobsters, tags: ${(s.tags ?? []).join(", ")}`,
        published: s.created_at,
      }))
    );
  } catch (e) {
    console.error("lobsters failed:", e.message);
  }
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
    const data = await get(`https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E150,created_at_i%3E${cutoff}&hitsPerPage=12`);
    out.push(
      ...(data.hits ?? []).slice(0, 8).map((h) => ({
        source: "hackernews",
        topic: "tech-ai",
        attribution: "via Hacker News",
        title: h.title,
        link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        text: `${h.points} points, ${h.num_comments} comments on Hacker News. ${stripHtml(h.story_text ?? "").slice(0, 400)}`,
        published: h.created_at,
      }))
    );
  } catch (e) {
    console.error("hn failed:", e.message);
  }
  return out;
}

/* Daily India data card: a rotating FRED series with its real chart image.
   fredgraph.csv/png are public endpoints — no API key needed. */
const FRED_INDIA = [
  { id: "INDCPIALLMINMEI", name: "India consumer price index (inflation)" },
  { id: "DEXINUS", name: "Indian rupees per US dollar (exchange rate)" },
  { id: "INDPROINDMISMEI", name: "India industrial production" },
];

async function fetchFredIndia() {
  const pick = FRED_INDIA[new Date().getDate() % FRED_INDIA.length];
  const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${pick.id}`, "text");
  const rows = csv.trim().split("\n").slice(1).filter((r) => !r.includes("."));
  const recent = csv.trim().split("\n").slice(-26).join("\n");
  if (!rows && !recent) throw new Error("empty series");
  return {
    source: "fred-india",
    topic: "econ",
    attribution: "FRED · St. Louis Fed",
    title: `Data: ${pick.name}`,
    link: `https://fred.stlouisfed.org/series/${pick.id}`,
    image: `https://fred.stlouisfed.org/graph/fredgraph.png?id=${pick.id}`,
    fullInFeed: true,
    text: `Economic data series: ${pick.name} (FRED series ${pick.id}). The most recent observations, as CSV (date,value):\n${recent}\n\nWrite this as a short info card: what the number is, where it stands now, how it has moved recently, and what that means for an Indian reader. The card's image is the actual chart.`,
    published: new Date().toISOString(),
  };
}

/* Naive readability: for teaser feeds, pull the article page and keep the
   substantial <p> blocks. Good enough as LLM input; never shown raw.
   Lessons from live testing: pages can contain several <article> tags (pick
   the longest), and some bury body text outside <article> entirely (fall
   back to whole-page <p> extraction). */
export async function fetchArticleMeta(url) {
  const html = await get(url, "text", BROWSER_UA);
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


export async function collectRaw() {
  const jobs = [
    ...RSS_SOURCES.map((s) => fetchRss(s).catch((e) => (console.error(`${s.id} failed:`, e.message), []))),
    fetchLobstersHn(),
    fetchFredIndia()
      .then((item) => [item])
      .catch((e) => (console.error("fred-india failed:", e.message), [])),
  ];
  const results = await Promise.all(jobs);
  return results.flat();
}
