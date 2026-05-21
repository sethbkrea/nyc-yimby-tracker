"use client";

import { useState } from "react";

type DispatchBody = {
  workflow: string;
  inputs?: Record<string, string | boolean>;
};

async function dispatch(body: DispatchBody): Promise<{ ok: true } | { error: string }> {
  const res = await fetch("/api/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { error: data.error ?? `HTTP ${res.status}` };
}

export function RunButtons({ onDispatched }: { onDispatched: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [startMonth, setStartMonth] = useState("2025-08");
  const [endMonth, setEndMonth] = useState("");
  const [dryRun, setDryRun] = useState(false);

  async function run(workflow: string, inputs?: Record<string, string | boolean>) {
    setBusy(workflow);
    setMsg(null);
    const result = await dispatch({ workflow, inputs });
    setBusy(null);
    if ("error" in result) {
      setMsg(`Failed: ${result.error}`);
    } else {
      setMsg(`Dispatched ${workflow}. The run will appear below shortly.`);
      // Give GitHub a moment to register the run before refreshing.
      setTimeout(onDispatched, 2500);
    }
  }

  return (
    <div className="space-y-6">
      <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
        <h2 className="text-lg font-semibold mb-1">Daily scrape</h2>
        <p className="text-sm text-neutral-400 mb-4">
          Pulls the RSS feed, fetches any new articles, appends to articles.json.
        </p>
        <button
          onClick={() => run("daily-scrape.yml")}
          disabled={busy !== null}
          className="px-4 py-2 bg-emerald-500 text-black font-medium rounded hover:bg-emerald-400 disabled:opacity-50"
        >
          {busy === "daily-scrape.yml" ? "Dispatching…" : "Run daily scrape"}
        </button>
      </section>

      <section className="border border-neutral-800 rounded-lg p-5 bg-neutral-900/40">
        <h2 className="text-lg font-semibold mb-1">Historical backfill</h2>
        <p className="text-sm text-neutral-400 mb-4">
          Crawls month-archive pages between the given months. Runs up to 5h50m.
        </p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="text-sm">
            <span className="block text-neutral-400 mb-1">Start month (YYYY-MM)</span>
            <input
              value={startMonth}
              onChange={(e) => setStartMonth(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5"
              placeholder="2025-08"
            />
          </label>
          <label className="text-sm">
            <span className="block text-neutral-400 mb-1">End month (blank = now)</span>
            <input
              value={endMonth}
              onChange={(e) => setEndMonth(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded px-2 py-1.5"
              placeholder="2026-05"
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm mb-4">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (collect URLs only, no writes)
        </label>
        <button
          onClick={() =>
            run("backfill.yml", {
              start_month: startMonth,
              end_month: endMonth,
              dry_run: dryRun,
            })
          }
          disabled={busy !== null || !/^\d{4}-\d{2}$/.test(startMonth)}
          className="px-4 py-2 bg-sky-500 text-black font-medium rounded hover:bg-sky-400 disabled:opacity-50"
        >
          {busy === "backfill.yml" ? "Dispatching…" : "Run backfill"}
        </button>
      </section>

      {msg && <p className="text-sm text-neutral-300">{msg}</p>}
    </div>
  );
}
