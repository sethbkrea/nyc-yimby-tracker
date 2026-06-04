"use client";

import { useEffect, useState, useCallback } from "react";
import { toCsv, downloadText } from "@/lib/csv";
import type { Run } from "./RunsTable";

interface Article {
  url: string;
  scraped_at: string;
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

interface Props {
  refreshSignal: number;
  runs: Run[];
}

export function ArticlesPreview({ refreshSignal, runs }: Props) {
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
  const dateFiltered = (articles ?? []).filter((a) => {
    if (!matchesQuery(a)) return false;
    if (!fromDate && !toDate) return true;
    const d = (a.scraped_at || "").slice(0, 10);
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
            ⬇ All ({(articles ?? []).length.toLocaleString()})
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
                <th className="py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.url} className="border-t border-neutral-800 align-top">
                  <td className="py-2 pr-3 text-neutral-400 whitespace-nowrap">{(a.scraped_at || "").slice(0, 10) || "—"}</td>
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
                </tr>
              ))}
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
                  <th className="py-1.5 pr-3 font-normal">Scraped</th>
                  <th className="py-1.5 pr-3 font-normal">Address</th>
                  <th className="py-1.5 pr-3 font-normal">Amount</th>
                  <th className="py-1.5 pr-3 font-normal">$/unit</th>
                  <th className="py-1.5 pr-3 font-normal">$/sqft</th>
                  <th className="py-1.5 pr-3 font-normal">Buyer</th>
                  <th className="py-1.5 pr-3 font-normal">Seller</th>
                  <th className="py-1.5 pr-3 font-normal">Brokers</th>
                  <th className="py-1.5 pr-3 font-normal">Tx Date</th>
                  <th className="py-1.5 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.url} className="border-t border-neutral-800 align-top">
                    <td className="py-2 pr-3 text-neutral-400 whitespace-nowrap">{(a.scraped_at || "").slice(0, 10) || "—"}</td>
                    <td className="py-2 pr-3">{blank(a.address)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{fmtMoney(a.transaction_amount)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{fmtMoney(a.price_per_unit)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{fmtMoney(a.price_per_square_foot)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.buyer)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.seller)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.brokers)}</td>
                    <td className="py-2 pr-3 text-neutral-300">{blank(a.date_of_transaction)}</td>
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
                  </tr>
                ))}
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
