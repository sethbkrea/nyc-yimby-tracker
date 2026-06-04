// Web news lookup via Google News RSS — no API key required. Surfaces coverage
// from The Real Deal, Commercial Observer, Crain's, Bisnow, WSJ, etc., beyond
// the local YIMBY corpus.

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  date: string; // YYYY-MM-DD when parseable, else ""
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>(.*?)</${name}>`, "s"));
  return m ? decodeEntities(m[1]) : null;
}

function toIsoDate(pubDate: string | null): string {
  if (!pubDate) return "";
  const t = Date.parse(pubDate);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// The press writes numbered thoroughfares as ordinals ("711 7th Avenue"), not
// the tax format ("711 7 AVENUE"). Rewrite to the ordinal form, which is what
// Google News matches. (Unchanged for named streets like "Lexington Avenue".)
// Note: a single phrase is used rather than OR-ing both forms — Google News
// RSS suppresses all results when a zero-result phrase is OR'd in.
function ordinalizeStreet(street: string): string {
  return street.replace(
    /\b(\d+)\s+(AVENUE|AVE|STREET|ST|PLACE|PL|ROAD|RD|DRIVE|DR|BOULEVARD|BLVD)\b/gi,
    (_m, num: string, type: string) => `${ordinal(parseInt(num, 10))} ${type}`,
  );
}

/**
 * Fetch news for a property. `street` is the bare street address (no city
 * suffix); `borough` narrows the query. Returns up to `limit` items, newest
 * first as ordered by Google News.
 */
export async function fetchNews(
  street: string,
  borough: string | null,
  limit = 8,
): Promise<NewsArticle[]> {
  const q = [`"${ordinalizeStreet(street)}"`, borough ?? ""].filter(Boolean).join(" ");
  const url =
    "https://news.google.com/rss/search?" +
    new URLSearchParams({ q, hl: "en-US", gl: "US", ceid: "US:en" }).toString();

  let xml: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; YIMBYTracker/1.0)" },
      next: { revalidate: 3600 }, // news for a given address changes slowly
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return []; // network/timeout — degrade to "no web results"
  }

  const items = xml.match(/<item>(.*?)<\/item>/gs) ?? [];
  const out: NewsArticle[] = [];
  for (const block of items) {
    const source = tag(block, "source") ?? "";
    let title = tag(block, "title") ?? "";
    // Google News appends " - Source" to titles; trim it for readability.
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim();
    }
    const link = tag(block, "link") ?? "";
    if (!title || !link) continue;
    out.push({ title, url: link, source, date: toIsoDate(tag(block, "pubDate")) });
    if (out.length >= limit) break;
  }
  return out;
}
