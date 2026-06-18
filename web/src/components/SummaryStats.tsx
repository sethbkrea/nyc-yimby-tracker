"use client";

import { useEffect, useState } from "react";
import type { RelatedNews } from "./ArticlesPreview";
import { buildingKey } from "@/lib/profiles";

interface Article {
  url: string;
  scraped_at: string;
  published?: string;
  article_type?: string;
  address?: string;
  borough?: string;
  number_of_units?: number | null;
  transaction_amount?: number | null;
  buyer?: string;
  seller?: string;
  brokers?: string;
  date_of_transaction?: string;
}

const STAGE_LABEL: Record<string, string> = {
  construction_update: "Under construction",
  permit_filed: "Permits filed",
  rendering_reveal: "Rendering",
  demolition: "Demolition",
  completion: "Completed",
  lottery: "Lottery",
  approval: "Approved",
  rezoning: "Rezoning",
  financing: "Financing",
  transaction: "Transaction",
  report: "Report",
  other: "Other",
};

// Publish date (YYYY-MM-DD): captured published -> URL month -> scrape date.
function pubDay(a: Article): string {
  if (a.published) return a.published.slice(0, 10);
  const m = a.url?.match(/\/(20\d\d)\/(\d\d)\//);
  if (m) return `${m[1]}-${m[2]}-01`;
  return (a.scraped_at || "").slice(0, 10);
}

function isTransaction(a: Article): boolean {
  if (a.article_type) return a.article_type === "transaction" || a.article_type === "financing";
  return Boolean(a.transaction_amount || a.buyer || a.seller || a.brokers || a.date_of_transaction);
}

function compactMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

type Tone = "blue" | "emerald" | "violet" | "amber" | "sky" | "rose";

const TONES: Record<Tone, { accent: string; value: string }> = {
  blue: { accent: "bg-blue-500", value: "text-blue-400" },
  emerald: { accent: "bg-emerald-500", value: "text-emerald-400" },
  violet: { accent: "bg-violet-500", value: "text-violet-400" },
  amber: { accent: "bg-amber-500", value: "text-amber-400" },
  sky: { accent: "bg-sky-500", value: "text-sky-400" },
  rose: { accent: "bg-rose-500", value: "text-rose-400" },
};

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: Tone }) {
  const t = TONES[tone];
  return (
    <div className="relative overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <span className={`absolute inset-y-0 left-0 w-1 ${t.accent}`} aria-hidden />
      <div className="text-sm font-medium text-neutral-400">{label}</div>
      <div className={`mt-2 text-3xl md:text-4xl font-bold tracking-tight tabular-nums ${t.value}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function BarList({
  title,
  rows,
  accent,
}: {
  title: string;
  rows: [string, number][];
  accent: string;
}) {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500 mb-3">{title}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600">No data yet.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map(([label, n]) => (
            <div key={label} className="flex items-center gap-2 text-sm">
              <div className="w-32 shrink-0 truncate text-neutral-300" title={label}>{label}</div>
              <div className="flex-1 h-4 rounded bg-neutral-800/60 overflow-hidden">
                <div className={`h-full ${accent}`} style={{ width: `${(n / max) * 100}%` }} />
              </div>
              <div className="w-14 shrink-0 text-right tabular-nums text-neutral-400">
                {n.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  refreshSignal: number;
  relatedNews?: RelatedNews;
}

export function SummaryStats({ refreshSignal, relatedNews = {} }: Props) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/articles")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { articles: Article[] }) => {
        if (!cancelled) setArticles(d.articles);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  if (error) {
    return <p className="text-sm text-red-400">Summary unavailable: {error}</p>;
  }
  if (!articles) {
    return <div className="text-sm text-neutral-500">Loading summary…</div>;
  }

  const total = articles.length;
  const days = articles.map(pubDay).filter(Boolean).sort();
  const earliest = days[0]?.slice(0, 4) ?? "—";
  const latest = days[days.length - 1]?.slice(0, 4) ?? "—";

  const txns = articles.filter(isTransaction);
  const txVolume = txns.reduce((s, a) => s + (a.transaction_amount ?? 0), 0);
  const totalUnits = articles.reduce((s, a) => s + (a.number_of_units ?? 0), 0);
  const buildings = new Set(
    articles.map((a) => buildingKey(a.address)).filter(Boolean),
  ).size;

  const byYear = new Map<string, number>();
  const byStage = new Map<string, number>();
  const byBorough = new Map<string, number>();
  for (const a of articles) {
    const y = pubDay(a).slice(0, 4);
    if (y) byYear.set(y, (byYear.get(y) ?? 0) + 1);
    const stage = STAGE_LABEL[a.article_type ?? "other"] ?? "Other";
    byStage.set(stage, (byStage.get(stage) ?? 0) + 1);
    const b = (a.borough ?? "").trim();
    if (b) byBorough.set(b, (byBorough.get(b) ?? 0) + 1);
  }

  const yearRows = [...byYear.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const stageRows = [...byStage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const boroughRows = [...byBorough.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  // Related news: dedupe by URL across all addresses.
  const relSeen = new Set<string>();
  const relBySource = new Map<string, number>();
  for (const recs of Object.values(relatedNews)) {
    for (const r of recs) {
      if (!r.url || relSeen.has(r.url)) continue;
      relSeen.add(r.url);
      const s = (r.source || "Other").trim() || "Other";
      relBySource.set(s, (relBySource.get(s) ?? 0) + 1);
    }
  }
  const relatedTotal = relSeen.size;
  const outletCount = relBySource.size;

  return (
    <section className="grid gap-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard tone="blue" label="YIMBY Articles" value={total.toLocaleString()} sub={`${earliest}–${latest} coverage`} />
        <StatCard tone="emerald" label="Buildings Tracked" value={buildings.toLocaleString()} sub="distinct properties" />
        <StatCard tone="violet" label="Units Tracked" value={totalUnits.toLocaleString()} sub="sum of reported units" />
        <StatCard tone="amber" label="Transactions" value={txns.length.toLocaleString()} sub="deal & financing articles" />
        <StatCard tone="sky" label="Deal Volume" value={txVolume > 0 ? compactMoney(txVolume) : "—"} sub="total reported $" />
        <StatCard tone="rose" label="Related News" value={relatedTotal.toLocaleString()} sub={`${outletCount} outlets`} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <BarList title="Articles by year" rows={yearRows} accent="bg-emerald-500/70" />
        <BarList title="By project stage" rows={stageRows} accent="bg-sky-500/70" />
        <BarList title="By borough" rows={boroughRows} accent="bg-violet-500/70" />
      </div>
    </section>
  );
}
