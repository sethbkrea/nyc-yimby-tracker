"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toCsv, downloadText } from "@/lib/csv";

interface Permit {
  source: "DOB NOW" | "DOB BIS";
  jobFilingNumber?: string;
  jobNumber?: string;
  jobType: string;
  jobTypeLabel?: string;
  status: string;
  filingDate: string;
  approvedDate?: string;
  issuanceDate?: string;
  workTypes?: string[];
  workType?: string;
  permitType?: string;
  description?: string;
}

interface ArticleMatch {
  url: string;
  title?: string;
  address?: string;
  borough?: string;
  article_type?: string;
  scraped_at?: string;
  notes?: string;
}

interface ResolvedProperty {
  input: string;
  bbl: string | null;
  address: string | null;
  borough: string | null;
  block: string | null;
  lot: string | null;
  error?: string;
}

interface NewsArticle {
  title: string;
  url: string;
  source: string;
  date: string;
}

interface PropertyResult {
  property: ResolvedProperty;
  permits: Permit[];
  dobNowCount: number;
  dobBisCount: number;
  articles: ArticleMatch[];
  news: NewsArticle[];
}

interface ApiResponse {
  results: PropertyResult[];
  requested: number;
  processed: number;
  truncated: boolean;
  maxInputs: number;
}

function jobId(p: Permit): string {
  return p.source === "DOB NOW" ? p.jobFilingNumber ?? "" : p.jobNumber ?? "";
}

interface LogEntry {
  at: string;
  user: string;
  count: number;
  inputs: string[];
  runId?: string;
}

export function ResearchPanel() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<LogEntry[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // Set when the displayed Results are a reloaded saved run (vs. a fresh search).
  const [viewingSaved, setViewingSaved] = useState<LogEntry | null>(null);
  const [loadingRun, setLoadingRun] = useState<string | null>(null);

  const openRun = useCallback(async (entry: LogEntry) => {
    if (!entry.runId) return;
    setLoadingRun(entry.runId);
    setError(null);
    try {
      const res = await fetch(`/api/research/run/${entry.runId}`);
      const body = (await res.json()) as ApiResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
      setViewingSaved(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingRun(null);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/research/log");
      if (!res.ok) return;
      const body = (await res.json()) as { entries?: LogEntry[] };
      setHistory(body.entries ?? []);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const onFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      // For CSV/TSV, take the first column of each line; for txt, take the line.
      const lines = content.split(/[\r\n]+/).map((l) => {
        const firstCol = l.split(/[\t,]/)[0] ?? "";
        return firstCol.trim();
      });
      setText((prev) => (prev ? prev + "\n" : "") + lines.join("\n"));
    };
    reader.readAsText(file);
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setViewingSaved(null);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json()) as ApiResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
      loadHistory(); // the search was just logged — refresh the audit list
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [text, loadHistory]);

  function exportCsv() {
    if (!data) return;
    const today = new Date().toISOString().slice(0, 10);
    const header = [
      "input", "resolved_address", "bbl", "borough",
      "system", "job_number", "job_type", "work_types", "status",
      "filing_date", "approved_or_issued", "description",
    ];
    const rows: (string | number | null | undefined)[][] = [header];
    for (const r of data.results) {
      if (r.permits.length === 0) {
        rows.push([r.property.input, r.property.address, r.property.bbl, r.property.borough,
          "", "", "", "", r.property.error ?? "no matching permits", "", "", ""]);
        continue;
      }
      for (const p of r.permits) {
        rows.push([
          r.property.input, r.property.address, r.property.bbl, r.property.borough,
          p.source, jobId(p), p.jobTypeLabel ?? p.jobType,
          (p.workTypes && p.workTypes.length ? p.workTypes.join(" ") : p.workType) ?? "",
          p.status, p.filingDate, p.approvedDate || p.issuanceDate || "", p.description ?? "",
        ]);
      }
    }
    downloadText(`property-research-${today}.csv`, toCsv(rows));
  }

  function exportArticlesCsv() {
    if (!data) return;
    const today = new Date().toISOString().slice(0, 10);
    const header = ["input", "resolved_address", "bbl", "source", "article_title", "article_url", "type_or_publisher", "date"];
    const rows: (string | number | null | undefined)[][] = [header];
    for (const r of data.results) {
      for (const a of r.articles) {
        rows.push([r.property.input, r.property.address, r.property.bbl, "YIMBY", a.title, a.url, a.article_type, a.scraped_at?.slice(0, 10)]);
      }
      for (const n of r.news) {
        rows.push([r.property.input, r.property.address, r.property.bbl, "Web", n.title, n.url, n.source, n.date]);
      }
    }
    downloadText(`property-articles-${today}.csv`, toCsv(rows));
  }

  const totalPermits = data?.results.reduce((n, r) => n + r.permits.length, 0) ?? 0;
  const totalArticles = data?.results.reduce((n, r) => n + r.articles.length + r.news.length, 0) ?? 0;

  return (
    <div className="grid gap-6">
      <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
        <h2 className="text-lg font-semibold mb-1">Research properties</h2>
        <p className="text-sm text-neutral-400 mb-3">
          Paste addresses or 10-digit BBLs (one per line), or upload a .csv/.txt. We pull DOB NOW
          and DOB BIS permits for the tracked job types and find related articles — from the YIMBY
          corpus and the wider web (The Real Deal, Commercial Observer, Crain&apos;s, etc.).
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"374 Lexington Avenue, Manhattan\n1012960014\n250 East 54 Street"}
          rows={6}
          className="w-full rounded-md bg-neutral-950 border border-neutral-800 p-3 text-sm font-mono text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
        />
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <button
            onClick={run}
            disabled={loading || text.trim().length === 0}
            className="px-4 py-2 rounded-md bg-white text-black text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-neutral-200"
          >
            {loading ? "Researching…" : "Research"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,.tsv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="px-3 py-2 rounded-md border border-neutral-700 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Upload file
          </button>
          {text.trim() && (
            <button onClick={() => { setText(""); setData(null); }} className="text-sm text-neutral-500 hover:text-neutral-300">
              Clear
            </button>
          )}
          <span className="text-xs text-neutral-500">
            Tracking DOB NOW: New Building, Full Demolition, ALT-CO, Alteration (GC/ST/MS/FO/SE/EA) · DOB BIS: NB, DM, A1, A2
          </span>
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </section>

      {history && history.length > 0 && (
        <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
          <button
            onClick={() => setShowHistory((s) => !s)}
            className="w-full flex items-center justify-between text-left"
          >
            <h2 className="text-lg font-semibold">
              Past runs
              <span className="ml-2 text-sm font-normal text-neutral-400">{history.length} recent</span>
            </h2>
            <span className="text-neutral-500 text-sm">{showHistory ? "Hide ▾" : "Show ▸"}</span>
          </button>
          {showHistory && (
            <ul className="mt-3 grid gap-1">
              {history.map((h, i) => {
                const reopenable = Boolean(h.runId);
                return (
                  <li key={`${h.at}-${i}`}>
                    <button
                      onClick={() => openRun(h)}
                      disabled={!reopenable}
                      title={reopenable ? "View saved results" : "Results were not saved for this run"}
                      className={[
                        "w-full text-left text-xs rounded-md px-2 py-2 border border-transparent",
                        reopenable ? "hover:bg-neutral-800/60 hover:border-neutral-800 cursor-pointer" : "cursor-default opacity-70",
                      ].join(" ")}
                    >
                      <div className="flex flex-wrap items-center gap-x-3 text-neutral-400">
                        <span className="text-neutral-300">{new Date(h.at).toLocaleString()}</span>
                        <span>{h.user}</span>
                        <span className="text-neutral-500">{h.count} propert{h.count === 1 ? "y" : "ies"}</span>
                        {loadingRun === h.runId && <span className="text-sky-400">loading…</span>}
                        {reopenable && loadingRun !== h.runId && <span className="text-blue-400">view results →</span>}
                      </div>
                      <div className="text-neutral-500 mt-0.5 break-words">{h.inputs.join("  ·  ")}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {data && (
        <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
          {viewingSaved && (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs rounded-md bg-sky-500/10 border border-sky-500/20 px-3 py-2">
              <span className="text-sky-300">Saved run</span>
              <span className="text-neutral-400">{new Date(viewingSaved.at).toLocaleString()} · {viewingSaved.user}</span>
              <button onClick={() => { setData(null); setViewingSaved(null); }} className="ml-auto text-neutral-400 hover:text-white">
                Close
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h2 className="text-lg font-semibold">
              Results
              <span className="ml-2 text-sm font-normal text-neutral-400">
                {data.processed} propert{data.processed === 1 ? "y" : "ies"} · {totalPermits} permits · {totalArticles} articles
              </span>
            </h2>
            <div className="flex gap-2">
              <button onClick={exportCsv} className="px-3 py-1.5 rounded-md border border-neutral-700 text-sm text-neutral-300 hover:bg-neutral-800">
                Export permits CSV
              </button>
              <button onClick={exportArticlesCsv} className="px-3 py-1.5 rounded-md border border-neutral-700 text-sm text-neutral-300 hover:bg-neutral-800">
                Export articles CSV
              </button>
            </div>
          </div>

          {data.truncated && (
            <p className="mb-4 text-sm text-amber-400">
              Only the first {data.maxInputs} of {data.requested} inputs were processed.
            </p>
          )}

          <div className="grid gap-4">
            {data.results.map((r, i) => (
              <PropertyCard key={`${r.property.input}-${i}`} r={r} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PropertyCard({ r }: { r: PropertyResult }) {
  const p = r.property;
  return (
    <div className="border border-neutral-800 rounded-lg p-4 bg-neutral-950/50">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-medium text-neutral-100">
            {p.address ?? p.input}
            {p.address && p.address.toUpperCase() !== p.input.toUpperCase() && (
              <span className="ml-2 text-xs text-neutral-500">(input: {p.input})</span>
            )}
          </h3>
          <p className="text-xs text-neutral-500">
            {p.bbl ? (
              <>
                BBL {p.bbl} · {p.borough}
                {" · "}
                <a className="text-blue-400 hover:underline" target="_blank" rel="noreferrer"
                   href={`https://propertyinformationportal.nyc.gov/parcels/parcel/${p.bbl}`}>
                  Property Portal
                </a>
              </>
            ) : (
              <span className="text-red-400">{p.error ?? "could not resolve"}</span>
            )}
          </p>
        </div>
        <div className="text-xs text-neutral-400">
          DOB NOW {r.dobNowCount} · DOB BIS {r.dobBisCount} · Articles {r.articles.length + r.news.length}
        </div>
      </div>

      {r.permits.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-neutral-500 text-left">
              <tr className="border-b border-neutral-800">
                <th className="py-1 pr-3 font-medium">System</th>
                <th className="py-1 pr-3 font-medium">Job #</th>
                <th className="py-1 pr-3 font-medium">Type</th>
                <th className="py-1 pr-3 font-medium">Work</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Filed</th>
                <th className="py-1 pr-3 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {r.permits.map((pm, j) => (
                <tr key={`${jobId(pm)}-${j}`} className="border-b border-neutral-900 align-top">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    <span className={pm.source === "DOB NOW" ? "text-emerald-400" : "text-sky-400"}>{pm.source}</span>
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap text-neutral-300">{jobId(pm)}</td>
                  <td className="py-1 pr-3 whitespace-nowrap text-neutral-300">{pm.jobTypeLabel ?? pm.jobType}</td>
                  <td className="py-1 pr-3 whitespace-nowrap text-neutral-400">
                    {pm.workTypes && pm.workTypes.length ? pm.workTypes.join(" ") : pm.workType || "—"}
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap text-neutral-400">{pm.status}</td>
                  <td className="py-1 pr-3 whitespace-nowrap text-neutral-400">{pm.filingDate || "—"}</td>
                  <td className="py-1 pr-3 text-neutral-400 max-w-md">{pm.description || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {p.bbl && r.permits.length === 0 && (
        <p className="mt-3 text-xs text-neutral-500">No matching permits in the tracked job types.</p>
      )}

      {(r.articles.length > 0 || r.news.length > 0) && (
        <div className="mt-3">
          <p className="text-xs font-medium text-neutral-400 mb-1">
            Related articles
            <span className="ml-2 text-neutral-600">
              {r.articles.length} YIMBY · {r.news.length} web
            </span>
          </p>
          <ul className="grid gap-1">
            {r.articles.map((a) => (
              <li key={a.url} className="text-xs flex gap-2">
                <span className="shrink-0 rounded bg-amber-500/15 text-amber-300 px-1.5 py-0.5 text-[10px] font-medium">YIMBY</span>
                <a href={a.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                  {a.title || a.url}
                </a>
              </li>
            ))}
            {r.news.map((n) => (
              <li key={n.url} className="text-xs flex gap-2">
                <span className="shrink-0 rounded bg-sky-500/15 text-sky-300 px-1.5 py-0.5 text-[10px] font-medium">
                  {n.source || "Web"}
                </span>
                <a href={n.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                  {n.title}
                </a>
                {n.date && <span className="text-neutral-600 shrink-0">{n.date}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
