/**
 * Self-contained BKREA MCP server with its own OAuth 2.1 + per-user auth.
 *
 * Does NOT depend on Supabase's OAuth server (disabled) or mcp-tools' OAuth.
 * Flow:
 *   /.well-known/*           → our OAuth metadata
 *   /oauth/register          → dynamic client registration (echoes a client_id)
 *   /oauth/authorize  (GET)  → our email/password login form
 *   /oauth/authorize  (POST) → password-grant against Supabase, issue our code
 *   /oauth/token             → code & refresh grants; tokens encode the user's
 *                              Supabase session (encrypted, stateless)
 *   POST /api/mcp            → MCP JSON-RPC; bearer decodes to the user's JWT,
 *                              tools query Supabase directly so RLS scopes to them
 *
 * No credentials are stored — each user signs in with their own BKREA login.
 */
import crypto from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

const SUPABASE = "https://nmxrnuxhgdooaluaslnd.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5teHJudXhoZ2Rvb2FsdWFzbG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzMzMzMsImV4cCI6MjA4MzIwOTMzM30.FsO6ciixFrufalkeuhfVmerBgm6tM2S75Bl88a5r454";
const PROXY = "https://bkrea-mcp-remote.vercel.app/api/mcp";
const WRITES = process.env.BKREA_ENABLE_WRITES === "1";

// ── Crypto (stateless tokens) ───────────────────────────────────────────────
const KEY = crypto.createHash("sha256").update(process.env.TOKEN_SECRET ?? ANON_KEY).digest();
function seal(obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64url");
}
function open<T = Record<string, unknown>>(token: string): T | null {
  try {
    const raw = Buffer.from(token, "base64url");
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8")) as T;
  } catch { return null; }
}
const nowSec = () => Math.floor(Date.now() / 1000);
const j = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra } });

// ── Supabase auth ────────────────────────────────────────────────────────────
async function passwordGrant(email: string, password: string) {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) return null;
  return await r.json() as { access_token: string; refresh_token: string; expires_in: number };
}
async function refreshGrant(refresh_token: string) {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ refresh_token }),
  });
  if (!r.ok) return null;
  return await r.json() as { access_token: string; refresh_token: string; expires_in: number };
}

// ── OAuth endpoints ──────────────────────────────────────────────────────────
function wellKnownAuthServer() {
  return j({
    issuer: PROXY,
    authorization_endpoint: `${PROXY}/oauth/authorize`,
    token_endpoint: `${PROXY}/oauth/token`,
    registration_endpoint: `${PROXY}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
}
function wellKnownResource() {
  return j({ resource: PROXY, authorization_servers: [PROXY], bearer_methods_supported: ["header"] });
}
async function registerClient(req: Request) {
  // We don't track clients; accept any registration, echo what was sent (RFC 7591).
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const id = "bkrea_" + crypto.randomBytes(12).toString("hex");
  return j({
    client_id: id,
    client_id_issued_at: nowSec(),
    redirect_uris: body.redirect_uris ?? [],
    client_name: body.client_name ?? "Claude",
    grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: body.response_types ?? ["code"],
    token_endpoint_auth_method: "none",
    scope: body.scope ?? "mcp",
  }, 201);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function loginForm(p: URLSearchParams, error?: string) {
  const hid = (k: string) => `<input type="hidden" name="${k}" value="${esc(p.get(k) ?? "")}">`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to BKREA</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:36px 40px;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.logo{font-size:22px;font-weight:700;margin-bottom:6px}.sub{color:#888;font-size:13px;margin-bottom:26px}
label{display:block;font-size:13px;color:#aaa;margin-bottom:6px}input[type=email],input[type=password]{width:100%;background:#111;border:1px solid #333;border-radius:8px;color:#f0f0f0;font-size:15px;padding:11px 14px;outline:none}
input:focus{border-color:#555}.field{margin-bottom:18px}button{width:100%;background:#fff;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:600;padding:12px;cursor:pointer;margin-top:8px}
button:hover{opacity:.9}.err{background:#2a0d0d;border:1px solid #5a1a1a;border-radius:8px;color:#f87171;font-size:13px;padding:10px 14px;margin-bottom:18px}.note{color:#555;font-size:12px;margin-top:18px;text-align:center}</style></head>
<body><div class="card"><div class="logo">BKREA</div><div class="sub">Sign in to connect Claude to your account</div>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="POST" action="${PROXY}/oauth/authorize">
${hid("client_id")}${hid("redirect_uri")}${hid("state")}${hid("code_challenge")}${hid("code_challenge_method")}${hid("scope")}
<div class="field"><label>Email</label><input name="email" type="email" placeholder="you@bkrea.com" autocomplete="email" required autofocus></div>
<div class="field"><label>Password</label><input name="password" type="password" placeholder="••••••••" autocomplete="current-password" required></div>
<button type="submit">Sign in &amp; connect</button></form>
<div class="note">Your credentials go directly to BKREA and are never stored here.</div></div></body></html>`,
    { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleAuthorize(req: Request): Promise<Response> {
  if (req.method === "GET") return loginForm(new URL(req.url).searchParams);

  const form = await req.formData();
  const p = new URLSearchParams();
  for (const k of ["client_id","redirect_uri","state","code_challenge","code_challenge_method","scope"])
    p.set(k, String(form.get(k) ?? ""));
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  const session = await passwordGrant(email, password);
  if (!session) return loginForm(p, "Invalid email or password. Please try again.");

  // Issue our auth code: encrypted, carries the user's Supabase session + PKCE.
  const code = seal({
    rt: session.refresh_token, at: session.access_token,
    cc: p.get("code_challenge"), exp: nowSec() + 600,
  });
  const dest = new URL(p.get("redirect_uri")!);
  dest.searchParams.set("code", code);
  dest.searchParams.set("state", p.get("state") ?? "");
  return Response.redirect(dest.toString(), 302);
}

async function handleToken(req: Request): Promise<Response> {
  const ct = req.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await req.json() as Record<string, string>
    : Object.fromEntries((new URLSearchParams(await req.text())).entries());

  if (body.grant_type === "authorization_code") {
    const data = open<{ rt: string; at: string; cc: string; exp: number }>(body.code ?? "");
    if (!data || data.exp < nowSec()) return j({ error: "invalid_grant" }, 400);
    // Verify PKCE
    if (data.cc) {
      const v = body.code_verifier ?? "";
      const challenge = crypto.createHash("sha256").update(v).digest("base64url");
      if (challenge !== data.cc) return j({ error: "invalid_grant", error_description: "PKCE failed" }, 400);
    }
    return j({
      access_token: seal({ at: data.at, exp: nowSec() + 3000 }),
      refresh_token: seal({ rt: data.rt }),
      token_type: "Bearer", expires_in: 3000, scope: "mcp",
    });
  }

  if (body.grant_type === "refresh_token") {
    const data = open<{ rt: string }>(body.refresh_token ?? "");
    if (!data) return j({ error: "invalid_grant" }, 400);
    const fresh = await refreshGrant(data.rt);
    if (!fresh) return j({ error: "invalid_grant", error_description: "session expired" }, 400);
    return j({
      access_token: seal({ at: fresh.access_token, exp: nowSec() + 3000 }),
      refresh_token: seal({ rt: fresh.refresh_token }),
      token_type: "Bearer", expires_in: 3000, scope: "mcp",
    });
  }

  return j({ error: "unsupported_grant_type" }, 400);
}

// Extract the user's Supabase access token from our bearer.
function userToken(req: Request): string | null {
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!auth) return null;
  const data = open<{ at: string; exp: number }>(auth);
  if (!data || (data.exp && data.exp < nowSec())) return null;
  return data.at;
}

// ── Supabase data helpers (queried with the user's JWT → RLS) ────────────────
async function sb(token: string, path: string): Promise<unknown> {
  const r = await fetch(`${SUPABASE}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}
const enc = encodeURIComponent;
function ilikeOr(cols: string[], q: string): string {
  const safe = q.replace(/[%,()]/g, " ").trim();
  return `or=(${cols.map((c) => `${c}.ilike.*${safe}*`).join(",")})`;
}

// ── MCP tools (verified BKREA schema) ────────────────────────────────────────
interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; run: (token: string, args: Record<string, unknown>) => Promise<unknown>; }
const strProp = (d: string) => ({ type: "string", description: d });
const numProp = (d: string) => ({ type: "number", description: d });
const lim = (a: Record<string, unknown>) => Math.min(Math.max(Number(a.limit ?? 25) || 25, 1), 50);

const TOOLS: Tool[] = [
  { name: "whoami", description: "Your BKREA profile.", inputSchema: { type: "object", properties: {} },
    run: async (t) => {
      const u = await fetch(`${SUPABASE}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${t}` } }).then((r) => r.json()) as { id: string; email: string };
      const prof = await sb(t, `profiles?select=*&id=eq.${u.id}&limit=1`) as unknown[];
      return { user_id: u.id, email: u.email, profile: prof[0] ?? null };
    } },
  { name: "search_deals", description: "Search HubSpot deals by text (deal name, address, owner).",
    inputSchema: { type: "object", properties: { q: strProp("search text"), limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `hubspot_deals?select=*${a.q ? `&${ilikeOr(["deal_name","address","neighborhood","nickname","property_address","owner_name"], String(a.q))}` : ""}&limit=${lim(a)}`) },
  { name: "search_listings", description: "Search HubSpot listings by text.",
    inputSchema: { type: "object", properties: { q: strProp("search text"), limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `hubspot_listings?select=*${a.q ? `&${ilikeOr(["listing_address","owner_name","territory"], String(a.q))}` : ""}&limit=${lim(a)}`) },
  { name: "search_companies", description: "Search HubSpot companies by text.",
    inputSchema: { type: "object", properties: { q: strProp("search text"), limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `hubspot_companies?select=*${a.q ? `&${ilikeOr(["name","domain"], String(a.q))}` : ""}&limit=${lim(a)}`) },
  { name: "search_comps", description: "Search comparable sales by text / neighborhood.",
    inputSchema: { type: "object", properties: { q: strProp("search text"), neighborhood: strProp("neighborhood"), limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `comps?select=*${a.q ? `&${ilikeOr(["address","neighborhood","notes"], String(a.q))}` : ""}${a.neighborhood ? `&neighborhood=ilike.*${enc(String(a.neighborhood))}*` : ""}&order=sale_date.desc&limit=${lim(a)}`) },
  { name: "search_permits", description: "Search NYC permits by address / borough / work type.",
    inputSchema: { type: "object", properties: { address: strProp("address"), borough: strProp("borough"), work_type: strProp("work type"), limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `nyc_permits?select=*${a.address ? `&normalized_address=ilike.*${enc(String(a.address))}*` : ""}${a.borough ? `&borough=ilike.*${enc(String(a.borough))}*` : ""}${a.work_type ? `&work_type=ilike.*${enc(String(a.work_type))}*` : ""}&limit=${lim(a)}`) },
  { name: "search_contacts", description: "Search HubSpot contacts by text.",
    inputSchema: { type: "object", properties: { q: strProp("search text"), limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `hubspot_contacts?select=*${a.q ? `&${ilikeOr(["firstname","lastname","full_name","email","phone","mobilephone"], String(a.q))}` : ""}&limit=${lim(a)}`) },
  { name: "list_my_leads", description: "Leads assigned to you.",
    inputSchema: { type: "object", properties: { limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `lead_list?select=*&limit=${lim(a)}`) },
  { name: "get_kpi_leaderboard", description: "KPI entries for the 7 days from week_start (YYYY-MM-DD).",
    inputSchema: { type: "object", properties: { week_start: strProp("ISO date") }, required: ["week_start"] },
    run: async (t, a) => {
      const start = String(a.week_start);
      const end = new Date(new Date(`${start}T00:00:00Z`).getTime() + 7 * 864e5).toISOString().slice(0, 10);
      return sb(t, `kpi_entries?select=user_id,kpi_type,entry_date,contact_name,company_name&entry_date=gte.${start}&entry_date=lt.${end}&limit=500`);
    } },
  { name: "get_broker_commissions", description: "Your broker commission calculations.",
    inputSchema: { type: "object", properties: {} },
    run: async (t) => sb(t, `broker_commission_calculations?select=*&limit=50`) },
  { name: "get_kb_page", description: "Knowledge-base page by slug.",
    inputSchema: { type: "object", properties: { slug: strProp("page slug") }, required: ["slug"] },
    run: async (t, a) => sb(t, `kb_pages?select=*&slug=eq.${enc(String(a.slug))}&limit=1`) },
  { name: "search_knowledgebase", description: "Search knowledge-base pages by text.",
    inputSchema: { type: "object", properties: { q: strProp("search text"), limit: numProp("max 50") } },
    run: async (t, a) => sb(t, `kb_pages?select=id,title,slug${a.q ? `&${ilikeOr(["title","content","slug"], String(a.q))}` : ""}&limit=${lim(a)}`) },
];

// Write tools — executed with the signed-in user's JWT, so the row is created
// AS that person and RLS decides whether they're allowed. Only registered when
// BKREA_ENABLE_WRITES=1.
async function getUid(token: string): Promise<string> {
  const u = await fetch(`${SUPABASE}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } }).then((r) => r.json()) as { id: string };
  return u.id;
}
async function sbInsert(token: string, table: string, row: Record<string, unknown>): Promise<unknown> {
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const r = await fetch(`${SUPABASE}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(clean),
  });
  if (!r.ok) {
    const msg = (await r.text()).slice(0, 300);
    if (r.status === 401 || r.status === 403 || /permission|rls|policy/i.test(msg))
      throw new Error("401:Permission denied — your role doesn't allow this write.");
    throw new Error(`${r.status}: ${msg}`);
  }
  return await r.json();
}

const WRITE_TOOLS: Tool[] = [
  { name: "create_lead", description: "Add a property lead to your lead list (created as you).",
    inputSchema: { type: "object", properties: {
      address: strProp("property address"), owner: strProp("owner name"),
      owner_phone: strProp("owner phone"), lead_source: strProp("where the lead came from"),
      transaction_type: strProp("e.g. sale, refi"), status_notes: strProp("free-text notes"),
    }, required: ["address"] },
    run: async (t, a) => {
      const user_id = await getUid(t);
      return sbInsert(t, "lead_list", {
        user_id, address: a.address, owner: a.owner, owner_phone: a.owner_phone,
        lead_source: a.lead_source, transaction_type: a.transaction_type, status_notes: a.status_notes,
        lead_date: new Date().toISOString().slice(0, 10),
      });
    } },
  { name: "add_comp", description: "Add a comparable sale (requires comps_importer/super_admin; created as you).",
    inputSchema: { type: "object", properties: {
      address: strProp("address"), sale_price: numProp("sale price"), sale_date: strProp("ISO date YYYY-MM-DD"),
      neighborhood: strProp("neighborhood"), borough: strProp("borough"), asset_type: strProp("asset type"), notes: strProp("notes"),
    }, required: ["address", "sale_price"] },
    run: async (t, a) => sbInsert(t, "comps", {
      address: a.address, sale_price: a.sale_price, sale_date: a.sale_date,
      neighborhood: a.neighborhood, borough: a.borough, asset_type: a.asset_type, notes: a.notes,
    }) },
];

if (WRITES) TOOLS.push(...WRITE_TOOLS);

// ── MCP JSON-RPC handler ─────────────────────────────────────────────────────
async function handleMcp(req: Request): Promise<Response> {
  const token = userToken(req);
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "WWW-Authenticate": `Bearer resource_metadata="${PROXY}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  const msg = await req.json().catch(() => null) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | null;
  if (!msg || !msg.method) return j({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }, 400);

  const reply = (result: unknown) => j({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => j({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bkrea", version: "2.0.0" } });
    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202, headers: { "Access-Control-Allow-Origin": "*" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool: ${name}`);
      try {
        const data = await tool.run(token, args);
        return reply({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        // 401 from Supabase → token expired; signal so Claude refreshes
        if (m.startsWith("401")) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "auth expired" } }), {
            status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
              "WWW-Authenticate": `Bearer resource_metadata="${PROXY}/.well-known/oauth-protected-resource"` },
          });
        }
        return reply({ content: [{ type: "text", text: `Error: ${m}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

// ── Router ───────────────────────────────────────────────────────────────────
const sp = (req: Request) => new URL(req.url).pathname.replace(/^\/api\/mcp\/?/, "");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,mcp-session-id,mcp-protocol-version",
  "Access-Control-Expose-Headers": "WWW-Authenticate,mcp-session-id",
};

export async function GET(req: Request): Promise<Response> {
  const s = sp(req);
  if (s === ".well-known/oauth-authorization-server") return wellKnownAuthServer();
  if (s === ".well-known/oauth-protected-resource")   return wellKnownResource();
  if (s === "oauth/authorize")                         return handleAuthorize(req);
  // MCP GET (some clients probe) → 401 to trigger OAuth
  return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401,
    headers: { "Content-Type": "application/json", ...cors,
      "WWW-Authenticate": `Bearer resource_metadata="${PROXY}/.well-known/oauth-protected-resource"` } });
}

export async function POST(req: Request): Promise<Response> {
  const s = sp(req);
  if (s === "oauth/authorize") return handleAuthorize(req);
  if (s === "oauth/token")     return handleToken(req);
  if (s === "oauth/register")  return registerClient(req);
  return handleMcp(req); // bare /api/mcp
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 204, headers: cors });
}
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: cors });
}
