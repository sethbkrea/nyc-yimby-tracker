// Root-level OAuth Protected Resource metadata (RFC 9728).
// Catches both /.well-known/oauth-protected-resource and the path-suffixed
// /.well-known/oauth-protected-resource/api/mcp form that Claude probes.
export const runtime = "nodejs";

const PROXY = "https://bkrea-mcp-remote.vercel.app/api/mcp";

export function GET(): Response {
  return Response.json({
    resource: PROXY,
    authorization_servers: [PROXY],
    bearer_methods_supported: ["header"],
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}
