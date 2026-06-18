"use client";

import { useEffect, useState, useCallback } from "react";
import { toCsv, downloadText } from "@/lib/csv";
import type { Run } from "./RunsTable";

interface Article {
  url: string;
  scraped_at: string;
  published?: string;
  article_type?: string;
  address?: string;
  street_address?: string;
  neighborhood?: string;
  borough?: string;
  type?: string;
  developer?: string;
  architect?: string;
  number_of_units?: number | null;
  square_footage?: number | null;
  stories?: number | null;
  height_ft?: number | null;
  transaction_amount?: number | null;
  price_per_unit?: number | null;
  price_per_square_foot?: number | null;
  buyer?: string;
  seller?: string;
  brokers?: string;
  date_of_transaction?: string;
  notes?: string;
}

// The article's PUBLISH date (not the scrape/pull date), as YYYY-MM-DD.
// Prefers the captured `published` field; falls back to the publish month from
// the YIMBY URL (/YYYY/MM/ -> YYYY-MM-01); last resort is the scrape date.
// Kept in sync with pubDay() in lib/profiles.ts so the Articles list and the
// Properties tab agree on what "when" means for a historical/backfilled article.
function pubDay(a: Article): string {
  if (a.published) return a.published.slice(0, 10);
  const m = a.url?.match(/\/(20\d\d)\/(\d\d)\//);
  if (m) return `${m[1]}-${m[2]}-01`;
  return (a.scraped_at || "").slice(0, 10);
}

function isTransaction(a: Article): boolean {
  // Use the LLM-assigned classification when available; fall back to
  // "any transaction field populated" for legacy records.
  if (a.article_type) {
    return a.article_type === "transaction" || a.article_type === "financing";
  }
  return Boolean(
    a.transaction_amount || a.buyer || a.seller || a.brokers || a.date_of_transaction,
  );
}

function fmtMoney(n?: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString()}`;
}

function fmtNum(n?: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function blank(s?: string): string {
  return s && s.trim() ? s : "—";
}

// Human-readable lifecycle stage from the LLM-assigned article_type. Used so a
// row's unit count can be read against its stage (e.g. units "Under construction").
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
  other: "—",
};
function stageLabel(t?: string): string {
  return (t && STAGE_LABEL[t]) || "—";
}

export interface RelatedRecord {
  address: string;
  title: string;
  url: string;
  source: string;
  published: string;
  snippet: string;
}

export type RelatedNews = Record<string, RelatedRecord[]>;

interface Props {
  refreshSignal: number;
  runs: Run[];
  relatedNews?: RelatedNews;
}

export function ArticlesPreview({ refreshSignal, runs, relatedNews = {} }: Props) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, _setTab] = useState<"development" | "transaction">("development");
  const [pageSize, _setPageSize] = useState<number>(50);
  const [page, setPage] = useState<number>(0);  // 0-indexed
  // Filters
  const [fromDate, _setFromDate] = useState<string>("");  // YYYY-MM-DD or ""
  const [toDate, _setToDate] = useState<string>("");
  const [query, _setQuery] = useState<string>("");
  // Which row's "Related" panel is expanded.
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);
  // Bulk selection (keyed by article url, value is the article's address).
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Reset to page 0 whenever the visible slice would change underneath us.
  const setTab = (t: "development" | "transaction") => {
    _setTab(t);
    setPage(0);
  };
  const setQuery = (s: string) => {
    _setQuery(s);
    setPage(0);
  };
  const setPageSize = (n: number) => {
    _setPageSize(n);
    setPage(0);
  };
  const setFromDate = (d: string) => {
    _setFromDate(d);
    setPage(0);
  };
  const setToDate = (d: string) => {
    _setToDate(d);
    setPage(0);
  };

  // Dedupe to unique addresses for bulk lookup so we don't re-query the same
  // address when multiple articles share it.
  const selectedAddresses = Array.from(
    new Set(Object.values(selected).filter((a) => a && a.trim().length > 0)),
  );

  function toggleSelect(article: Article) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[article.url]) delete next[article.url];
      else next[article.url] = (article.address ?? "").trim();
      return next;
    });
  }

  function clearSelection() {
    setSelected({});
  }

  async function lookupNewsForSelected(sources: "google,gdelt" | "gdelt" | "google") {
    if (selectedAddresses.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflow: "enrich-news.yml",
          inputs: {
            addresses: selectedAddresses.join("||"),
            sources,
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setBulkMsg({
        kind: "ok",
        text: `Dispatched news lookup for ${selectedAddresses.length} address${selectedAddresses.length === 1 ? "" : "es"}. Watch Recent runs for status; the Related column updates when the workflow commits.`,
      });
      clearSelection();
    } catch (err) {
      setBulkMsg({
        kind: "err",
        text: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBulkBusy(false);
    }
  }

  // Quick-pick presets in local time.
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const applyPreset = (preset: "today" | "7d" | "30d" | "all") => {
    if (preset === "today") {
      setFromDate(todayStr);
      setToDate(todayStr);
    } else if (preset === "7d") {
      setFromDate(daysAgo(7));
      setToDate(todayStr);
    } else if (preset === "30d") {
      setFromDate(daysAgo(30));
      setToDate(todayStr);
    } else {
      setFromDate("");
      setToDate("");
    }
  };

  // When the user picks a specific run from the dropdown, narrow the filter to
  // that run's date (scraped_at is timestamped at run start, so all records
  // from one run share the same day; close enough for "filter by run").
  const applyRunFilter = (runDate: string) => {
    if (!runDate) {
      setFromDate("");
      setToDate("");
      return;
    }
    setFromDate(runDate);
    setToDate(runDate);
  };

  // Runs that actually added records, for the filter dropdown.
  const filterableRuns = runs.filter(
    (r) => r.articlesAdded !== null && (r.articlesAdded ?? 0) > 0,
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { articles: Article[]; total: number };
      setArticles(data.articles);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  // Apply date + text filters to the *base* set so tab counts reflect what's
  // visible under the current filters.
  const needle = query.trim().toLowerCase();
  const matchesQuery = (a: Article): boolean => {
    if (!needle) return true;
    const hay = [
      a.address, a.street_address, a.neighborhood, a.borough, a.type,
      a.developer, a.architect, a.buyer, a.seller, a.brokers,
      a.article_type, a.notes, a.url,
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(needle);
  };
  // Order by publish date (newest first) so backfilled/historical articles land
  // in their true time period instead of all clustering at their scrape date.
  const byPubDate = [...(articles ?? [])].sort((a, b) =>
    pubDay(a) < pubDay(b) ? 1 : pubDay(a) > pubDay(b) ? -1 : 0,
  );
  const dateFiltered = byPubDate.filter((a) => {
    if (!matchesQuery(a)) return false;
    if (!fromDate && !toDate) return true;
    const d = pubDay(a);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });

  const txCount = dateFiltered.filter(isTransaction).length;
  const devCount = dateFiltered.length - txCount;

  const filtered = dateFiltered.filter((a) =>
    tab === "transaction" ? isTransaction(a) : !isTransaction(a),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);  // clamp if data shrank
  const sliceStart = safePage * pageSize;
  const sliceEnd = sliceStart + pageSize;
  const visible = filtered.slice(sliceStart, sliceEnd);

  function exportCsv() {
    const today = new Date().toISOString().slice(0, 10);
    if (tab === "development") {
      const header = [
        "url", "scraped_at", "article_type", "address", "street_address",
        "neighborhood", "borough", "type", "number_of_units", "square_footage",
        "stories", "height_ft", "developer", "architect", "notes",
      ];
      const rows: (string | number | null | undefined)[][] = [header];
      for (const a of filtered) {
        rows.push([
          a.url, a.scraped_at, a.article_type, a.address, a.street_address,
          a.neighborhood, a.borough, a.type, a.number_of_units, a.square_footage,
          a.stories, a.height_ft, a.developer, a.architect, a.notes,
        ]);
      }
      downloadText(`yimby-development-${today}.csv`, toCsv(rows));
    } else {
      const header = [
        "url", "scraped_at", "article_type", "address", "street_address",
        "neighborhood", "borough", "transaction_amount", "price_per_unit",
        "price_per_square_foot", "buyer", "seller", "brokers",
        "date_of_transaction", "notes",
      ];
      const rows: (string | number | null | undefined)[][] = [header];
      for (const a of filtered) {
        rows.push([
          a.url, a.scraped_at, a.article_type, a.address, a.street_address,
          a.neighborhood, a.borough, a.transaction_amount, a.price_per_unit,
          a.price_per_square_foot, a.buyer, a.seller, a.brokers,
          a.date_of_transaction, a.notes,
        ]);
      }
      downloadText(`yimby-transactions-${today}.csv`, toCsv(rows));
    }
  }

  function exportWithNewsCsv() {
    const today = new Date().toISOString().slice(0, 10);
    // Denormalized: one row per (property × related-article) pair. Properties
    // with no related news get one row with empty related-* columns so they
    // still show up in the export.
    const header = [
      "url", "scraped_at", "article_type",
      "address", "street_address", "neighborhood", "borough",
      "type", "developer", "architect",
      "number_of_units", "square_footage", "stories", "height_ft",
      "transaction_amount", "price_per_unit", "price_per_square_foot",
      "buyer", "seller", "brokers", "date_of_transaction",
      "notes",
      // Related news fields:
      "related_title", "related_source", "related_url", "related_published",
    ];
    const rows: (string | number | null | undefined)[][] = [header];
    for (const a of dateFiltered) {
      const baseCols: (string | number | null | undefined)[] = [
        a.url, a.scraped_at, a.article_type,
        a.address, a.street_address, a.neighborhood, a.borough,
        a.type, a.developer, a.architect,
        a.number_of_units, a.square_footage, a.stories, a.height_ft,
        a.transaction_amount, a.price_per_unit, a.price_per_square_foot,
        a.buyer, a.seller, a.brokers, a.date_of_transaction,
        a.notes,
      ];
      const related = (a.address && relatedNews[a.address]) || [];
      if (related.length === 0) {
        rows.push([...baseCols, "", "", "", ""]);
      } else {
        for (const r of related) {
          rows.push([...baseCols, r.title, r.source, r.url, r.published]);
        }
      }
    }
    downloadText(`yimby-with-news-${today}.csv`, toCsv(rows));
  }

  function exportAllCsv() {
    const today = new Date().toISOString().slice(0, 10);
    // Union of every field across both schemas — one row per article, blank
    // wherever a column doesn't apply (e.g. transaction fields on a permit article).
    const header = [
      "url", "scraped_at", "article_type",
      "address", "street_address", "neighborhood", "borough",
      "type", "developer", "architect",
      "number_of_units", "square_footage", "stories", "height_ft",
      "transaction_amount", "price_per_unit", "price_per_square_foot",
      "buyer", "seller", "brokers", "date_of_transaction",
      "notes",
    ];
    const rows: (string | number | null | undefined)[][] = [header];
    // 'All' button respects the date filter (so users can export a slice
    // across both tabs without re-filtering elsewhere).
    for (const a of dateFiltered) {
      rows.push([
        a.url, a.scraped_at, a.article_type,
        a.address, a.street_address, a.neighborhood, a.borough,
        a.type, a.developer, a.architect,
        a.number_of_units, a.square_footage, a.stories, a.height_ft,
        a.transaction_amount, a.price_per_unit, a.price_per_square_foot,
        a.buyer, a.seller, a.brokers, a.date_of_transaction,
        a.notes,
      ]);
    }
    downloadText(`yimby-all-${today}.csv`, toCsv(rows));
  }

  // Source breakdown. The main corpus is all scraped from YIMBY; "related news"
  // is discovered via Google News / GDELT and attributed to real outlets.
  // Dedupe related records by URL (the same story can attach to many addresses).
  const relatedUnique = new Map<string, RelatedRecord>();
  for (const recs of Object.values(relatedNews)) {
    for (const r of recs) if (r.url) relatedUnique.set(r.url, r);
  }
  const relatedBySource = new Map<string, number>();
  for (const r of relatedUnique.values()) {
    const s = (r.source || "Other").trim() || "Other";
    relatedBySource.set(s, (relatedBySource.get(s) ?? 0) + 1);
  }
  const topSources = [...relatedBySource.entries()].sort((a, b) => b[1] - a[1]);
  const relatedTotal = relatedUnique.size;

  return (
    <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Articles</h2>
        {total !== null && (
          <span className="text-sm text-neutral-400">
            {dateFiltered.length.toLocaleString()}
            {(fromDate || toDate || needle) && ` of ${total.toLocaleString()}`}
            {!fromDate && !toDate && !needle && " total"}
          </span>
        )}
      </div>

      {/* Source breakdown */}
      {total !== null && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-500">Sources:</span>
          <span
            className="rounded-full bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 px-2 py-0.5"
            title="Primary feed — all articles scraped from newyorkyimby.com"
          >
            YIMBY {total.toLocaleString()}
          </span>
          <span
            className="rounded-full bg-sky-950/60 border border-sky-800/60 text-sky-300 px-2 py-0.5"
            title="Related news discovered via Google News / GDELT, deduped by URL"
          >
            Related news {relatedTotal.toLocaleString()}
            {topSources.length > 0 && ` · ${topSources.length} outlets`}
          </span>
          {topSources.slice(0, 4).map(([src, n]) => (
            <span key={src} className="rounded-full bg-neutral-800/70 border border-neutral-700 text-neutral-300 px-2 py-0.5">
              {src} {n.toLocaleString()}
            </span>
          ))}
          {topSources.length > 4 && (
            <span className="text-neutral-500">+{topSources.length - 4} more</span>
          )}
        </div>
      )}

      {/* Search */}
      <div className="mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search address, developer, architect, neighborhood, buyer/seller…"
          className="w-full rounded-md bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
        <span className="text-neutral-500">Filter:</span>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-neutral-300"
          aria-label="From date"
        />
        <span className="text-neutral-600">→</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-neutral-300"
          aria-label="To date"
        />
        <button
          onClick={() => applyPreset("today")}
          className="px-2 py-1 rounded border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600"
        >
          Today
        </button>
        <button
          onClick={() => applyPreset("7d")}
          className="px-2 py-1 rounded border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600"
        >
          Last 7 days
        </button>
        <button
          onClick={() => applyPreset("30d")}
          className="px-2 py-1 rounded border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600"
        >
          Last 30 days
        </button>
        {(fromDate || toDate) && (
          <button
            onClick={() => applyPreset("all")}
            className="px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:text-white hover:border-amber-500"
          >
            Clear ×
          </button>
        )}
        {filterableRuns.length > 0 && (
          <label className="flex items-center gap-1 text-neutral-500 ml-2">
            <span>or scrape run:</span>
            <select
              onChange={(e) => applyRunFilter(e.target.value)}
              value={fromDate && fromDate === toDate ? fromDate : ""}
              className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-neutral-300"
              aria-label="Filter by scrape run"
            >
              <option value="">— pick a run —</option>
              {filterableRuns.map((r) => {
                const d = (r.createdAt || "").slice(0, 10);
                return (
                  <option key={r.id} value={d}>
                    {d} · +{r.articlesAdded} {r.event === "schedule" ? "(daily)" : "(manual)"}
                  </option>
                );
              })}
            </select>
          </label>
        )}
      </div>

      {selectedAddresses.length > 0 && (
        <div className="mb-4 p-3 rounded-lg border border-sky-500/40 bg-sky-500/10 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-sky-200 font-medium">
            {selectedAddresses.length} address{selectedAddresses.length === 1 ? "" : "es"} selected
          </span>
          <span className="text-neutral-400 text-xs">·</span>
          <button
            onClick={() => lookupNewsForSelected("google,gdelt")}
            disabled={bulkBusy}
            className="px-3 py-1 rounded bg-sky-500 text-black font-medium hover:bg-sky-400 disabled:opacity-50"
            title="Run Google News RSS + GDELT for the selected addresses"
          >
            {bulkBusy ? "Dispatching…" : "Look up news (all sources)"}
          </button>
          <button
            onClick={() => lookupNewsForSelected("gdelt")}
            disabled={bulkBusy}
            className="px-3 py-1 rounded border border-sky-500/40 text-sky-200 hover:border-sky-500 disabled:opacity-50"
            title="GDELT only — historical (2015+) coverage from any outlet"
          >
            GDELT only
          </button>
          <button
            onClick={clearSelection}
            disabled={bulkBusy}
            className="ml-auto text-xs text-neutral-400 hover:text-white"
          >
            Clear selection ×
          </button>
        </div>
      )}
      {bulkMsg && (
        <p
          className={`mb-3 text-sm ${
            bulkMsg.kind === "err" ? "text-red-400" : "text-emerald-300"
          }`}
        >
          {bulkMsg.text}
        </p>
      )}

      <div className="flex gap-2 mb-4 text-sm items-center">
        <button
          onClick={() => setTab("development")}
          className={`px-3 py-1 rounded ${
            tab === "development"
              ? "bg-neutral-800 text-white"
              : "text-neutral-400 hover:text-white"
          }`}
        >
          Development ({devCount.toLocaleString()})
        </button>
        <button
          onClick={() => setTab("transaction")}
          className={`px-3 py-1 rounded ${
            tab === "transaction"
              ? "bg-neutral-800 text-white"
              : "text-neutral-400 hover:text-white"
          }`}
        >
          Transactions ({txCount.toLocaleString()})
        </button>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-neutral-500">
            Show
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="ml-1 bg-neutral-950 border border-neutral-800 rounded px-1.5 py-0.5 text-neutral-300"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={1000}>1000</option>
            </select>
          </label>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="px-3 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-50"
            title={`Download all ${filtered.length} ${tab} records as CSV`}
          >
            ⬇ {tab === "development" ? "Dev" : "Tx"} ({filtered.length})
          </button>
          <button
            onClick={exportAllCsv}
            disabled={(articles ?? []).length === 0}
            className="px-3 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-50"
            title="Download every record (both tabs) with the union of all columns"
          >
            ⬇ All ({dateFiltered.length.toLocaleString()})
          </button>
          <button
            onClick={exportWithNewsCsv}
            disabled={(articles ?? []).length === 0}
            className="px-3 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-50"
            title="Download every property joined to its related news (one row per property × related article). Properties with no related news still appear once."
          >
            ⬇ With news
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">Error: {error}</p>}
      {articles === null && !error && <p className="text-sm text-neutral-500">Loading…</p>}
      {articles && articles.length === 0 && (
        <p className="text-sm text-neutral-500">No articles yet. Run a scrape above.</p>
      )}

      {articles && articles.length > 0 && tab === "development" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-400">
              <tr>
                <th className="py-1.5 pr-2 font-normal w-6">
                  <input
                    type="checkbox"
                    aria-label="Select all visible rows"
                    checked={visible.length > 0 && visible.every((a) => selected[a.url])}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSelected((prev) => {
                        const next = { ...prev };
                        for (const a of visible) {
                          if (checked) next[a.url] = (a.address ?? "").trim();
                          else delete next[a.url];
                        }
                        return next;
                      });
                    }}
                  />
                </th>
                <th className="py-1.5 pr-3 font-normal">Date</th>
                <th className="py-1.5 pr-3 font-normal">Address</th>
                <th className="py-1.5 pr-3 font-normal">Borough</th>
                <th className="py-1.5 pr-3 font-normal">Neighborhood</th>
                <th className="py-1.5 pr-3 font-normal">Type</th>
                <th className="py-1.5 pr-3 font-normal">Units</th>
                <th className="py-1.5 pr-3 font-normal">Stage</th>
                <th className="py-1.5 pr-3 font-normal">Sq ft</th>
                <th className="py-1.5 pr-3 font-normal">Developer</th>
                <th className="py-1.5 pr-3 font-normal">Architect</th>
                <th className="py-1.5 pr-3 font-normal">Related</th>
                <th className="py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {visible.flatMap((a) => {
                const related = (a.address && relatedNews[a.address]) || [];
                const isOpen = expandedUrl === a.url;
                return [
                  <tr key={a.url} className="border-t border-neutral-800 align-top">
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={!!selected[a.url]}
                        onChange={() => toggleSelect(a)}
                        disabled={!(a.address && a.address.trim())}
                        aria-label={`Select ${a.address ?? "row"}`}
                      />
                    </td>
                    <td className="py-2 pr-3 text-neutral-400 whitespace-nowrap" title={`scraped ${(a.scraped_at || "").slice(0, 10)}`}>{pubDay(a) || "—"}</td>
                    <td className="py-2 pr-3">{blank(a.address)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.borough)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.neighborhood)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.type)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{fmtNum(a.number_of_units)}</td>
                    <td className={`py-2 pr-3 ${a.article_type === "construction_update" ? "text-amber-300" : "text-neutral-400"}`}>
                      {stageLabel(a.article_type)}
                    </td>
                    <td className="py-2 pr-3 text-neutral-300">{fmtNum(a.square_footage)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.developer)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.architect)}</td>
                    <td className="py-2 pr-3">
                      {related.length > 0 ? (
                        <button
                          onClick={() => setExpandedUrl(isOpen ? null : a.url)}
                          className="text-sky-400 hover:underline text-xs"
                        >
                          {isOpen ? `Hide ${related.length}` : `${related.length} ↗`}
                        </button>
                      ) : (
                        <span className="text-neutral-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="py-2">
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline"
                      >
                        article ↗
                      </a>
                    </td>
                  </tr>,
                  isOpen && related.length > 0 ? (
                    <tr key={`${a.url}::related`} className="bg-neutral-950/50">
                      <td colSpan={13} className="px-3 py-3">
                        <p className="text-xs text-neutral-500 mb-2">
                          Related coverage of {a.address} ({related.length})
                        </p>
                        <ul className="space-y-1.5">
                          {related.map((r, i) => (
                            <li key={`${r.url}-${i}`} className="text-sm">
                              <a
                                href={r.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sky-400 hover:underline"
                              >
                                {r.title}
                              </a>
                              <span className="text-neutral-500 ml-2 text-xs">
                                {r.source}
                                {r.published && ` · ${r.published.slice(0, 10)}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {articles && articles.length > 0 && tab === "transaction" && (
        <div className="overflow-x-auto">
          {txCount === 0 ? (
            <p className="text-sm text-neutral-500">No transaction articles in the current set.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-400">
                <tr>
                  <th className="py-1.5 pr-2 font-normal w-6">
                    <input
                      type="checkbox"
                      aria-label="Select all visible rows"
                      checked={visible.length > 0 && visible.every((a) => selected[a.url])}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSelected((prev) => {
                          const next = { ...prev };
                          for (const a of visible) {
                            if (checked) next[a.url] = (a.address ?? "").trim();
                            else delete next[a.url];
                          }
                          return next;
                        });
                      }}
                    />
                  </th>
                  <th className="py-1.5 pr-3 font-normal">Published</th>
                  <th className="py-1.5 pr-3 font-normal">Address</th>
                  <th className="py-1.5 pr-3 font-normal">Amount</th>
                  <th className="py-1.5 pr-3 font-normal">$/unit</th>
                  <th className="py-1.5 pr-3 font-normal">$/sqft</th>
                  <th className="py-1.5 pr-3 font-normal">Buyer</th>
                  <th className="py-1.5 pr-3 font-normal">Seller</th>
                  <th className="py-1.5 pr-3 font-normal">Brokers</th>
                  <th className="py-1.5 pr-3 font-normal">Tx Date</th>
                  <th className="py-1.5 pr-3 font-normal">Related</th>
                  <th className="py-1.5 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {visible.flatMap((a) => {
                  const related = (a.address && relatedNews[a.address]) || [];
                  const isOpen = expandedUrl === a.url;
                  return [
                    <tr key={a.url} className="border-t border-neutral-800 align-top">
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={!!selected[a.url]}
                          onChange={() => toggleSelect(a)}
                          disabled={!(a.address && a.address.trim())}
                          aria-label={`Select ${a.address ?? "row"}`}
                        />
                      </td>
                      <td className="py-2 pr-3 text-neutral-400 whitespace-nowrap" title={`scraped ${(a.scraped_at || "").slice(0, 10)}`}>{pubDay(a) || "—"}</td>
                      <td className="py-2 pr-3">{blank(a.address)}</td>
                      <td className="py-2 pr-3 text-neutral-300">{fmtMoney(a.transaction_amount)}</td>
                      <td className="py-2 pr-3 text-neutral-300">{fmtMoney(a.price_per_unit)}</td>
                      <td className="py-2 pr-3 text-neutral-300">{fmtMoney(a.price_per_square_foot)}</td>
                      <td className="py-2 pr-3 text-neutral-300">{blank(a.buyer)}</td>
                      <td className="py-2 pr-3 text-neutral-300">{blank(a.seller)}</td>
                      <td className="py-2 pr-3 text-neutral-300">{blank(a.brokers)}</td>
                      <td className="py-2 pr-3 text-neutral-300">{blank(a.date_of_transaction)}</td>
                      <td className="py-2 pr-3">
                        {related.length > 0 ? (
                          <button
                            onClick={() => setExpandedUrl(isOpen ? null : a.url)}
                            className="text-sky-400 hover:underline text-xs"
                          >
                            {isOpen ? `Hide ${related.length}` : `${related.length} ↗`}
                          </button>
                        ) : (
                          <span className="text-neutral-600 text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2">
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-400 hover:underline"
                        >
                          article ↗
                        </a>
                      </td>
                    </tr>,
                    isOpen && related.length > 0 ? (
                      <tr key={`${a.url}::related`} className="bg-neutral-950/50">
                        <td colSpan={12} className="px-3 py-3">
                          <p className="text-xs text-neutral-500 mb-2">
                            Related coverage of {a.address} ({related.length})
                          </p>
                          <ul className="space-y-1.5">
                            {related.map((r, i) => (
                              <li key={`${r.url}-${i}`} className="text-sm">
                                <a
                                  href={r.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-sky-400 hover:underline"
                                >
                                  {r.title}
                                </a>
                                <span className="text-neutral-500 ml-2 text-xs">
                                  {r.source}
                                  {r.published && ` · ${r.published.slice(0, 10)}`}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {articles && articles.length > 0 && filtered.length > 0 && (
        <div className="flex items-center justify-between mt-4 text-xs text-neutral-500">
          <span>
            Showing {(sliceStart + 1).toLocaleString()}–
            {Math.min(sliceEnd, filtered.length).toLocaleString()} of{" "}
            {filtered.length.toLocaleString()}{" "}
            {tab === "development" ? "development" : "transaction"} records
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(0)}
                disabled={safePage === 0}
                className="px-2 py-0.5 rounded border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
                title="First page"
              >
                «
              </button>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="px-2 py-0.5 rounded border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Previous page"
              >
                ‹ Prev
              </button>
              <span className="px-2 text-neutral-400">
                Page {safePage + 1} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                className="px-2 py-0.5 rounded border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Next page"
              >
                Next ›
              </button>
              <button
                onClick={() => setPage(totalPages - 1)}
                disabled={safePage >= totalPages - 1}
                className="px-2 py-0.5 rounded border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Last page"
              >
                »
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
