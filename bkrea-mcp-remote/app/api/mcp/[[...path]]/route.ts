/**
 * BKREA MCP proxy — Google sign-in for per-user auth.
 *
 * /oauth/authorize  → serves a "Sign in with Google" page
 * /oauth/google-callback → receives Google token from Supabase, runs finish JS
 * /oauth/google-finish (POST) → exchanges token for MCP code, redirects Claude
 *
 * All other paths forwarded transparently to mcp-tools edge function.
 *
 * SETUP REQUIRED (one time):
 *   In Lovable → Project Settings → Auth → Redirect URLs, add:
 *   https://bkrea-mcp-remote.vercel.app/api/mcp/oauth/google-callback
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const UPSTREAM   = "https://nmxrnuxhgdooaluaslnd.supabase.co/functions/v1/mcp-tools";
const SUPABASE   = "https://nmxrnuxhgdooaluaslnd.supabase.co";
const ANON_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5teHJudXhoZ2Rvb2FsdWFzbG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzMzMzMsImV4cCI6MjA4MzIwOTMzM30.FsO6ciixFrufalkeuhfVmerBgm6tM2S75Bl88a5r454";
const PROXY_BASE = "https://bkrea-mcp-remote.vercel.app/api/mcp";
const GOOGLE_CB  = `${PROXY_BASE}/oauth/google-callback`;

// ── URL rewriting ──────────────────────────────────────────────────────────
function rewriteUpstream(s: string): string {
  const enc = encodeURIComponent(UPSTREAM);
  const encProxy = encodeURIComponent(PROXY_BASE);
  return s
    .replaceAll(enc, encProxy)
    .replaceAll(UPSTREAM, PROXY_BASE)
    .replaceAll(
      "nmxrnuxhgdooaluaslnd.supabase.co/functions/v1/mcp-tools",
      "bkrea-mcp-remote.vercel.app/api/mcp",
    );
}

// ── State encoding (survives Google OAuth round-trip via Supabase state param) ──
interface McpParams {
  clientId: string; redirectUri: string; codeChallenge: string;
  challengeMethod: string; scope: string; state: string;
}
const encState = (o: McpParams) => Buffer.from(JSON.stringify(o)).toString("base64url");
const decState = (s: string): McpParams | null => {
  try { return JSON.parse(Buffer.from(s, "base64url").toString()) as McpParams; } catch { return null; }
};

// ── HTML helpers ────────────────────────────────────────────────────────────
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function signInPage(googleUrl: string): Response {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to BKREA</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#0d0d0d;color:#f0f0f0;display:flex;align-items:center;
     justify-content:center;min-height:100vh}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;
      padding:40px;width:100%;max-width:360px;text-align:center;
      box-shadow:0 8px 32px rgba(0,0,0,.5)}
.logo{font-size:24px;font-weight:700;margin-bottom:8px}
.sub{color:#888;font-size:14px;margin-bottom:32px;line-height:1.5}
.g{display:flex;align-items:center;justify-content:center;gap:12px;
   background:#fff;color:#1f1f1f;border:none;border-radius:8px;
   font-size:15px;font-weight:500;padding:13px 20px;width:100%;
   cursor:pointer;text-decoration:none;transition:opacity .15s}
.g:hover{opacity:.9}
svg{width:20px;height:20px;flex-shrink:0}
.note{color:#444;font-size:12px;margin-top:24px;line-height:1.5}
</style></head>
<body><div class="card">
<div class="logo">BKREA</div>
<div class="sub">Connect Claude to your BKREA account.<br>Your data stays scoped to you.</div>
<a href="${esc(googleUrl)}" class="g">
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66 2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
  Sign in with Google
</a>
<div class="note">First time? You'll approve access once.<br>After that, Claude always knows it's you.</div>
</div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── /oauth/authorize — show Google sign-in button ──────────────────────────
async function handleAuthorize(req: Request): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const encoded = encState({
    clientId:       p.get("client_id") ?? "",
    redirectUri:    p.get("redirect_uri") ?? "",
    codeChallenge:  p.get("code_challenge") ?? "",
    challengeMethod:p.get("code_challenge_method") ?? "S256",
    scope:          p.get("scope") ?? "mcp",
    state:          p.get("state") ?? "",
  });

  // Supabase passes `state` through Google OAuth untouched — we piggyback our
  // MCP params on it so they survive the round-trip.
  const googleUrl = new URL(`${SUPABASE}/auth/v1/authorize`);
  googleUrl.searchParams.set("provider", "google");
  googleUrl.searchParams.set("redirect_to", GOOGLE_CB);
  googleUrl.searchParams.set("state", encoded);

  return signInPage(googleUrl.toString());
}

// ── /oauth/google-callback — extract token from fragment, call finish ───────
function handleGoogleCallback(): Response {
  return new Response(`<!doctype html><html><head><meta charset="UTF-8">
<title>Completing sign-in…</title>
<style>body{font:16px system-ui;background:#0d0d0d;color:#eee;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.c{text-align:center}.s{font-size:32px;margin-bottom:12px}</style>
</head><body><div class="c"><div class="s">⟳</div><p id="m">Completing sign-in…</p></div>
<script>
(function(){
  var frag = new URLSearchParams(location.hash.slice(1));
  var token = frag.get('access_token');
  var state = new URLSearchParams(location.search).get('state') || frag.get('state') || '';
  if (!token) {
    document.getElementById('m').textContent = 'Sign-in failed — no token. Please close and try again.';
    return;
  }
  fetch('/api/mcp/oauth/google-finish', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({access_token: token, mcp_state: state})
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if (d.redirect) { window.location.href = d.redirect; }
    else { document.getElementById('m').textContent = 'Error: ' + (d.error || 'unknown'); }
  })
  .catch(function(e){ document.getElementById('m').textContent = 'Network error: ' + e; });
})();
</script></body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ── /oauth/google-finish — issue MCP code and redirect to Claude ────────────
async function handleGoogleFinish(req: Request): Promise<Response> {
  const { access_token: userToken, mcp_state } =
    await req.json() as { access_token: string; mcp_state: string };

  const mcp = decState(mcp_state);
  if (!mcp || !userToken) {
    return new Response(JSON.stringify({ error: "missing token or state" }), { status: 400 });
  }

  // Call mcp-tools /oauth/authorize server-side with the user's Google JWT so
  // the resulting code is bound to their identity.
  const code = await issueCode(mcp, userToken);
  if (!code) {
    return new Response(JSON.stringify({ error: "could not issue oauth code from mcp-tools" }), { status: 502 });
  }

  const dest = new URL(mcp.redirectUri);
  dest.searchParams.set("code", code);
  dest.searchParams.set("state", mcp.state);
  return new Response(JSON.stringify({ redirect: dest.toString() }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function issueCode(mcp: McpParams, userToken: string): Promise<string | null> {
  const noop = `${PROXY_BASE}/oauth/noop`;
  const params = new URLSearchParams({
    client_id: mcp.clientId, response_type: "code",
    redirect_uri: noop, state: mcp.state, scope: mcp.scope,
    code_challenge: mcp.codeChallenge, code_challenge_method: mcp.challengeMethod,
  });
  const res = await fetch(`${UPSTREAM}/oauth/authorize?${params}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${userToken}` },
    redirect: "manual",
  });
  const loc = res.headers.get("location") ?? "";
  if (loc) {
    try {
      const u = new URL(loc.startsWith("http") ? loc : `${UPSTREAM}${loc}`);
      const code = u.searchParams.get("code");
      if (code) return code;
    } catch { /* ignore */ }
  }
  if (res.ok) {
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (body?.code) return String(body.code);
  }
  return null;
}

// ── Generic transparent proxy ───────────────────────────────────────────────
const FORWARD_REQ = ["content-type","accept","authorization","mcp-session-id","mcp-protocol-version"];
const SKIP_RES = new Set(["content-encoding","transfer-encoding","connection","keep-alive","upgrade","proxy-authenticate","trailer"]);

async function proxy(req: Request, sp: string): Promise<Response> {
  const upUrl = sp ? `${UPSTREAM}/${sp}` : UPSTREAM;
  const target = new URL(upUrl);
  new URL(req.url).searchParams.forEach((v, k) => target.searchParams.set(k, v));

  const outH = new Headers();
  outH.set("apikey", ANON_KEY);
  for (const n of FORWARD_REQ) { const v = req.headers.get(n); if (v) outH.set(n, v); }

  const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;

  let up: Response;
  try {
    up = await fetch(target.toString(), {
      method: req.method, headers: outH, body,
      // @ts-expect-error Node 20 supports duplex
      duplex: body !== undefined ? "half" : undefined,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream_failed", detail: String(e) }),
      { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const resH = new Headers();
  up.headers.forEach((v, k) => { if (!SKIP_RES.has(k.toLowerCase())) resH.set(k, rewriteUpstream(v)); });
  resH.set("access-control-allow-origin", "*");
  resH.set("access-control-allow-headers", "authorization,x-client-info,apikey,content-type,mcp-session-id,mcp-protocol-version");
  resH.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  resH.set("access-control-expose-headers", "WWW-Authenticate,mcp-session-id");

  const ct = up.headers.get("content-type") ?? "";
  if ((ct.includes("application/json") || ct.includes("text/")) && up.body) {
    const raw = await up.text();
    const rw = rewriteUpstream(raw);
    resH.set("content-length", String(Buffer.byteLength(rw)));
    return new Response(rw, { status: up.status, headers: resH });
  }
  return new Response(up.body, { status: up.status, headers: resH });
}

function sp(req: Request): string {
  return new URL(req.url).pathname.replace(/^\/api\/mcp\/?/, "");
}

export async function GET(req: Request): Promise<Response> {
  const s = sp(req);
  if (s === "oauth/authorize")        return handleAuthorize(req);
  if (s === "oauth/google-callback")  return handleGoogleCallback();
  return proxy(req, s);
}
export async function POST(req: Request): Promise<Response> {
  const s = sp(req);
  if (s === "oauth/google-finish")    return handleGoogleFinish(req);
  return proxy(req, s);
}
export async function DELETE(req: Request): Promise<Response> { return proxy(req, sp(req)); }
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,x-client-info,apikey,content-type,mcp-session-id,mcp-protocol-version",
    "Access-Control-Expose-Headers": "WWW-Authenticate,mcp-session-id",
  }});
}
