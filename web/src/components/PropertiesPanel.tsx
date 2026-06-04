"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { groupIntoProfiles, type PropertyProfile } from "@/lib/profiles";
import type { Article } from "@/lib/articles";
import { toCsv, downloadText } from "@/lib/csv";

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
  other: "Update",
};
function stageLabel(t: string): string {
  return STAGE_LABEL[t] ?? "Update";
}
function stageClass(t: string): string {
  if (t === "construction_update") return "bg-amber-500/15 text-amber-300";
  if (t === "completion") return "bg-emerald-500/15 text-emerald-300";
  if (t === "permit_filed" || t === "approval") return "bg-sky-500/15 text-sky-300";
  if (t === "demolition") return "bg-red-500/15 text-red-300";
  return "bg-neutral-500/15 text-neutral-300";
}
const fmtNum = (n: number | null) => (n == null ? "—" : n.toLocaleString());
const blank = (s: string) => (s.trim() ? s : "—");

const RENDER_LIMIT = 150;

export function PropertiesPanel() {
  const [profiles, setProfiles] = useState<PropertyProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [multiOnly, setMultiOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/articles");
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { articles: Article[] };
      setProfiles(groupIntoProfiles(data.articles));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const filtered = useMemo(() => {
    let list = profiles ?? [];
    if (multiOnly) list = list.filter((p) => p.articleCount > 1);
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((p) =>
        [p.address, p.borough, p.neighborhood, p.developer, p.architect]
          .join(" ").toLowerCase().includes(needle),
      );
    }
    return list;
  }, [profiles, multiOnly, q]);

  const multiCount = (profiles ?? []).filter((p) => p.articleCount > 1).length;

  function exportCsv() {
    const today = new Date().toISOString().slice(0, 10);
    const header = [
      "address", "borough", "neighborhood", "type", "units", "stories", "square_footage",
      "developer", "architect", "latest_stage", "article_count", "first_date", "latest_date",
      "article_urls",
    ];
    const rows: (string | number | null | undefined)[][] = [header];
    for (const p of filtered) {
      rows.push([
        p.address, p.borough, p.neighborhood, p.type, p.units, p.stories, p.squareFootage,
        p.developer, p.architect, stageLabel(p.latestStage), p.articleCount, p.firstDate, p.latestDate,
        p.articles.map((a) => a.url).join(" | "),
      ]);
    }
    downloadText(`property-profiles-${today}.csv`, toCsv(rows));
  }

  return (
    <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="text-lg font-semibold">
          Property profiles
          {profiles && (
            <span className="ml-2 text-sm font-normal text-neutral-400">
              {filtered.length.toLocaleString()} buildings · {multiCount} with multiple articles
            </span>
          )}
        </h2>
        {profiles && (
          <button onClick={exportCsv} className="px-3 py-1.5 rounded-md border border-neutral-700 text-sm text-neutral-300 hover:bg-neutral-800">
            Export CSV
          </button>
        )}
      </div>
      <p className="text-sm text-neutral-400 mb-3">
        Every building, with all of its YIMBY coverage grouped together. Click a building to see its full article timeline.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search address, neighborhood, developer…"
          className="flex-1 min-w-[220px] rounded-md bg-neutral-950 border border-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
        />
        <label className="flex items-center gap-2 text-sm text-neutral-400 select-none">
          <input type="checkbox" checked={multiOnly} onChange={(e) => setMultiOnly(e.target.checked)} />
          Only buildings with multiple articles
        </label>
      </div>

      {error && <p className="text-sm text-red-400">Error: {error}</p>}
      {profiles === null && !error && <p className="text-sm text-neutral-500">Loading…</p>}
      {profiles && filtered.length === 0 && <p className="text-sm text-neutral-500">No matching buildings.</p>}

      <div className="grid gap-2">
        {filtered.slice(0, RENDER_LIMIT).map((p) => {
          const open = expanded.has(p.key);
          return (
            <div key={p.key} className="border border-neutral-800 rounded-lg bg-neutral-950/50">
              <button
                onClick={() => toggle(p.key)}
                className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 hover:bg-neutral-900/50 rounded-lg"
              >
                <span className="text-neutral-500 text-xs w-3">{open ? "▾" : "▸"}</span>
                <span className="font-medium text-neutral-100 flex-1 min-w-[180px]">{p.address}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${stageClass(p.latestStage)}`}>
                  {stageLabel(p.latestStage)}
                </span>
                <span className="text-xs text-neutral-400 w-20">{fmtNum(p.units)} units</span>
                <span className="text-xs text-neutral-500 w-28">{blank(p.borough)}</span>
                <span className="text-xs text-neutral-500">
                  {p.articleCount} article{p.articleCount === 1 ? "" : "s"}
                </span>
              </button>

              {open && (
                <div className="px-4 pb-4 pt-1 border-t border-neutral-800/70">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-400 mb-3">
                    <span>Neighborhood: <span className="text-neutral-300">{blank(p.neighborhood)}</span></span>
                    <span>Type: <span className="text-neutral-300">{blank(p.type)}</span></span>
                    <span>Stories: <span className="text-neutral-300">{fmtNum(p.stories)}</span></span>
                    <span>Sq ft: <span className="text-neutral-300">{fmtNum(p.squareFootage)}</span></span>
                    <span>Developer: <span className="text-neutral-300">{blank(p.developer)}</span></span>
                    <span>Architect: <span className="text-neutral-300">{blank(p.architect)}</span></span>
                  </div>
                  <ol className="grid gap-1.5 border-l border-neutral-800 pl-3">
                    {p.articles.map((a) => (
                      <li key={a.url} className="flex flex-wrap items-baseline gap-2 text-xs">
                        <span className="text-neutral-500 w-20 shrink-0">{a.date || "—"}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${stageClass(a.stage)}`}>
                          {stageLabel(a.stage)}
                        </span>
                        <a href={a.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline flex-1">
                          {a.title}
                        </a>
                        {a.units != null && <span className="text-neutral-500 shrink-0">{a.units.toLocaleString()} units</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length > RENDER_LIMIT && (
        <p className="mt-3 text-xs text-neutral-500">
          Showing first {RENDER_LIMIT} of {filtered.length.toLocaleString()} — refine your search to narrow.
        </p>
      )}
    </section>
  );
}
