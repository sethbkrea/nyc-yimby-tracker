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
