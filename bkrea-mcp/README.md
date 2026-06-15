# BKREA MCP server

A single-user [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude Desktop read (and optionally write) data in the **BKREA** Supabase backend.
Only `seth@bkrea.com` can use it — auth is Google OAuth, scoped with your JWT so
Supabase **RLS** governs everything.

- **Transport:** stdio (Claude Desktop runs it as a local subprocess)
- **Auth:** Google via a local OAuth callback on `http://localhost:53682/callback`
- **Deps:** `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `zod`

## One-time setup

```bash
cd bkrea-mcp
npm install
npm run build
```

Then add it to Claude Desktop's config — on macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bkrea": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/bkrea-mcp/dist/index.js"],
      "env": { "BKREA_ENABLE_WRITES": "1" }
    }
  }
}
```

Restart Claude Desktop. The **first tool call opens your browser** → sign in with
your `@bkrea.com` Google account → the session is cached at
`~/.bkrea-mcp/session.json` (chmod 600) and refreshed automatically thereafter.

> If the browser shows an OAuth redirect error, add
> `http://localhost:53682/callback` to **Authentication → URL Configuration →
> Redirect URLs** in the Supabase dashboard.

### Re-authenticate

```bash
rm ~/.bkrea-mcp/session.json
```

## Tools

**Read-only (always available):**

| Tool | What it does |
|------|--------------|
| `whoami` | Your `profiles` row |
| `search_deals` | `hubspot_deals` by text / stage / broker |
| `get_deal` | A deal + its `deal_contacts` |
| `search_listings` | `hubspot_listings` by text / status |
| `get_listing` | A listing + its linked deal |
| `search_companies` | `hubspot_companies` by text |
| `search_contacts` | `hubspot_contacts` + `bk_list_contacts_cache`, merged & de-duped by phone/email |
| `search_comps` | `comps` by text / neighborhood / price range |
| `search_permits` | `nyc_permits` by address / borough / work type |
| `search_knowledgebase` | `beacon-search` edge function, else text search over `kb_pages` |
| `get_kb_page` | A `kb_pages` row by slug (markdown) |
| `get_kpi_leaderboard` | `kpi_entries` for a week, grouped by user |
| `list_my_leads` | `lead_list` assigned to me |
| `get_broker_commissions` | `broker_commission_calculations` for me |

**Write (only when `BKREA_ENABLE_WRITES=1`):**

| Tool | What it does |
|------|--------------|
| `create_lead` | Insert into `lead_list` (`created_by` = me) |
| `add_comp` | Insert into `comps` (needs `comps_importer`/`super_admin` role) |
| `log_feedback` | `log-deal-feedback` edge function, else insert into `deal_feedback` |

List/search tools cap at 50 results and return `{ items, next_cursor, total_estimate? }`.
Pass `cursor` (the previous `next_cursor`) to page. Mutations return `{ id, url }`.

## Adjusting column guesses

Exact column names for free-text search and "me"-scoped filters are best-guesses,
centralized at the top of `src/index.ts` in `SEARCH_COLS` and `ME_COLS`. If a tool
returns a `Schema mismatch — a referenced column doesn't exist` error, edit those
maps and rebuild (`npm run build`). RLS denials surface as a clear
"Permission denied" message.

## Notes

- stdout is reserved for the MCP transport; all logs go to **stderr**.
- The Supabase URL + anon key are public values and hardcoded by design.
- Writes are gated: the write tools aren't even registered unless
  `BKREA_ENABLE_WRITES=1`.
