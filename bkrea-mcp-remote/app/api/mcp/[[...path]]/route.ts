/**
 * Full-path transparent proxy for the BKREA mcp-tools Supabase Edge Function.
 *
 * Handles every path the MCP + OAuth flow needs:
 *   GET  /api/mcp/.well-known/oauth-protected-resource
 *   GET  /api/mcp/.well-known/oauth-authorization-server
 *   POST /api/mcp/oauth/register
 *   GET  /api/mcp/oauth/authorize
 *   GET  /api/mcp/oauth/issue-code
 *   POST /api/mcp/oauth/token
 *   POST /api/mcp/oauth/revoke
 *   POST /api/mcp             ← MCP JSON-RPC (initialize / tools/list / tools/call)
 *
 * URL rewriting: every occurrence of the upstream Supabase URL in response
 * bodies is replaced with this proxy's public URL so Claude never contacts
 * Supabase directly (which gets blocked).
 */
export const runtime = "nodejs";
export const maxDuration = 60;

const UPSTREAM   = "https://nmxrnuxhgdooaluaslnd.supabase.co/functions/v1/mcp-tools";
const ANON_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5teHJudXhoZ2Rvb2FsdWFzbG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzMzMzMsImV4cCI6MjA4MzIwOTMzM30.FsO6ciixFrufalkeuhfVmerBgm6tM2S75Bl88a5r454";
const PROXY_BASE = "https://bkrea-mcp-remote.vercel.app/api/mcp";

// URL-encoded form of UPSTREAM — appears inside redirect Location params like
// ?redirect_after=https%3A%2F%2Fnmxrnuxhgdooaluaslnd... when the BKREA login
// page embeds the mcp-tools callback URL as a query parameter.
const UPSTREAM_ENCODED   = encodeURIComponent(UPSTREAM);
const PROXY_BASE_ENCODED = encodeURIComponent(PROXY_BASE);

// Also handle the bare Supabase host so any stray links are caught.
const SUPABASE_HOST_PATTERN = "nmxrnuxhgdooaluaslnd.supabase.co/functions/v1/mcp-tools";
const PROXY_HOST_PATTERN    = "bkrea-mcp-remote.vercel.app/api/mcp";

function rewriteUpstream(s: string): string {
  return s
    .replaceAll(UPSTREAM_ENCODED, PROXY_BASE_ENCODED)  // URL-encoded form first
    .replaceAll(UPSTREAM, PROXY_BASE)                  // plain form
    .replaceAll(SUPABASE_HOST_PATTERN, PROXY_HOST_PATTERN); // bare host fallback
}

// Headers Claude sends / that should be forwarded upstream (lowercase).
const FORWARD_REQ_HEADERS = [
  "content-type",
  "accept",
  "authorization",
  "mcp-session-id",
  "mcp-protocol-version",
];

// Headers from upstream we pass back (everything except hop-by-hop).
const SKIP_RES_HEADERS = new Set([
  "content-encoding", "transfer-encoding", "connection",
  "keep-alive", "upgrade", "proxy-authenticate", "trailer",
]);

async function handle(req: Request, subpath: string): Promise<Response> {
  // Build upstream URL: /api/mcp/<subpath> → UPSTREAM/<subpath>
  const upstreamUrl = subpath ? `${UPSTREAM}/${subpath}` : UPSTREAM;

  // Forward query string as-is.
  const incoming = new URL(req.url);
  const target = new URL(upstreamUrl);
  incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  // Copy safe request headers; always inject the Supabase anon key.
  const outHeaders = new Headers();
  outHeaders.set("apikey", ANON_KEY);
  for (const name of FORWARD_REQ_HEADERS) {
    const val = req.headers.get(name);
    if (val) outHeaders.set(name, val);
  }

  const body =
    req.method !== "GET" && req.method !== "HEAD"
      ? await req.arrayBuffer()
      : undefined;

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

  // Build response headers, rewriting all forms of the upstream URL → proxy URL.
  // This includes Location: headers (direct redirects) and any header values
  // that embed the Supabase URL (plain, URL-encoded, or bare host form).
  const resHeaders = new Headers();
  upstream.headers.forEach((val, key) => {
    if (SKIP_RES_HEADERS.has(key.toLowerCase())) return;
    resHeaders.set(key, rewriteUpstream(val));
  });
  resHeaders.set("access-control-allow-origin", "*");
  resHeaders.set(
    "access-control-allow-headers",
    "authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version",
  );
  resHeaders.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  resHeaders.set("access-control-expose-headers", "WWW-Authenticate, mcp-session-id");

  const contentType = upstream.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const isText = isJson || contentType.includes("text/");

  if (isText && upstream.body) {
    // Rewrite upstream URL references in JSON/text bodies so Claude always
    // talks back to this proxy, never to Supabase directly.
    const raw = await upstream.text();
    const rewritten = rewriteUpstream(raw);
    resHeaders.set("content-length", String(Buffer.byteLength(rewritten)));
    return new Response(rewritten, { status: upstream.status, headers: resHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

function subpath(req: Request): string {
  // Extract everything after /api/mcp/
  const url = new URL(req.url);
  const after = url.pathname.replace(/^\/api\/mcp\/?/, "");
  return after;
}

export async function GET(req: Request)    { return handle(req, subpath(req)); }
export async function POST(req: Request)   { return handle(req, subpath(req)); }
export async function DELETE(req: Request) { return handle(req, subpath(req)); }
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
