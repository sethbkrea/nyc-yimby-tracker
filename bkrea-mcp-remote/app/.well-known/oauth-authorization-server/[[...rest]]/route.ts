// Root-level OAuth Authorization Server metadata (RFC 8414).
// Catches both /.well-known/oauth-authorization-server and the path-suffixed
// /.well-known/oauth-authorization-server/api/mcp form that Claude probes.
export const runtime = "nodejs";

const PROXY = "https://bkrea-mcp-remote.vercel.app/api/mcp";

export function GET(): Response {
  return Response.json({
    issuer: PROXY,
    authorization_endpoint: `${PROXY}/oauth/authorize`,
    token_endpoint: `${PROXY}/oauth/token`,
    registration_endpoint: `${PROXY}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}
