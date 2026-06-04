# BKREA MCP — remote (HTTP) server for Claude.ai

The **remote** counterpart to `bkrea-mcp/` (which is stdio / Claude Desktop only).
This one is a Next.js app hosted on **Vercel** that exposes the same BKREA tools
over **Streamable HTTP**, so it can be added to **Claude.ai on the web** as a
**Custom Connector**.

- Endpoint: `https://<your-deployment>/api/mcp`
- Auth to the connector: a shared secret (`?key=` or `Authorization: Bearer`)
- Auth to Supabase: a stored refresh token for `seth@bkrea.com` → RLS applies as you
- Same 14 read tools + 3 write tools (gated by `BKREA_ENABLE_WRITES=1`)

## Deploy (Vercel)

### 1. Get your Supabase refresh token (one time)

```bash
cd bkrea-mcp-remote
npm install
npm run get-token      # opens browser → Google sign-in → prints SUPABASE_REFRESH_TOKEN=...
```

> **Disable refresh-token rotation** so the stored token stays valid across
> serverless cold starts: Supabase dashboard → **Authentication → Sessions →
> turn off "Refresh Token Rotation"** (or "Detect session in URL"/rotation
> setting). Without this you'll need to re-run `get-token` periodically.

### 2. Pick a connector secret

Any long random string, e.g. `openssl rand -hex 24`.

### 3. Deploy

```bash
npm i -g vercel        # if needed
vercel                 # link/create the project (root = this folder)
# set env vars:
vercel env add SUPABASE_REFRESH_TOKEN     # paste from step 1
vercel env add MCP_SHARED_SECRET          # paste from step 2
vercel env add BKREA_ENABLE_WRITES        # "1" to allow writes, else skip
vercel --prod          # deploy
```

(Or do it in the Vercel dashboard: import the folder as a project, add the three
env vars, deploy.)

### 4. Add to Claude.ai as a custom connector

In Claude.ai → **Settings → Connectors → Add custom connector** (org connectors
are added by an admin), set the URL to:

```
https://<your-deployment>.vercel.app/api/mcp?key=<MCP_SHARED_SECRET>
```

Then open the **Ask BKREA** project → the tools appear under connected tools.

## Local dev

```bash
SUPABASE_REFRESH_TOKEN=... MCP_SHARED_SECRET=dev BKREA_ENABLE_WRITES=1 npm run dev
# test:
curl -s -X POST "http://localhost:3000/api/mcp?key=dev" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
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
