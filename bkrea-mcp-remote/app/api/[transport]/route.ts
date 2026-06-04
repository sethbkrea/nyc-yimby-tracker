import { createMcpHandler } from "mcp-handler";
import { registerBkreaTools } from "@/lib/bkrea";

// Supabase queries + token refresh need the Node runtime (not Edge).
export const runtime = "nodejs";
export const maxDuration = 60;

const WRITES_ENABLED = process.env.BKREA_ENABLE_WRITES === "1";

const mcp = createMcpHandler(
  (server) => registerBkreaTools(server, WRITES_ENABLED),
  {},
  { basePath: "/api" },
);

// Single-user gate: the connector must present the shared secret, either as a
// `?key=` query param (simplest — bake it into the connector URL) or as an
// `Authorization: Bearer <secret>` header. No secret configured ⇒ refuse all.
function authorized(req: Request): boolean {
  const secret = process.env.MCP_SHARED_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("key");
  const fromHeader = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return fromQuery === secret || fromHeader === secret;
}

async function guard(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return mcp(req);
}

export { guard as GET, guard as POST, guard as DELETE };
