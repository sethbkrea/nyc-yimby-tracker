import { loadArticles, type Article } from "./articles";
import { fetchNews, type NewsArticle } from "./news";
import {
  resolveProperty,
  fetchDobNow,
  fetchDobBis,
  type ResolvedProperty,
  type Permit,
} from "./dob";

export interface ArticleMatch {
  url: string;
  title?: string;
  address?: string;
  borough?: string;
  article_type?: string;
  scraped_at?: string;
  notes?: string;
}

export interface PropertyResult {
  property: ResolvedProperty;
  permits: Permit[];
  dobNowCount: number;
  dobBisCount: number;
  articles: ArticleMatch[]; // matches from the local YIMBY corpus
  news: NewsArticle[]; // web coverage via Google News (TRD, CO, Crain's, …)
}

/** Split a pasted blob / uploaded file into individual address-or-BBL lines. */
export function parseInputs(raw: string): string[] {
  return raw
    .split(/[\r\n]+/)
    .map((l) => l.replace(/^["']|["']$/g, "").trim()) // strip stray CSV quoting
    .map((l) => l.replace(/,\s*$/, "").trim())
    .filter((l) => l.length > 0)
    .filter((l, i, arr) => arr.indexOf(l) === i); // de-dupe, preserve order
}

// Normalize an address to "<housenum> <streetname>" for fuzzy article matching.
const DIRECTIONALS: Record<string, string> = {
  EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S",
};
function normAddr(s: string): string {
  let v = (s ?? "").toUpperCase();
  v = v.replace(/(\d+)(ST|ND|RD|TH)\b/g, "$1"); // 54th -> 54
  v = v.replace(/\bSTREET\b/g, "ST").replace(/\bAVENUE\b/g, "AVE");
  v = v.replace(/\bBOULEVARD\b/g, "BLVD").replace(/\bPLACE\b/g, "PL").replace(/\bROAD\b/g, "RD");
  for (const [k, abbr] of Object.entries(DIRECTIONALS)) v = v.replace(new RegExp(`\\b${k}\\b`, "g"), abbr);
  v = v.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return v;
}
function houseStreetKey(addr: string): string | null {
  const n = normAddr(addr);
  const m = n.match(/^(\d[\d-]*)\s+(.+)$/);
  return m ? `${m[1]} ${m[2]}` : null;
}

function matchArticles(address: string | null, articles: Article[]): ArticleMatch[] {
  if (!address) return [];
  // GeoSearch returns "625 MADISON AVENUE, New York, NY, USA" — keep only the
  // street portion before the first comma so the key isn't polluted by the
  // city/state/country suffix.
  const street = address.split(",")[0];
  const key = houseStreetKey(street);
  if (!key) return [];
  const out: ArticleMatch[] = [];
  for (const a of articles) {
    const fields = [a.address, a.street_address].filter(Boolean) as string[];
    const blob = normAddr(fields.join(" | "));
    if (fields.some((f) => houseStreetKey(f) === key) || blob.includes(key)) {
      out.push({
        url: a.url,
        title: a.title,
        address: a.address,
        borough: a.borough,
        article_type: a.article_type,
        scraped_at: a.scraped_at,
        notes: a.notes,
      });
    }
  }
  // De-dupe by URL.
  return out.filter((m, i, arr) => arr.findIndex((x) => x.url === m.url) === i);
}

// Drop web-news items that duplicate a local corpus match (same article, e.g.
// a YIMBY piece that appears in both), comparing on a normalized title.
function normTitle(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function dedupeNews(news: NewsArticle[], local: ArticleMatch[]): NewsArticle[] {
  const localTitles = new Set(local.map((a) => normTitle(a.title ?? "")).filter(Boolean));
  const seen = new Set<string>();
  return news.filter((n) => {
    const key = normTitle(n.title);
    if (localTitles.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The bare street portion of an address (drops ", New York, NY, USA" suffix). */
function streetOf(address: string | null, fallback: string): string {
  return (address ?? fallback).split(",")[0].trim();
}

/** Resolve and research a single input string. */
async function researchOne(input: string, articles: Article[]): Promise<PropertyResult> {
  const property = await resolveProperty(input);
  const street = streetOf(property.address, input);
  const local = matchArticles(property.address ?? input, articles);

  if (!property.bbl) {
    const news = await fetchNews(street, property.borough).catch(() => []);
    return { property, permits: [], dobNowCount: 0, dobBisCount: 0, articles: local, news: dedupeNews(news, local) };
  }
  const [now, bis, news] = await Promise.all([
    fetchDobNow(property.bbl).catch(() => []),
    fetchDobBis(property.borough, property.block, property.lot).catch(() => []),
    fetchNews(street, property.borough).catch(() => []),
  ]);
  const permits: Permit[] = [...now, ...bis].sort((a, b) =>
    (b.filingDate || "") < (a.filingDate || "") ? -1 : 1,
  );
  return {
    property,
    permits,
    dobNowCount: now.length,
    dobBisCount: bis.length,
    articles: local,
    news: dedupeNews(news, local),
  };
}

/**
 * Research a batch of inputs. Capped to keep one request bounded; the UI warns
 * when the cap is hit. Inputs run with limited concurrency to be polite to the
 * Open Data and GeoSearch endpoints.
 */
export const MAX_INPUTS = 150;

export async function researchBatch(inputs: string[]): Promise<PropertyResult[]> {
  const articles = await loadArticles().catch(() => [] as Article[]);
  const capped = inputs.slice(0, MAX_INPUTS);
  const results: PropertyResult[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < capped.length; i += CONCURRENCY) {
    const chunk = capped.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(chunk.map((inp) => researchOne(inp, articles)));
    results.push(...settled);
  }
  return results;
}
