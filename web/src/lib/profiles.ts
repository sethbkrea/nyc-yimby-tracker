// Group individual articles into per-building "property profiles" so all
// coverage of the same building (permits → rendering → construction →
// completion) lives under one record. Pure + client-safe.

import type { Article } from "./articles";

export interface ProfileArticle {
  url: string;
  title: string;
  date: string; // YYYY-MM-DD
  stage: string; // article_type
  units: number | null;
}

export interface PropertyProfile {
  key: string;
  address: string;
  borough: string;
  neighborhood: string;
  developer: string;
  architect: string;
  type: string; // residential / mixed-use / …
  units: number | null; // max stated across articles
  stories: number | null;
  squareFootage: number | null;
  latestStage: string; // article_type of the newest article
  firstDate: string;
  latestDate: string;
  articleCount: number;
  articles: ProfileArticle[]; // newest first
}

const DIRECTIONALS: Record<string, string> = { EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S" };

/** Normalize an address to "<house> <street>" for grouping. "" if no number. */
export function buildingKey(addr?: string): string {
  let v = (addr ?? "").toUpperCase();
  v = v.replace(/(\d+)(ST|ND|RD|TH)\b/g, "$1");
  v = v.replace(/\bSTREET\b/g, "ST").replace(/\bAVENUE\b/g, "AVE")
       .replace(/\bBOULEVARD\b/g, "BLVD").replace(/\bPLACE\b/g, "PL").replace(/\bROAD\b/g, "RD");
  for (const [k, abbr] of Object.entries(DIRECTIONALS)) v = v.replace(new RegExp(`\\b${k}\\b`, "g"), abbr);
  v = v.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const m = v.match(/^(\d[\d-]*)\s+(.+)$/);
  return m ? `${m[1]} ${m[2]}` : "";
}

// Derive a readable title from a YIMBY URL slug for the few articles lacking one.
function titleFromUrl(url: string): string {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const words = slug.replace(/\.html?$/, "").replace(/-/g, " ").trim();
    return words ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : url;
  } catch {
    return url;
  }
}

const day = (s?: string) => (s ?? "").slice(0, 10);
function maxNum(a: number | null, b?: number | null): number | null {
  if (b == null) return a;
  if (a == null) return b;
  return Math.max(a, b);
}
// Prefer the cleanest display address: starts with a number, then shortest.
function betterAddress(a: string, b: string): string {
  const an = /^\d/.test(a), bn = /^\d/.test(b);
  if (an !== bn) return an ? a : b;
  return a.length <= b.length ? a : b;
}

export function groupIntoProfiles(articles: Article[]): PropertyProfile[] {
  const groups = new Map<string, Article[]>();
  for (const a of articles) {
    const key = buildingKey(a.address) || buildingKey(a.street_address);
    if (!key) continue; // no address → can't attribute to a building
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }

  const profiles: PropertyProfile[] = [];
  for (const [key, arts] of groups) {
    const sorted = [...arts].sort((x, y) => (day(y.scraped_at) < day(x.scraped_at) ? -1 : 1));
    const newest = sorted[0];

    // Pick best non-empty value, preferring the newest article.
    const pick = (f: (a: Article) => string | undefined): string => {
      for (const a of sorted) { const v = (f(a) ?? "").trim(); if (v) return v; }
      return "";
    };

    let address = "";
    for (const a of arts) {
      const cand = (a.address || a.street_address || "").trim();
      if (cand) address = address ? betterAddress(address, cand) : cand;
    }

    profiles.push({
      key,
      address: address || key,
      borough: pick((a) => a.borough),
      neighborhood: pick((a) => a.neighborhood),
      developer: pick((a) => a.developer),
      architect: pick((a) => a.architect),
      type: pick((a) => a.type),
      units: arts.reduce<number | null>((m, a) => maxNum(m, a.number_of_units), null),
      stories: arts.reduce<number | null>((m, a) => maxNum(m, a.stories), null),
      squareFootage: arts.reduce<number | null>((m, a) => maxNum(m, a.square_footage), null),
      latestStage: newest.article_type ?? "",
      firstDate: day(sorted[sorted.length - 1].scraped_at),
      latestDate: day(newest.scraped_at),
      articleCount: arts.length,
      articles: sorted.map((a) => ({
        url: a.url,
        title: (a.title ?? "").trim() || titleFromUrl(a.url),
        date: day(a.scraped_at),
        stage: a.article_type ?? "",
        units: a.number_of_units ?? null,
      })),
    });
  }

  // Most-covered buildings first, then most recent activity.
  profiles.sort((a, b) =>
    b.articleCount - a.articleCount || (a.latestDate < b.latestDate ? 1 : -1),
  );
  return profiles;
}
