#!/usr/bin/env node
/**
 * BKREA MCP server — single-user (seth@bkrea.com), Google OAuth, stdio transport.
 *
 * IMPORTANT: stdout is the MCP transport. Never write to stdout (no console.log).
 * All diagnostics go to stderr via log().
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Constants (already-public values; safe to hardcode)
// ────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://nmxrnuxhgdooaluaslnd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5teHJudXhoZ2Rvb2FsdWFzbG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzMzMzMsImV4cCI6MjA4MzIwOTMzM30.FsO6ciixFrufalkeuhfVmerBgm6tM2S75Bl88a5r454";
const ALLOWED_EMAIL = "seth@bkrea.com";

const CALLBACK_PORT = 53682;
const CALLBACK_PATH = "/callback";
const REDIRECT_TO = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const SESSION_DIR = join(homedir(), ".bkrea-mcp");
const SESSION_FILE = join(SESSION_DIR, "session.json");

const WRITES_ENABLED = process.env.BKREA_ENABLE_WRITES === "1";
const APP_BASE = "https://ai.agent.bkrea.xyz";

// Best-guess searchable columns per table. If a query errors with "column does
// not exist", adjust the relevant list here (see README).
// Verified against the live BKREA schema (Supabase via Lovable).
const SEARCH_COLS = {
  deals: ["deal_name", "address", "neighborhood", "nickname", "property_address", "owner_name"],
  listings: ["listing_address", "owner_name", "territory"],
  companies: ["name", "domain"],
  contactsHubspot: ["firstname", "lastname", "full_name", "email", "phone", "mobilephone"],
  contactsCache: ["first_name", "last_name", "email", "phone", "mobile_phone", "company_name"],
  comps: ["address", "neighborhood", "notes"],
  permits: ["normalized_address", "work_type", "job_description", "owner_name"],
  kb: ["title", "content", "slug"],
};
const ME_COLS = {
  leadAssigned: "user_id",
  leadCreatedBy: "user_id",
  commissionBroker: "origination_broker_id",
  kpiUser: "user_id",
};

const log = (...a: unknown[]) => console.error("[bkrea-mcp]", ...a);
const nowSec = () => Math.floor(Date.now() / 1000);

// ────────────────────────────────────────────────────────────────────────────
// Session / auth
// ────────────────────────────────────────────────────────────────────────────
interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  email: string;
  user_id: string;
}
let session: Session | null = null;

function loadSession(): Session | null {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Session;
  } catch {
    return null;
  }
}
function saveSession(s: Session): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
  chmodSync(SESSION_FILE, 0o600);
}

async function fetchUser(token: string): Promise<{ id: string; email: string }> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  });
  if (!r.ok) throw new Error(`auth/user failed: ${r.status}`);
  const u = (await r.json()) as { id: string; email: string };
  return { id: u.id, email: (u.email ?? "").toLowerCase() };
}

async function refreshSession(refresh_token: string): Promise<Session> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token }),
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status}`);
  const d = (await r.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    user?: { id: string; email: string };
  };
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: nowSec() + (d.expires_in ?? 3600),
    email: (d.user?.email ?? session?.email ?? "").toLowerCase(),
    user_id: d.user?.id ?? session?.user_id ?? "",
  };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch (e) {
    log("could not open browser automatically. Open this URL manually:\n", url);
  }
}

const CALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>BKREA sign-in</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:100vh;margin:0}</style></head>
<body><div id="m">Finishing sign-in…</div>
<script>
  var frag = location.hash.slice(1);
  fetch("/finish",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:frag})
    .then(function(r){return r.text()})
    .then(function(){document.getElementById("m").innerHTML="<h2>Signed in ✓</h2><p>You can return to Claude. This tab can be closed.</p>"})
    .catch(function(){document.getElementById("m").innerHTML="<h2>Sign-in failed</h2><p>Check the BKREA MCP server logs.</p>"});
</script></body></html>`;

async function interactiveLogin(): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (req.method === "GET" && url.pathname === CALLBACK_PATH) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(CALLBACK_HTML);
        return;
      }
      if (req.method === "POST" && url.pathname === "/finish") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const p = new URLSearchParams(body);
            const access_token = p.get("access_token");
            const refresh_token = p.get("refresh_token");
            const expires_in = Number(p.get("expires_in") ?? "3600");
            if (!access_token || !refresh_token) throw new Error("No tokens in OAuth callback");
            const user = await fetchUser(access_token);
            if (user.email !== ALLOWED_EMAIL) {
              res.writeHead(403, { "Content-Type": "text/plain" });
              res.end("forbidden");
              cleanup();
              reject(new Error(`Refusing to start: signed in as ${user.email}; only ${ALLOWED_EMAIL} is allowed.`));
              return;
            }
            const s: Session = {
              access_token,
              refresh_token,
              expires_at: nowSec() + expires_in,
              email: user.email,
              user_id: user.id,
            };
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            cleanup();
            resolve(s);
          } catch (e) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("error");
            cleanup();
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Sign-in timed out after 5 minutes."));
    }, 5 * 60 * 1000);

    function cleanup() {
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }

    server.on("error", (e) => {
      cleanup();
      reject(new Error(`Could not start local callback server on :${CALLBACK_PORT} — ${e.message}`));
    });

    server.listen(CALLBACK_PORT, () => {
      const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(REDIRECT_TO)}`;
      log("Opening browser for Google sign-in…");
      log("If it doesn't open, visit:\n" + authUrl);
      openBrowser(authUrl);
    });
  });
}

/** Ensure we hold a valid (non-expired) session, refreshing or logging in. */
async function ensureSession(): Promise<void> {
  if (!session) session = loadSession();
  if (session) {
    if (session.expires_at - nowSec() > 60) return;
    try {
      session = await refreshSession(session.refresh_token);
      saveSession(session);
      return;
    } catch (e) {
      log("Refresh failed; re-authenticating.", e instanceof Error ? e.message : e);
      session = null;
    }
  }
  session = await interactiveLogin();
  saveSession(session);
  log(`Signed in as ${session.email}.`);
}

async function getClient(): Promise<SupabaseClient> {
  await ensureSession();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session!.access_token}` } },
  });
}
async function meId(): Promise<string> {
  await ensureSession();
  return session!.user_id;
}
async function callFunction(name: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  await ensureSession();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session!.access_token}`,
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* non-JSON */
  }
  return { ok: r.ok, status: r.status, data };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
interface PgError {
  code?: string;
  message?: string;
  hint?: string;
  details?: string;
}
function pgErr(error: PgError): never {
  const code = error?.code;
  const msg = error?.message ?? String(error);
  if (code === "42501" || /permission denied|row-level security|rls/i.test(msg)) {
    throw new Error("Permission denied — your role doesn't allow this action.");
  }
  if (code === "42703") {
    throw new Error(`Schema mismatch — a referenced column doesn't exist (${msg}). Adjust SEARCH_COLS/ME_COLS in the server.`);
  }
  throw new Error(`Database error${code ? ` [${code}]` : ""}: ${msg}${error?.hint ? ` (hint: ${error.hint})` : ""}`);
}

type ToolResult = { content: { type: "text"; text: string }[] };
function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function listResult(items: unknown[], offset: number, limit: number, total?: number | null): ToolResult {
  return ok({
    items,
    next_cursor: items.length === limit ? String(offset + limit) : null,
    ...(total != null ? { total_estimate: total } : {}),
  });
}
const clampLimit = (l?: number) => Math.min(Math.max(l ?? 25, 1), 50);
const parseCursor = (c?: string) => {
  const n = c ? Number(c) : 0;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};
function ilikeOr(cols: string[], q: string): string {
  const safe = q.replace(/[%,()]/g, " ").trim();
  return cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
}
function rowUrl(path: string, id: string | number): string {
  return `${APP_BASE}/${path}/${id}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Server + tools
// ────────────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "bkrea", version: "1.0.0" });

const limitSchema = z.number().int().positive().max(50).optional();
const cursorSchema = z.string().optional();

// 1. whoami
server.registerTool(
  "whoami",
  { description: "Return the signed-in user's profile row.", inputSchema: {} },
  async () => {
    const c = await getClient();
    const id = await meId();
    let { data, error } = await c.from("profiles").select("*").eq("id", id).maybeSingle();
    if (error) pgErr(error);
    if (!data) {
      ({ data, error } = await c.from("profiles").select("*").eq("email", ALLOWED_EMAIL).maybeSingle());
      if (error) pgErr(error);
    }
    return ok({ email: ALLOWED_EMAIL, user_id: id, profile: data });
  },
);

// 2. search_deals
server.registerTool(
  "search_deals",
  {
    description: "Search HubSpot deals by free text, optionally filtered by stage or broker.",
    inputSchema: { q: z.string().optional(), stage: z.string().optional(), broker: z.string().optional(), limit: limitSchema, cursor: cursorSchema },
  },
  async ({ q, stage, broker, limit, cursor }) => {
    const c = await getClient();
    const lim = clampLimit(limit);
    const off = parseCursor(cursor);
    let query = c.from("hubspot_deals").select("*", { count: "estimated" });
    if (q) query = query.or(ilikeOr(SEARCH_COLS.deals, q));
    if (stage) query = query.ilike("deal_stage", `%${stage}%`);
    if (broker) query = query.ilike("broker_name", `%${broker}%`);
    const { data, error, count } = await query.range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  },
);

// 3. get_deal
server.registerTool(
  "get_deal",
  { description: "Get a deal by id plus its associated contacts (deal_contacts).", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const c = await getClient();
    const { data: deal, error } = await c.from("hubspot_deals").select("*").eq("id", id).maybeSingle();
    if (error) pgErr(error);
    if (!deal) throw new Error(`Deal ${id} not found.`);
    const { data: contacts, error: cErr } = await c.from("deal_contacts").select("*").eq("deal_id", id);
    if (cErr) pgErr(cErr);
    return ok({ deal, contacts: contacts ?? [] });
  },
);

// 4. search_listings
server.registerTool(
  "search_listings",
  { description: "Search HubSpot listings by free text, optionally filtered by listing type.", inputSchema: { q: z.string().optional(), listing_type: z.string().optional(), limit: limitSchema, cursor: cursorSchema } },
  async ({ q, listing_type, limit, cursor }) => {
    const c = await getClient();
    const lim = clampLimit(limit);
    const off = parseCursor(cursor);
    let query = c.from("hubspot_listings").select("*", { count: "estimated" });
    if (q) query = query.or(ilikeOr(SEARCH_COLS.listings, q));
    if (listing_type) query = query.ilike("listing_type", `%${listing_type}%`);
    const { data, error, count } = await query.range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  },
);

// 5. get_listing
server.registerTool(
  "get_listing",
  { description: "Get a listing by id plus its linked deal, if any.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const c = await getClient();
    const { data: listing, error } = await c.from("hubspot_listings").select("*").eq("id", id).maybeSingle();
    if (error) pgErr(error);
    if (!listing) throw new Error(`Listing ${id} not found.`);
    let deal: unknown = null;
    const dealId = (listing as Record<string, unknown>).deal_id;
    if (dealId) {
      const { data } = await c.from("hubspot_deals").select("*").eq("id", dealId as string).maybeSingle();
      deal = data;
    }
    return ok({ listing, deal });
  },
);

// 6. search_companies
server.registerTool(
  "search_companies",
  { description: "Search HubSpot companies by free text.", inputSchema: { q: z.string().optional(), limit: limitSchema, cursor: cursorSchema } },
  async ({ q, limit, cursor }) => {
    const c = await getClient();
    const lim = clampLimit(limit);
    const off = parseCursor(cursor);
    let query = c.from("hubspot_companies").select("*", { count: "estimated" });
    if (q) query = query.or(ilikeOr(SEARCH_COLS.companies, q));
    const { data, error, count } = await query.range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  },
);

// 7. search_contacts (merge hubspot_contacts + bk_list_contacts_cache, dedupe)
server.registerTool(
  "search_contacts",
  { description: "Search contacts across hubspot_contacts and bk_list_contacts_cache, merged and de-duplicated by phone/email.", inputSchema: { q: z.string().optional(), limit: limitSchema } },
  async ({ q, limit }) => {
    const c = await getClient();
    const lim = clampLimit(limit);
    const [hs, cache] = await Promise.all([
      (q ? c.from("hubspot_contacts").select("*").or(ilikeOr(SEARCH_COLS.contactsHubspot, q)) : c.from("hubspot_contacts").select("*")).limit(lim),
      (q ? c.from("bk_list_contacts_cache").select("*").or(ilikeOr(SEARCH_COLS.contactsCache, q)) : c.from("bk_list_contacts_cache").select("*")).limit(lim),
    ]);
    if (hs.error) pgErr(hs.error);
    if (cache.error) pgErr(cache.error);
    const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9@.]/g, "");
    const seen = new Set<string>();
    const merged: Record<string, unknown>[] = [];
    for (const row of [...(hs.data ?? []), ...(cache.data ?? [])] as Record<string, unknown>[]) {
      const key = norm(row.phone) || norm(row.email) || JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length >= lim) break;
    }
    return ok({ items: merged, next_cursor: null, total_estimate: merged.length });
  },
);

// 8. search_comps
server.registerTool(
  "search_comps",
  {
    description: "Search comparable sales (comps) by text/neighborhood/price range.",
    inputSchema: { q: z.string().optional(), neighborhood: z.string().optional(), min_price: z.number().optional(), max_price: z.number().optional(), limit: limitSchema, cursor: cursorSchema },
  },
  async ({ q, neighborhood, min_price, max_price, limit, cursor }) => {
    const c = await getClient();
    const lim = clampLimit(limit);
    const off = parseCursor(cursor);
    let query = c.from("comps").select("*", { count: "estimated" });
    if (q) query = query.or(ilikeOr(SEARCH_COLS.comps, q));
    if (neighborhood) query = query.ilike("neighborhood", `%${neighborhood}%`);
    if (min_price != null) query = query.gte("sale_price", min_price);
    if (max_price != null) query = query.lte("sale_price", max_price);
    const { data, error, count } = await query.order("sale_date", { ascending: false }).range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  },
);

// 9. search_permits
server.registerTool(
  "search_permits",
  { description: "Search NYC permits by address, borough, and/or work type.", inputSchema: { address: z.string().optional(), borough: z.string().optional(), work_type: z.string().optional(), limit: limitSchema, cursor: cursorSchema } },
  async ({ address, borough, work_type, limit, cursor }) => {
    const c = await getClient();
    const lim = clampLimit(limit);
    const off = parseCursor(cursor);
    let query = c.from("nyc_permits").select("*", { count: "estimated" });
    if (address) query = query.ilike("normalized_address", `%${address}%`);
    if (borough) query = query.ilike("borough", `%${borough}%`);
    if (work_type) query = query.ilike("work_type", `%${work_type}%`);
    const { data, error, count } = await query.range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  },
);

// 10. search_knowledgebase (edge function beacon-search, else kb_pages text search)
server.registerTool(
  "search_knowledgebase",
  { description: "Search the knowledge base (semantic via beacon-search edge function, falling back to text search over kb_pages).", inputSchema: { q: z.string(), limit: limitSchema } },
  async ({ q, limit }) => {
    const lim = clampLimit(limit);
    const fn = await callFunction("beacon-search", { query: q, q, limit: lim });
    if (fn.ok) return ok({ source: "beacon-search", results: fn.data });
    log(`beacon-search unavailable (status ${fn.status}); falling back to kb_pages.`);
    const c = await getClient();
    const { data, error } = await c.from("kb_pages").select("*").or(ilikeOr(SEARCH_COLS.kb, q)).limit(lim);
    if (error) pgErr(error);
    return ok({ source: "kb_pages", results: data ?? [] });
  },
);

// 11. get_kb_page
server.registerTool(
  "get_kb_page",
  { description: "Get a knowledge-base page by slug (returns markdown content).", inputSchema: { slug: z.string() } },
  async ({ slug }) => {
    const c = await getClient();
    const { data, error } = await c.from("kb_pages").select("*").eq("slug", slug).maybeSingle();
    if (error) pgErr(error);
    if (!data) throw new Error(`KB page "${slug}" not found.`);
    return ok(data);
  },
);

// 12. get_kpi_leaderboard
server.registerTool(
  "get_kpi_leaderboard",
  { description: "KPI leaderboard for the 7 days starting on week_start (kpi_entries grouped by user).", inputSchema: { week_start: z.string().describe("ISO date, e.g. 2026-06-01") } },
  async ({ week_start }) => {
    const c = await getClient();
    const end = new Date(new Date(`${week_start}T00:00:00Z`).getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await c.from("kpi_entries").select("*").gte("entry_date", week_start).lt("entry_date", end);
    if (error) pgErr(error);
    const byUser = new Map<string, { user_id: string; entries: number; rows: unknown[] }>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const uid = String(row[ME_COLS.kpiUser] ?? "unknown");
      const g = byUser.get(uid) ?? { user_id: uid, entries: 0, rows: [] };
      g.entries += 1;
      g.rows.push(row);
      byUser.set(uid, g);
    }
    const leaderboard = [...byUser.values()].sort((a, b) => b.entries - a.entries);
    return ok({ week_start, leaderboard });
  },
);

// 13. list_my_leads
server.registerTool(
  "list_my_leads",
  { description: "List leads assigned to me (lead_list).", inputSchema: { limit: limitSchema, cursor: cursorSchema } },
  async ({ limit, cursor }) => {
    const c = await getClient();
    const id = await meId();
    const lim = clampLimit(limit);
    const off = parseCursor(cursor);
    const { data, error, count } = await c
      .from("lead_list")
      .select("*", { count: "estimated" })
      .eq(ME_COLS.leadAssigned, id)
      .range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  },
);

// 14. get_broker_commissions
server.registerTool(
  "get_broker_commissions",
  { description: "Get my broker commission calculations, optionally for a given year.", inputSchema: { year: z.number().int().optional() } },
  async ({ year }) => {
    const c = await getClient();
    const id = await meId();
    let query = c.from("broker_commission_calculations").select("*").eq(ME_COLS.commissionBroker, id);
    if (year != null) query = query.gte("deal_date", `${year}-01-01`).lte("deal_date", `${year}-12-31`);
    const { data, error } = await query.limit(50);
    if (error) pgErr(error);
    return ok({ items: data ?? [] });
  },
);

// ── Write tools (only registered when BKREA_ENABLE_WRITES=1) ────────────────
if (WRITES_ENABLED) {
  // 1. create_lead
  server.registerTool(
    "create_lead",
    { description: "Create a new lead in lead_list (created_by = me).", inputSchema: { full_name: z.string(), phone: z.string().optional(), email: z.string().optional(), source: z.string().optional(), notes: z.string().optional() } },
    async ({ full_name, phone, email, source, notes }) => {
      const c = await getClient();
      const id = await meId();
      const { data, error } = await c
        .from("lead_list")
        .insert({ full_name, phone, email, source, notes, [ME_COLS.leadCreatedBy]: id })
        .select("id")
        .single();
      if (error) pgErr(error);
      const leadId = (data as { id: string | number }).id;
      return ok({ id: leadId, url: rowUrl("leads", leadId) });
    },
  );

  // 2. add_comp
  server.registerTool(
    "add_comp",
    { description: "Add a comparable sale to comps (requires comps_importer or super_admin role).", inputSchema: { address: z.string(), sale_price: z.number(), sale_date: z.string().describe("ISO date"), units: z.number().int().optional(), sqft: z.number().optional(), notes: z.string().optional() } },
    async ({ address, sale_price, sale_date, units, sqft, notes }) => {
      const c = await getClient();
      const { data, error } = await c
        .from("comps")
        .insert({ address, sale_price, sale_date, units, sqft, notes })
        .select("id")
        .single();
      if (error) pgErr(error);
      const compId = (data as { id: string | number }).id;
      return ok({ id: compId, url: rowUrl("comps", compId) });
    },
  );

  // 3. log_feedback
  server.registerTool(
    "log_feedback",
    { description: "Log deal feedback (edge function log-deal-feedback, falling back to a direct insert).", inputSchema: { deal_id: z.string(), contact_id: z.string(), status: z.string(), pass_reason: z.string().optional(), notes: z.string().optional() } },
    async ({ deal_id, contact_id, status, pass_reason, notes }) => {
      const payload = { deal_id, contact_id, status, pass_reason, notes };
      const fn = await callFunction("log-deal-feedback", payload);
      if (fn.ok) return ok({ via: "log-deal-feedback", result: fn.data });
      log(`log-deal-feedback unavailable (status ${fn.status}); inserting into deal_feedback.`);
      const c = await getClient();
      const id = await meId();
      const { data, error } = await c
        .from("deal_feedback")
        .insert({ ...payload, created_by: id })
        .select("id")
        .single();
      if (error) pgErr(error);
      const fid = (data as { id: string | number }).id;
      return ok({ via: "deal_feedback", id: fid, url: rowUrl("deals", deal_id) });
    },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Best-effort silent restore so the common case has no startup delay. If
  // there's no valid session, we DON'T block the MCP handshake on a browser —
  // interactive login happens lazily on the first tool call (via ensureSession).
  try {
    session = loadSession();
    if (session && session.expires_at - nowSec() <= 60) {
      session = await refreshSession(session.refresh_token);
      saveSession(session);
    }
    if (session && session.email && session.email !== ALLOWED_EMAIL) {
      log(`Cached session is for ${session.email}, not ${ALLOWED_EMAIL}. Ignoring it.`);
      session = null;
    }
    if (session) log(`Restored session for ${session.email}.`);
    else log("No cached session — will sign in on first tool call.");
  } catch (e) {
    log("Session restore failed; will sign in on first tool call.", e instanceof Error ? e.message : e);
    session = null;
  }

  log(`Writes ${WRITES_ENABLED ? "ENABLED" : "disabled"} (set BKREA_ENABLE_WRITES=1 to enable).`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("BKREA MCP server ready.");
}

main().catch((e) => {
  log("Fatal:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
