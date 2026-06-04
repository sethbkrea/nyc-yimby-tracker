/**
 * BKREA MCP proxy with server-side OAuth auto-approval.
 *
 * The Lovable consent page (ai.agent.bkrea.xyz) requires an active BKREA
 * browser session to render — it shows about:blank in a popup context. To
 * avoid this, the proxy intercepts /oauth/authorize and completes the OAuth
 * handshake server-side using stored BKREA credentials, then immediately
 * redirects Claude to the callback URL with a valid auth code. No popup or
 * browser login needed.
 *
 * All other paths (well-known, oauth/token, oauth/register, oauth/revoke,
 * MCP JSON-RPC) are forwarded transparently to the Supabase edge function.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const UPSTREAM   = "https://nmxrnuxhgdooaluaslnd.supabase.co/functions/v1/mcp-tools";
const ANON_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5teHJudXhoZ2Rvb2FsdWFzbG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzMzMzMsImV4cCI6MjA4MzIwOTMzM30.FsO6ciixFrufalkeuhfVmerBgm6tM2S75Bl88a5r454";
const SUPABASE   = "https://nmxrnuxhgdooaluaslnd.supabase.co";
const PROXY_BASE = "https://bkrea-mcp-remote.vercel.app/api/mcp";

const UPSTREAM_ENCODED   = encodeURIComponent(UPSTREAM);
const PROXY_BASE_ENCODED = encodeURIComponent(PROXY_BASE);

function rewriteUpstream(s: string): string {
  return s
    .replaceAll(UPSTREAM_ENCODED, PROXY_BASE_ENCODED)
    .replaceAll(UPSTREAM, PROXY_BASE)
    .replaceAll(
      "nmxrnuxhgdooaluaslnd.supabase.co/functions/v1/mcp-tools",
      "bkrea-mcp-remote.vercel.app/api/mcp",
    );
}

const FORWARD_REQ_HEADERS = [
  "content-type", "accept", "authorization",
  "mcp-session-id", "mcp-protocol-version",
];
const SKIP_RES_HEADERS = new Set([
  "content-encoding", "transfer-encoding", "connection",
  "keep-alive", "upgrade", "proxy-authenticate", "trailer",
]);

// ── Supabase password sign-in ────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);
let tokenCache: { access: string; exp: number } | null = null;

async function getBkreaToken(): Promise<string> {
  if (tokenCache && tokenCache.exp - nowSec() > 60) return tokenCache.access;
  const email    = (process.env.BKREA_EMAIL ?? "seth@bkrea.com").trim();
  const password = (process.env.BKREA_PASSWORD ?? "").trim();
  if (!password) throw new Error("BKREA_PASSWORD not set");
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`BKREA sign-in failed (${r.status}): ${t.slice(0, 200)}`);
  }
  const d = (await r.json()) as { access_token: string; expires_in?: number };
  tokenCache = { access: d.access_token, exp: nowSec() + (d.expires_in ?? 3600) };
  return tokenCache.access;
}

// ── OAuth authorize: serve our own login form ────────────────────────────────
/**
 * GET  /api/mcp/oauth/authorize  → show BKREA login form
 * POST /api/mcp/oauth/authorize  → process credentials, sign in, issue code
 *
 * Each user authenticates with their own BKREA credentials so the resulting
 * OAuth token carries their Supabase user_id. RLS then scopes every tool call
 * to that user — brokers only see their own deals, leads, commissions, etc.
 */
async function handleAuthorize(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state           = url.searchParams.get("state") ?? "";
  const clientId        = url.searchParams.get("client_id") ?? "";
  const redirectUri     = url.searchParams.get("redirect_uri") ?? "";
  const codeChallenge   = url.searchParams.get("code_challenge") ?? "";
  const challengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
  const scope           = url.searchParams.get("scope") ?? "mcp";

  // POST: user submitted the login form
  if (req.method === "POST") {
    const form = await req.formData().catch(() => new FormData());
    const email    = (form.get("email")    as string ?? "").trim();
    const password = (form.get("password") as string ?? "").trim();
    const pState   = (form.get("state")    as string ?? state).trim();
    const pClient  = (form.get("client_id")as string ?? clientId).trim();
    const pRedirect= (form.get("redirect_uri") as string ?? redirectUri).trim();
    const pChallenge=(form.get("code_challenge") as string ?? codeChallenge).trim();
    const pMethod  = (form.get("code_challenge_method") as string ?? challengeMethod).trim();
    const pScope   = (form.get("scope") as string ?? scope).trim();

    // Sign in this user with their own BKREA credentials
    const signIn = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ email, password }),
    });

    if (!signIn.ok) {
      return loginPage({ state: pState, clientId: pClient, redirectUri: pRedirect,
        codeChallenge: pChallenge, challengeMethod: pMethod, scope: pScope,
        error: "Invalid email or password. Please try again." });
    }

    const { access_token: userToken } = await signIn.json() as { access_token: string };

    // Call mcp-tools /oauth/issue-code with this user's JWT so the resulting
    // OAuth code is bound to their identity.
    const code = await issueCode(pClient, pState, pRedirect, pChallenge, pMethod, pScope, userToken);
    if (!code) {
      return loginPage({ state: pState, clientId: pClient, redirectUri: pRedirect,
        codeChallenge: pChallenge, challengeMethod: pMethod, scope: pScope,
        error: "Authentication succeeded but could not issue OAuth code. Contact support." });
    }

    // Redirect back to Claude with the auth code
    const dest = new URL(pRedirect);
    dest.searchParams.set("code", code);
    dest.searchParams.set("state", pState);
    return Response.redirect(dest.toString(), 302);
  }

  // GET: show the login form
  return loginPage({ state, clientId, redirectUri, codeChallenge, challengeMethod, scope });
}

async function issueCode(
  clientId: string, state: string, redirectUri: string,
  codeChallenge: string, challengeMethod: string, scope: string,
  userToken: string,
): Promise<string | null> {
  // First call authorize server-side with the user's JWT so mcp-tools records
  // the session, then extract the code from the redirect it returns.
  const cbUrl = `${PROXY_BASE}/oauth/issue-code-noop`;
  const params = new URLSearchParams({
    client_id: clientId, response_type: "code",
    redirect_uri: cbUrl, state, scope,
    code_challenge: codeChallenge, code_challenge_method: challengeMethod,
  });

  const authRes = await fetch(`${UPSTREAM}/oauth/authorize?${params}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${userToken}` },
    redirect: "manual",
  });

  // mcp-tools may redirect straight to the callback with a code
  const loc = authRes.headers.get("location") ?? "";
  if (loc) {
    try {
      const locUrl = new URL(loc.startsWith("http") ? loc : `${UPSTREAM}${loc}`);
      const code = locUrl.searchParams.get("code");
      if (code) return code;
    } catch { /* ignore parse errors */ }
  }

  // Some implementations return the code in the JSON body
  if (authRes.ok) {
    const body = await authRes.json().catch(() => null) as Record<string, unknown> | null;
    if (body?.code) return String(body.code);
  }

  return null;
}

interface LoginPageOpts {
  state: string; clientId: string; redirectUri: string;
  codeChallenge: string; challengeMethod: string; scope: string;
  error?: string;
}

function loginPage(o: LoginPageOpts): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to BKREA</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#0d0d0d;color:#f0f0f0;display:flex;align-items:center;
         justify-content:center;min-height:100vh}
    .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;
          padding:36px 40px;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
    .logo{font-size:22px;font-weight:700;letter-spacing:-.5px;margin-bottom:6px}
    .sub{color:#888;font-size:13px;margin-bottom:28px}
    label{display:block;font-size:13px;color:#aaa;margin-bottom:6px}
    input{width:100%;background:#111;border:1px solid #333;border-radius:8px;
          color:#f0f0f0;font-size:15px;padding:11px 14px;outline:none;
          transition:border .2s}
    input:focus{border-color:#555}
    .field{margin-bottom:18px}
    button{width:100%;background:#fff;color:#000;border:none;border-radius:8px;
           font-size:15px;font-weight:600;padding:12px;cursor:pointer;
           margin-top:8px;transition:opacity .15s}
    button:hover{opacity:.88}
    .err{background:#2a0d0d;border:1px solid #5a1a1a;border-radius:8px;
         color:#f87171;font-size:13px;padding:10px 14px;margin-bottom:18px}
    .notice{color:#555;font-size:12px;margin-top:20px;text-align:center}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">BKREA</div>
  <div class="sub">Sign in to connect Claude to your account</div>
  ${o.error ? `<div class="err">${o.error}</div>` : ""}
  <form method="POST" action="/api/mcp/oauth/authorize">
    <input type="hidden" name="state"                  value="${esc(o.state)}">
    <input type="hidden" name="client_id"              value="${esc(o.clientId)}">
    <input type="hidden" name="redirect_uri"           value="${esc(o.redirectUri)}">
    <input type="hidden" name="code_challenge"         value="${esc(o.codeChallenge)}">
    <input type="hidden" name="code_challenge_method"  value="${esc(o.challengeMethod)}">
    <input type="hidden" name="scope"                  value="${esc(o.scope)}">
    <div class="field">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" placeholder="you@bkrea.com"
             autocomplete="email" required autofocus>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password"
             placeholder="••••••••" autocomplete="current-password" required>
    </div>
    <button type="submit">Sign in &amp; connect</button>
  </form>
  <div class="notice">Your credentials are sent directly to Supabase and never stored by this proxy.</div>
</div>
</body>
</html>`;
  return new Response(html, {
    status: o.error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ── Generic transparent proxy ────────────────────────────────────────────────
async function handle(req: Request, subpath: string): Promise<Response> {
  const upstreamUrl = subpath ? `${UPSTREAM}/${subpath}` : UPSTREAM;
  const incoming = new URL(req.url);
  const target = new URL(upstreamUrl);
  incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  const outHeaders = new Headers();
  outHeaders.set("apikey", ANON_KEY);
  for (const name of FORWARD_REQ_HEADERS) {
    const val = req.headers.get(name);
    if (val) outHeaders.set(name, val);
  }

  const body = req.method !== "GET" && req.method !== "HEAD"
    ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method,
      headers: outHeaders,
      body: body ?? undefined,
      // @ts-expect-error Node 20 fetch supports duplex
      duplex: body !== undefined ? "half" : undefined,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "proxy_fetch_failed", detail: String(e) }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((val, key) => {
    if (SKIP_RES_HEADERS.has(key.toLowerCase())) return;
    resHeaders.set(key, rewriteUpstream(val));
  });
  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.set("access-control-allow-headers",
    "authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version");
  resHeaders.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  resHeaders.set("access-control-expose-headers", "WWW-Authenticate, mcp-session-id");

  const contentType = upstream.headers.get("content-type") ?? "";
  const isText = contentType.includes("application/json") || contentType.includes("text/");

  if (isText && upstream.body) {
    const raw = await upstream.text();
    const rewritten = rewriteUpstream(raw);
    resHeaders.set("content-length", String(Buffer.byteLength(rewritten)));
    return new Response(rewritten, { status: upstream.status, headers: resHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

function subpath(req: Request): string {
  return new URL(req.url).pathname.replace(/^\/api\/mcp\/?/, "");
}

export async function GET(req: Request): Promise<Response> {
  const sp = subpath(req);
  if (sp === "oauth/authorize") return handleAuthorize(req);
  return handle(req, sp);
}
export async function POST(req: Request): Promise<Response> {
  const sp = subpath(req);
  if (sp === "oauth/authorize") return handleAuthorize(req);
  return handle(req, sp);
}
export async function DELETE(req: Request): Promise<Response> { return handle(req, subpath(req)); }
export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version",
      "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-session-id",
    },
  });
}
