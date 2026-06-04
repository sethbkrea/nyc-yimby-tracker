/**
 * BKREA tool registration for the remote (HTTP) MCP server.
 *
 * Auth model (headless, no interactive login):
 *   - The server holds seth@bkrea.com's Supabase refresh token in
 *     SUPABASE_REFRESH_TOKEN. Each request exchanges it for a short-lived
 *     access token and creates a Supabase client scoped with that JWT, so RLS
 *     applies exactly as it would for seth in the app.
 *   - Refresh-token rotation is handled in-memory within a warm instance; for
 *     reliability across cold starts, DISABLE refresh-token rotation in
 *     Supabase (Authentication → Sessions) — see README.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SUPABASE_URL = "https://nmxrnuxhgdooaluaslnd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5teHJudXhoZ2Rvb2FsdWFzbG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzMzMzMsImV4cCI6MjA4MzIwOTMzM30.FsO6ciixFrufalkeuhfVmerBgm6tM2S75Bl88a5r454";
const ALLOWED_EMAIL = "seth@bkrea.com";
const APP_BASE = "https://ai.agent.bkrea.xyz";

const SEARCH_COLS = {
  deals: ["dealname", "description"],
  listings: ["address", "name", "description"],
  companies: ["name", "domain"],
  contactsHubspot: ["firstname", "lastname", "email", "phone", "company"],
  contactsCache: ["full_name", "name", "email", "phone"],
  comps: ["address", "neighborhood", "notes"],
  permits: ["address", "work_type", "job_description", "owner_name"],
  kb: ["title", "content", "slug"],
};
const ME_COLS = {
  leadAssigned: "assigned_broker_id",
  leadCreatedBy: "created_by",
  commissionBroker: "broker_id",
  kpiUser: "user_id",
};

const nowSec = () => Math.floor(Date.now() / 1000);
const log = (...a: unknown[]) => console.error("[bkrea-mcp]", ...a);

// ── Token / client ──────────────────────────────────────────────────────────
let tokenCache: { access: string; exp: number; refresh: string; userId: string } | null = null;

async function getAccess(): Promise<{ token: string; userId: string }> {
  if (tokenCache && tokenCache.exp - nowSec() > 60) {
    return { token: tokenCache.access, userId: tokenCache.userId };
  }
  const refresh = tokenCache?.refresh ?? process.env.SUPABASE_REFRESH_TOKEN;
  if (!refresh) throw new Error("Server misconfigured: SUPABASE_REFRESH_TOKEN is not set.");
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!r.ok) {
    throw new Error(
      `Supabase auth refresh failed (${r.status}). The SUPABASE_REFRESH_TOKEN is likely stale — regenerate it (npm run get-token) or disable refresh-token rotation in Supabase.`,
    );
  }
  const d = (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    user?: { id: string; email: string };
  };
  const email = (d.user?.email ?? "").toLowerCase();
  if (email && email !== ALLOWED_EMAIL) {
    throw new Error(`Refresh token belongs to ${email}, not ${ALLOWED_EMAIL}.`);
  }
  tokenCache = {
    access: d.access_token,
    exp: nowSec() + (d.expires_in ?? 3600),
    refresh: d.refresh_token ?? refresh,
    userId: d.user?.id ?? tokenCache?.userId ?? "",
  };
  return { token: tokenCache.access, userId: tokenCache.userId };
}

async function getClient(): Promise<SupabaseClient> {
  const { token } = await getAccess();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
async function meId(): Promise<string> {
  return (await getAccess()).userId;
}
async function callFunction(name: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { token } = await getAccess();
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
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

// ── Helpers ──────────────────────────────────────────────────────────────────
interface PgError {
  code?: string;
  message?: string;
  hint?: string;
}
function pgErr(error: PgError): never {
  const code = error?.code;
  const msg = error?.message ?? String(error);
  if (code === "42501" || /permission denied|row-level security|rls/i.test(msg)) {
    throw new Error("Permission denied — your role doesn't allow this action.");
  }
  if (code === "42703") {
    throw new Error(`Schema mismatch — a referenced column doesn't exist (${msg}). Adjust SEARCH_COLS/ME_COLS.`);
  }
  throw new Error(`Database error${code ? ` [${code}]` : ""}: ${msg}${error?.hint ? ` (hint: ${error.hint})` : ""}`);
}

type ToolResult = { content: { type: "text"; text: string }[] };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
function listResult(items: unknown[], offset: number, limit: number, total?: number | null): ToolResult {
  return ok({ items, next_cursor: items.length === limit ? String(offset + limit) : null, ...(total != null ? { total_estimate: total } : {}) });
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
const rowUrl = (path: string, id: string | number) => `${APP_BASE}/${path}/${id}`;

// ── Tool registration ─────────────────────────────────────────────────────────
export function registerBkreaTools(server: McpServer, writesEnabled: boolean): void {
  const limit = z.number().int().positive().max(50).optional();
  const cursor = z.string().optional();

  server.tool("whoami", "Return the signed-in user's profile row.", {}, async () => {
    const c = await getClient();
    const id = await meId();
    let res = await c.from("profiles").select("*").eq("id", id).maybeSingle();
    if (res.error) pgErr(res.error);
    if (!res.data) {
      res = await c.from("profiles").select("*").eq("email", ALLOWED_EMAIL).maybeSingle();
      if (res.error) pgErr(res.error);
    }
    return ok({ email: ALLOWED_EMAIL, user_id: id, profile: res.data });
  });

  server.tool(
    "search_deals",
    "Search HubSpot deals by free text, optionally filtered by stage or broker.",
    { q: z.string().optional(), stage: z.string().optional(), broker: z.string().optional(), limit, cursor },
    async ({ q, stage, broker, limit: l, cursor: cur }) => {
      const c = await getClient();
      const lim = clampLimit(l);
      const off = parseCursor(cur);
      let query = c.from("hubspot_deals").select("*", { count: "estimated" });
      if (q) query = query.or(ilikeOr(SEARCH_COLS.deals, q));
      if (stage) query = query.eq("dealstage", stage);
      if (broker) query = query.eq("broker", broker);
      const { data, error, count } = await query.range(off, off + lim - 1);
      if (error) pgErr(error);
      return listResult(data ?? [], off, lim, count);
    },
  );

  server.tool("get_deal", "Get a deal by id plus its associated contacts (deal_contacts).", { id: z.string() }, async ({ id }) => {
    const c = await getClient();
    const { data: deal, error } = await c.from("hubspot_deals").select("*").eq("id", id).maybeSingle();
    if (error) pgErr(error);
    if (!deal) throw new Error(`Deal ${id} not found.`);
    const { data: contacts, error: cErr } = await c.from("deal_contacts").select("*").eq("deal_id", id);
    if (cErr) pgErr(cErr);
    return ok({ deal, contacts: contacts ?? [] });
  });

  server.tool(
    "search_listings",
    "Search HubSpot listings by free text, optionally filtered by status.",
    { q: z.string().optional(), status: z.string().optional(), limit, cursor },
    async ({ q, status, limit: l, cursor: cur }) => {
      const c = await getClient();
      const lim = clampLimit(l);
      const off = parseCursor(cur);
      let query = c.from("hubspot_listings").select("*", { count: "estimated" });
      if (q) query = query.or(ilikeOr(SEARCH_COLS.listings, q));
      if (status) query = query.eq("status", status);
      const { data, error, count } = await query.range(off, off + lim - 1);
      if (error) pgErr(error);
      return listResult(data ?? [], off, lim, count);
    },
  );

  server.tool("get_listing", "Get a listing by id plus its linked deal, if any.", { id: z.string() }, async ({ id }) => {
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
  });

  server.tool("search_companies", "Search HubSpot companies by free text.", { q: z.string().optional(), limit, cursor }, async ({ q, limit: l, cursor: cur }) => {
    const c = await getClient();
    const lim = clampLimit(l);
    const off = parseCursor(cur);
    let query = c.from("hubspot_companies").select("*", { count: "estimated" });
    if (q) query = query.or(ilikeOr(SEARCH_COLS.companies, q));
    const { data, error, count } = await query.range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  });

  server.tool(
    "search_contacts",
    "Search contacts across hubspot_contacts and bk_list_contacts_cache, merged and de-duplicated by phone/email.",
    { q: z.string().optional(), limit },
    async ({ q, limit: l }) => {
      const c = await getClient();
      const lim = clampLimit(l);
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

  server.tool(
    "search_comps",
    "Search comparable sales (comps) by text/neighborhood/price range.",
    { q: z.string().optional(), neighborhood: z.string().optional(), min_price: z.number().optional(), max_price: z.number().optional(), limit, cursor },
    async ({ q, neighborhood, min_price, max_price, limit: l, cursor: cur }) => {
      const c = await getClient();
      const lim = clampLimit(l);
      const off = parseCursor(cur);
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

  server.tool(
    "search_permits",
    "Search NYC permits by address, borough, and/or work type.",
    { address: z.string().optional(), borough: z.string().optional(), work_type: z.string().optional(), limit, cursor },
    async ({ address, borough, work_type, limit: l, cursor: cur }) => {
      const c = await getClient();
      const lim = clampLimit(l);
      const off = parseCursor(cur);
      let query = c.from("nyc_permits").select("*", { count: "estimated" });
      if (address) query = query.ilike("address", `%${address}%`);
      if (borough) query = query.ilike("borough", `%${borough}%`);
      if (work_type) query = query.ilike("work_type", `%${work_type}%`);
      const { data, error, count } = await query.range(off, off + lim - 1);
      if (error) pgErr(error);
      return listResult(data ?? [], off, lim, count);
    },
  );

  server.tool("search_knowledgebase", "Search the knowledge base (beacon-search edge function, falling back to text search over kb_pages).", { q: z.string(), limit }, async ({ q, limit: l }) => {
    const lim = clampLimit(l);
    const fn = await callFunction("beacon-search", { query: q, q, limit: lim });
    if (fn.ok) return ok({ source: "beacon-search", results: fn.data });
    log(`beacon-search unavailable (status ${fn.status}); falling back to kb_pages.`);
    const c = await getClient();
    const { data, error } = await c.from("kb_pages").select("*").or(ilikeOr(SEARCH_COLS.kb, q)).limit(lim);
    if (error) pgErr(error);
    return ok({ source: "kb_pages", results: data ?? [] });
  });

  server.tool("get_kb_page", "Get a knowledge-base page by slug (returns markdown content).", { slug: z.string() }, async ({ slug }) => {
    const c = await getClient();
    const { data, error } = await c.from("kb_pages").select("*").eq("slug", slug).maybeSingle();
    if (error) pgErr(error);
    if (!data) throw new Error(`KB page "${slug}" not found.`);
    return ok(data);
  });

  server.tool("get_kpi_leaderboard", "KPI leaderboard for a given week (kpi_entries grouped by user).", { week_start: z.string().describe("ISO date, e.g. 2026-06-01") }, async ({ week_start }) => {
    const c = await getClient();
    const { data, error } = await c.from("kpi_entries").select("*").eq("week_start", week_start);
    if (error) pgErr(error);
    const byUser = new Map<string, { user_id: string; entries: number; rows: unknown[] }>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const uid = String(row[ME_COLS.kpiUser] ?? "unknown");
      const g = byUser.get(uid) ?? { user_id: uid, entries: 0, rows: [] };
      g.entries += 1;
      g.rows.push(row);
      byUser.set(uid, g);
    }
    return ok({ week_start, leaderboard: [...byUser.values()].sort((a, b) => b.entries - a.entries) });
  });

  server.tool("list_my_leads", "List leads assigned to me (lead_list).", { limit, cursor }, async ({ limit: l, cursor: cur }) => {
    const c = await getClient();
    const id = await meId();
    const lim = clampLimit(l);
    const off = parseCursor(cur);
    const { data, error, count } = await c.from("lead_list").select("*", { count: "estimated" }).eq(ME_COLS.leadAssigned, id).range(off, off + lim - 1);
    if (error) pgErr(error);
    return listResult(data ?? [], off, lim, count);
  });

  server.tool("get_broker_commissions", "Get my broker commission calculations, optionally for a given year.", { year: z.number().int().optional() }, async ({ year }) => {
    const c = await getClient();
    const id = await meId();
    let query = c.from("broker_commission_calculations").select("*").eq(ME_COLS.commissionBroker, id);
    if (year != null) query = query.eq("year", year);
    const { data, error } = await query.limit(50);
    if (error) pgErr(error);
    return ok({ items: data ?? [] });
  });

  if (!writesEnabled) return;

  server.tool(
    "create_lead",
    "Create a new lead in lead_list (created_by = me).",
    { full_name: z.string(), phone: z.string().optional(), email: z.string().optional(), source: z.string().optional(), notes: z.string().optional() },
    async ({ full_name, phone, email, source, notes }) => {
      const c = await getClient();
      const id = await meId();
      const { data, error } = await c.from("lead_list").insert({ full_name, phone, email, source, notes, [ME_COLS.leadCreatedBy]: id }).select("id").single();
      if (error) pgErr(error);
      const leadId = (data as { id: string | number }).id;
      return ok({ id: leadId, url: rowUrl("leads", leadId) });
    },
  );

  server.tool(
    "add_comp",
    "Add a comparable sale to comps (requires comps_importer or super_admin role).",
    { address: z.string(), sale_price: z.number(), sale_date: z.string().describe("ISO date"), units: z.number().int().optional(), sqft: z.number().optional(), notes: z.string().optional() },
    async ({ address, sale_price, sale_date, units, sqft, notes }) => {
      const c = await getClient();
      const { data, error } = await c.from("comps").insert({ address, sale_price, sale_date, units, sqft, notes }).select("id").single();
      if (error) pgErr(error);
      const compId = (data as { id: string | number }).id;
      return ok({ id: compId, url: rowUrl("comps", compId) });
    },
  );

  server.tool(
    "log_feedback",
    "Log deal feedback (edge function log-deal-feedback, falling back to a direct insert).",
    { deal_id: z.string(), contact_id: z.string(), status: z.string(), pass_reason: z.string().optional(), notes: z.string().optional() },
    async ({ deal_id, contact_id, status, pass_reason, notes }) => {
      const payload = { deal_id, contact_id, status, pass_reason, notes };
      const fn = await callFunction("log-deal-feedback", payload);
      if (fn.ok) return ok({ via: "log-deal-feedback", result: fn.data });
      log(`log-deal-feedback unavailable (status ${fn.status}); inserting into deal_feedback.`);
      const c = await getClient();
      const id = await meId();
      const { data, error } = await c.from("deal_feedback").insert({ ...payload, created_by: id }).select("id").single();
      if (error) pgErr(error);
      const fid = (data as { id: string | number }).id;
      return ok({ via: "deal_feedback", id: fid, url: rowUrl("deals", deal_id) });
    },
  );
}
