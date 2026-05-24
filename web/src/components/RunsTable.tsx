"use client";

import { useState } from "react";

export interface Run {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null;
  url: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  path: string;
  articlesAdded: number | null;
  articlesFailed: number | null;
}

function badge(status: string, conclusion: string | null): { label: string; className: string } {
  if (status === "queued") return { label: "queued", className: "bg-amber-500/20 text-amber-300" };
  if (status === "in_progress") return { label: "running", className: "bg-sky-500/20 text-sky-300" };
  if (conclusion === "success") return { label: "success", className: "bg-emerald-500/20 text-emerald-300" };
  if (conclusion === "failure") return { label: "failure", className: "bg-red-500/20 text-red-300" };
  if (conclusion === "cancelled") return { label: "cancelled", className: "bg-neutral-500/20 text-neutral-300" };
  return { label: conclusion ?? status, className: "bg-neutral-500/20 text-neutral-300" };
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function isActive(r: Run): boolean {
  return r.status !== "completed";
}

export function RunsTable({
  runs,
  error,
  onCancelled,
}: {
  runs: Run[] | null;
  error: string | null;
  onCancelled: () => void;
}) {
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function cancel(runId: number) {
    if (!confirm("Cancel this run? Any work already done will be discarded.")) return;
    setCancelling(runId);
    setCancelError(null);
    try {
      const res = await fetch("/api/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onCancelled();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(null);
    }
  }

  return (
    <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
      <h2 className="text-lg font-semibold mb-3">Recent runs</h2>
      {error && <p className="text-sm text-red-400 mb-3">Error: {error}</p>}
      {cancelError && <p className="text-sm text-red-400 mb-3">Cancel: {cancelError}</p>}
      {runs === null && !error && <p className="text-sm text-neutral-500">Loading…</p>}
      {runs && runs.length === 0 && <p className="text-sm text-neutral-500">No runs yet.</p>}
      {runs && runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-400">
              <tr>
                <th className="py-1.5 pr-3 font-normal">Workflow</th>
                <th className="py-1.5 pr-3 font-normal">Status</th>
                <th className="py-1.5 pr-3 font-normal">Articles</th>
                <th className="py-1.5 pr-3 font-normal">Trigger</th>
                <th className="py-1.5 pr-3 font-normal">Started</th>
                <th className="py-1.5 pr-3 font-normal"></th>
                <th className="py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const b = badge(r.status, r.conclusion);
                return (
                  <tr key={r.id} className="border-t border-neutral-800">
                    <td className="py-2 pr-3">{r.name}</td>
                    <td className="py-2 pr-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${b.className}`}>
                        {b.label}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-neutral-300">
                      {r.articlesAdded === null ? (
                        <span className="text-neutral-600">—</span>
                      ) : (
                        <>
                          <span className={r.articlesAdded > 0 ? "text-emerald-300" : "text-neutral-500"}>
                            +{r.articlesAdded}
                          </span>
                          {r.articlesFailed != null && r.articlesFailed > 0 && (
                            <span className="text-red-400 ml-1">({r.articlesFailed} failed)</span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-neutral-400">{r.event}</td>
                    <td className="py-2 pr-3 text-neutral-400">{relativeTime(r.createdAt)}</td>
                    <td className="py-2 pr-3">
                      {isActive(r) && (
                        <button
                          onClick={() => cancel(r.id)}
                          disabled={cancelling === r.id}
                          className="text-xs px-2 py-1 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {cancelling === r.id ? "Cancelling…" : "Cancel"}
                        </button>
                      )}
                    </td>
                    <td className="py-2">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline"
                      >
                        logs ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
