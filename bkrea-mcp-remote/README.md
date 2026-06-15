# BKREA MCP — remote (HTTP) server for Claude.ai

The **remote** counterpart to `bkrea-mcp/` (which is stdio / Claude Desktop only).
This one is a Next.js app hosted on **Vercel** that exposes the same BKREA tools
over **Streamable HTTP**, so it can be added to **Claude.ai on the web** as a
**Custom Connector**.

- Endpoint: `https://<your-deployment>/api/mcp`
- Auth to the connector: a shared secret (`?key=` or `Authorization: Bearer`)
- Auth to Supabase: **email + password grant** for `seth@bkrea.com` (stored in
  env) → the server mints a fresh JWT per request, so RLS applies as you. No
  refresh-token rotation, no Supabase dashboard changes — works with a
  Lovable-managed backend.
- Same 14 read tools + 3 write tools (gated by `BKREA_ENABLE_WRITES=1`)

## Deploy (Vercel)

### 1. Pick a connector secret

Any long random string, e.g. `openssl rand -hex 24`.

### 2. Deploy

```bash
cd bkrea-mcp-remote
npm install
npm i -g vercel        # if needed
vercel                 # link/create the project (root = this folder)
# set env vars:
vercel env add TOKEN_SECRET           # `openssl rand -base64 48` — seals our OAuth tokens
vercel env add BKREA_ENABLE_WRITES    # "1" to allow write tools, else skip
vercel --prod          # deploy
```

(Or in the Vercel dashboard: import the folder as a project, add those env
vars, deploy.)

> Auth is per-user: each person signs in with their own BKREA email/password on
> the connector's login page. No shared credentials are stored in the server.

### 3. Add to Claude.ai as a custom connector

In Claude.ai → **Settings → Connectors → Add custom connector** (org connectors
are added by an admin), set the URL to:

```
https://<your-deployment>.vercel.app/api/mcp?key=<MCP_SHARED_SECRET>
```

Then open the **Ask BKREA** project → the tools appear under connected tools.

## Local dev

```bash
TOKEN_SECRET=dev-secret BKREA_ENABLE_WRITES=1 npm run dev
# OAuth discovery should return 200:
curl -s http://localhost:3000/api/mcp/.well-known/oauth-authorization-server
# an unauthenticated MCP call returns 401 + WWW-Authenticate (triggers sign-in):
curl -si -X POST "http://localhost:3000/api/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

## Auth & security notes

- The connector URL contains the secret, so **treat the URL as a credential**.
  It's stored in your Claude account; rotate by changing `MCP_SHARED_SECRET`.
- All DB access uses your Supabase JWT → **RLS governs everything**; the write
  tools still require your roles (`comps_importer` / `super_admin` for comps).
- Column-name guesses for search/`me` filters live in `lib/bkrea.ts`
  (`SEARCH_COLS` / `ME_COLS`); a wrong one surfaces as a clear "Schema mismatch"
  error — edit and redeploy.

## Tools

Identical to `bkrea-mcp/` — see that README for the full table. Reads:
`whoami, search_deals, get_deal, search_listings, get_listing, search_companies,
search_contacts, search_comps, search_permits, search_knowledgebase, get_kb_page,
get_kpi_leaderboard, list_my_leads, get_broker_commissions`. Writes (gated):
`create_lead, add_comp, log_feedback`.
