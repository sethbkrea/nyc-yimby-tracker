"use client";

import { useEffect, useState, useCallback } from "react";
import { toCsv, downloadText } from "@/lib/csv";

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

export function ArticlesPreview({ refreshSignal }: { refreshSignal: number }) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"development" | "transaction">("development");
  const [pageSize, setPageSize] = useState<number>(50);

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

  const txCount = (articles ?? []).filter(isTransaction).length;
  const devCount = (articles ?? []).length - txCount;

  const filtered = (articles ?? []).filter((a) =>
    tab === "transaction" ? isTransaction(a) : !isTransaction(a),
  );
  const visible = filtered.slice(0, pageSize);
  const more = filtered.length - visible.length;

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

  return (
    <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Articles</h2>
        {total !== null && (
          <span className="text-sm text-neutral-400">{total.toLocaleString()} total</span>
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
            ⬇ Download CSV ({filtered.length})
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
                <th className="py-1.5 pr-3 font-normal">Address</th>
                <th className="py-1.5 pr-3 font-normal">Borough</th>
                <th className="py-1.5 pr-3 font-normal">Neighborhood</th>
                <th className="py-1.5 pr-3 font-normal">Type</th>
                <th className="py-1.5 pr-3 font-normal">Units</th>
                <th className="py-1.5 pr-3 font-normal">Sq ft</th>
                <th className="py-1.5 pr-3 font-normal">Developer</th>
                <th className="py-1.5 pr-3 font-normal">Architect</th>
                <th className="py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.url} className="border-t border-neutral-800 align-top">
                  <td className="py-2 pr-3">{blank(a.address)}</td>
                  <td className="py-2 pr-3 text-neutral-300">{blank(a.borough)}</td>
                  <td className="py-2 pr-3 text-neutral-300">{blank(a.neighborhood)}</td>
                  <td className="py-2 pr-3 text-neutral-300">{blank(a.type)}</td>
                  <td className="py-2 pr-3 text-neutral-300">{fmtNum(a.number_of_units)}</td>
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
                  <th className="py-1.5 pr-3 font-normal">Address</th>
                  <th className="py-1.5 pr-3 font-normal">Amount</th>
                  <th className="py-1.5 pr-3 font-normal">$/unit</th>
                  <th className="py-1.5 pr-3 font-normal">$/sqft</th>
                  <th className="py-1.5 pr-3 font-normal">Buyer</th>
                  <th className="py-1.5 pr-3 font-normal">Seller</th>
                  <th className="py-1.5 pr-3 font-normal">Brokers</th>
                  <th className="py-1.5 pr-3 font-normal">Date</th>
                  <th className="py-1.5 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.url} className="border-t border-neutral-800 align-top">
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
        <p className="text-xs text-neutral-500 mt-3">
          Showing {visible.length.toLocaleString()} of {filtered.length.toLocaleString()}{" "}
          {tab === "development" ? "development" : "transaction"} records (most recent first).
          {more > 0 && " Increase page size above to see more."}
        </p>
      )}
    </section>
  );
}
