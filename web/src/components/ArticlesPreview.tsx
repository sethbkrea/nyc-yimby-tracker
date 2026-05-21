"use client";

import { useEffect, useState, useCallback } from "react";

interface Article {
  url: string;
  address: string;
  developer: string;
  neighborhood: string;
  borough: string;
  notes: string;
  scraped_at: string;
}

export function ArticlesPreview({ refreshSignal }: { refreshSignal: number }) {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold">Articles</h2>
        {total !== null && (
          <span className="text-sm text-neutral-400">{total.toLocaleString()} total</span>
        )}
      </div>
      {error && <p className="text-sm text-red-400 mb-3">Error: {error}</p>}
      {articles === null && !error && <p className="text-sm text-neutral-500">Loading…</p>}
      {articles && articles.length === 0 && (
        <p className="text-sm text-neutral-500">No articles yet. Run a scrape above.</p>
      )}
      {articles && articles.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-400">
              <tr>
                <th className="py-1.5 pr-3 font-normal">Address</th>
                <th className="py-1.5 pr-3 font-normal">Borough</th>
                <th className="py-1.5 pr-3 font-normal">Neighborhood</th>
                <th className="py-1.5 pr-3 font-normal">Developer</th>
                <th className="py-1.5 pr-3 font-normal">Notes</th>
                <th className="py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {articles.map((a) => (
                <tr key={a.url} className="border-t border-neutral-800 align-top">
                  <td className="py-2 pr-3">{a.address || "—"}</td>
                  <td className="py-2 pr-3 text-neutral-300">{a.borough || "—"}</td>
                  <td className="py-2 pr-3 text-neutral-300">{a.neighborhood || "—"}</td>
                  <td className="py-2 pr-3 text-neutral-300">{a.developer || "—"}</td>
                  <td className="py-2 pr-3 text-neutral-400 max-w-md">{a.notes || "—"}</td>
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
    </section>
  );
}
