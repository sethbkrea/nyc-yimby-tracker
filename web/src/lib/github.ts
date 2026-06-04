const GH_API = "https://api.github.com";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function repoPath(): string {
  return `${env("GITHUB_OWNER")}/${env("GITHUB_REPO")}`;
}

/** Unauthenticated fetch — fine for reading public repos. */
async function ghFetchPublic(path: string): Promise<Response> {
  return fetch(`${GH_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
}

/**
 * Read fetch that uses GH_TOKEN when present (5000/hr) but falls back to an
 * unauthenticated request when it isn't. The repo is public, so reads still
 * work without a token (anon limit 60/hr/IP) — this keeps the runs list usable
 * in local dev where GH_TOKEN may be unset, instead of throwing "Missing env".
 */
async function ghFetchRead(path: string): Promise<Response> {
  const token = process.env.GH_TOKEN;
  return fetch(`${GH_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
  });
}

/** Authenticated fetch — required for workflow_dispatch even on public repos. */
async function ghFetchAuthed(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env("GH_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
}

export type DispatchInputs = Record<string, string | boolean>;

export async function dispatchWorkflow(
  workflowFile: string,
  inputs: DispatchInputs = {},
): Promise<void> {
  const res = await ghFetchAuthed(
    `/repos/${repoPath()}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );
  if (res.status !== 204) {
    const body = await res.text();
    throw new Error(`workflow_dispatch failed: ${res.status} ${body}`);
  }
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  event: string;
  workflow_id: number;
  path: string;
}

export async function listRecentRuns(perPage = 15): Promise<WorkflowRun[]> {
  // Prefer the token (anon limit is 60/hr/IP, which the poll cadence blows
  // through; authed tokens get 5000/hr) but fall back to anonymous so local
  // dev without GH_TOKEN still lists runs instead of erroring.
  const res = await ghFetchRead(`/repos/${repoPath()}/actions/runs?per_page=${perPage}`);
  if (!res.ok) throw new Error(`list runs failed: ${res.status}`);
  const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
  return data.workflow_runs;
}

export async function cancelRun(runId: number): Promise<void> {
  const res = await ghFetchAuthed(`/repos/${repoPath()}/actions/runs/${runId}/cancel`, {
    method: "POST",
  });
  // GitHub returns 202 Accepted for cancel.
  if (res.status !== 202) {
    const body = await res.text();
    throw new Error(`cancel failed: ${res.status} ${body}`);
  }
}

export function workflowRunUrl(workflowFile: string): string {
  return `https://github.com/${repoPath()}/actions/workflows/${workflowFile}`;
}

export interface RunSummary {
  run_id: number;
  completed_at: string;
  articles_added: number;
  articles_failed: number;
  status: string;
}

export async function loadRunSummaries(): Promise<RunSummary[]> {
  // Cache for 60s — this file only changes when a workflow runs (~daily).
  // Without caching, every /api/runs request (polled every few seconds per
  // open tab) hits raw.githubusercontent.com and quickly trips its
  // anonymous per-IP rate limit, which then crashes the whole route.
  const owner = env("GITHUB_OWNER");
  const repo = env("GITHUB_REPO");
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/run_summaries.json`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as RunSummary[]) : [];
  } catch {
    // Network glitch, rate limit, parse error — none should break the runs list.
    return [];
  }
}

// ── Property-research audit log ────────────────────────────────────────────
// Append-only JSONL in the repo recording who searched which properties.

const RESEARCH_LOG_PATH = "research_log.jsonl";

export interface ResearchLogEntry {
  at: string; // ISO timestamp
  user: string; // signed-in email
  count: number; // number of inputs submitted
  inputs: string[]; // the addresses / BBLs searched
  runId?: string; // id of the saved full-results file, when persisted
}

interface ContentsResponse {
  content?: string;
  sha?: string;
}

/**
 * Append one entry to research_log.jsonl via the GitHub Contents API. Read the
 * file's current SHA, append a line, and commit; retry on a 409 (concurrent
 * write). Best-effort: with no GH_TOKEN (local dev) it just logs to console.
 */
export async function appendResearchLog(entry: ResearchLogEntry): Promise<void> {
  if (!process.env.GH_TOKEN) {
    console.log("[research-log]", JSON.stringify(entry));
    return;
  }
  const repo = repoPath();
  const line = JSON.stringify(entry) + "\n";

  for (let attempt = 0; attempt < 4; attempt++) {
    let sha: string | undefined;
    let existing = "";
    const getRes = await ghFetchRead(`/repos/${repo}/contents/${RESEARCH_LOG_PATH}?ref=main`);
    if (getRes.ok) {
      const j = (await getRes.json()) as ContentsResponse;
      sha = j.sha;
      existing = Buffer.from(j.content ?? "", "base64").toString("utf8");
    } else if (getRes.status !== 404) {
      throw new Error(`research-log read failed: ${getRes.status}`);
    }

    const putRes = await ghFetchAuthed(`/repos/${repo}/contents/${RESEARCH_LOG_PATH}`, {
      method: "PUT",
      body: JSON.stringify({
        message: "chore: property-research log +1 [skip ci]",
        content: Buffer.from(existing + line, "utf8").toString("base64"),
        sha, // omitted when creating the file
        branch: "main",
      }),
    });
    if (putRes.ok) return;
    if (putRes.status === 409) continue; // SHA race — refetch and retry
    throw new Error(`research-log write failed: ${putRes.status}`);
  }
  throw new Error("research-log write failed after retries");
}

/**
 * Persist the full results of one research run to research_runs/<id>.json.
 * Unique filename, so it's always a create (no SHA). Best-effort: no token →
 * console log only.
 */
export async function saveResearchRun(runId: string, record: unknown): Promise<void> {
  if (!process.env.GH_TOKEN) {
    console.log("[research-run] (no token, not persisted)", runId);
    return;
  }
  const res = await ghFetchAuthed(`/repos/${repoPath()}/contents/research_runs/${runId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      message: `chore: property-research run ${runId} [skip ci]`,
      content: Buffer.from(JSON.stringify(record), "utf8").toString("base64"),
      branch: "main",
    }),
  });
  if (!res.ok) throw new Error(`research-run write failed: ${res.status}`);
}

/** Read one saved research run's full results, or null if missing. */
export async function loadResearchRun(runId: string): Promise<unknown | null> {
  // runId is a UUID we generated, but guard the path regardless.
  const safe = runId.replace(/[^a-zA-Z0-9-]/g, "");
  const res = await ghFetchRead(`/repos/${repoPath()}/contents/research_runs/${safe}.json?ref=main`);
  if (!res.ok) return null;
  const j = (await res.json()) as ContentsResponse;
  try {
    return JSON.parse(Buffer.from(j.content ?? "", "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Read the research audit log, newest first. */
export async function loadResearchLog(limit = 200): Promise<ResearchLogEntry[]> {
  const res = await ghFetchRead(`/repos/${repoPath()}/contents/${RESEARCH_LOG_PATH}?ref=main`);
  if (!res.ok) return []; // 404 (no searches yet) or unauthenticated
  const j = (await res.json()) as ContentsResponse;
  const text = Buffer.from(j.content ?? "", "base64").toString("utf8");
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as ResearchLogEntry; } catch { return null; }
    })
    .filter((e): e is ResearchLogEntry => e !== null);
  return entries.slice(-limit).reverse();
}
