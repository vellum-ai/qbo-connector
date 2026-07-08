# QBO Connector Plugin

A Vellum plugin that connects an assistant to QuickBooks Online through Intuit's OAuth 2.0 flow, discovers the books' structure, and keeps the connection alive.

## What It Does

Four tools handle the full connector lifecycle:

| Tool | Purpose |
|---|---|
| `qbo_connect` | Runs the OAuth flow (start + exchange phases) |
| `qbo_status` | Checks connection health (token expiry, snapshot status) |
| `qbo_refresh` | Forces a token refresh |
| `qbo_discover` | Builds the business snapshot (accounts, vendors, preferences) |

A shared client module (`src/qbo-client.ts`) handles token lifecycle, API calls, and state persistence. It encodes four hard-won reauth lessons as code:

1. **Playground redirect URI as default** — not a hard env-var requirement
2. **CSRF state optional for manual operator flows** — annotate `csrf_verified: false`, don't abort
3. **Transaction is abstract in QBO** — query `Bill` or `Purchase` directly
4. **Proxy failures are not API failures** — `fetchWithDirectFallback` retries directly via `node:https` when the proxy returns 5xx

## Structure

```
qbo-connector/
├── package.json              # Plugin manifest (peer dep: @vellumai/plugin-api ^0.8.0)
├── config.json               # User-editable defaults (redirect URI, reauth profile, thresholds)
├── install-meta.json         # Install provenance
├── src/
│   ├── qbo-client.ts         # Shared client: token lifecycle, API calls, state I/O, proxy fallback (579 lines)
│   └── types.ts              # TypeScript types for state, credentials, snapshot, config
├── tools/
│   ├── qbo_connect.ts        # OAuth start + exchange (300 lines)
│   ├── qbo_status.ts         # Connection health check (81 lines)
│   ├── qbo_refresh.ts        # Force token refresh (69 lines)
│   └── qbo_discover.ts       # 5-query business snapshot + sandbox detection (145 lines)
├── skills/
│   └── qbo-connector/
│       └── SKILL.md          # Three reading levels: Beginner, Operator, Developer (221 lines)
└── data/                     # NOT INCLUDED in this artifact — contains live tokens
    ├── state.json            # Live access + refresh tokens, realm_id (chmod 600)
    ├── credentials.json      # Intuit client_id, client_secret, redirect_uri (chmod 600)
    └── business-snapshot.json # Discovery snapshot (accounts, vendors, preferences)
```

## Integration Notes

### Data Directory

The `data/` directory is excluded from this artifact because it contains live OAuth tokens for an active QBO connection. The plugin creates it on first connect. Each instance gets its own `data/` with its own tokens — do not share or copy this directory between instances.

### Peer Dependency

Requires `@vellumai/plugin-api` ^0.8.0. The plugin uses standard plugin API interfaces (tool registration, skill bundling). No exotic APIs.

### Config Defaults

`config.json` ships with sensible defaults. Users can edit it post-install without touching code:
- `redirect_uri_default`: Intuit OAuth Playground URL
- `reauth_warning_profile_default`: `"heads-up"` (chat message 14 days before RT expiry, strong message 3 days before)
- `token_refresh_threshold_seconds`: 60 (auto-refresh AT when < 60s remaining)
- `refresh_expiry_days`: 100 (Intuit's RT lifetime)

### OAuth Flow

The connector uses Intuit's standard OAuth 2.0 with the Playground as the default redirect URI (most operators don't have a custom app registered). The flow is:

1. `qbo_connect(step: "start")` → returns Intuit authorization URL
2. Owner clicks through Intuit's consent screen (intrinsically manual — MFA + consent)
3. Owner copies `code` + `realmId` from redirect URL
4. `qbo_connect(step: "exchange")` → exchanges code for tokens, persists state.json

### Proxy Fallback

Bun's `fetch` routes through a credential proxy that returns HTTP 500 for Intuit's OAuth token endpoint. The `fetchWithDirectFallback` helper in `qbo-client.ts` tries `fetch` first, and on 5xx or network error, falls back to `node:https` directly (bypassing the proxy). This is applied at all three API call sites: `refreshTokens`, `qboQuery`, and the OAuth token exchange in `qbo_connect`.

If your Vellum environment doesn't have this proxy issue, the fallback is a no-op (first `fetch` succeeds, fallback never fires).

### Skill (SKILL.md)

The bundled skill has three concentric reading levels:
- **Beginner** — for non-technical owners who don't know what an Intuit app is
- **Operator** — the default Step 0-6 sequence for running a first-connect or reauth
- **Developer** — edge cases, entity-shape cookbook, CSRF tradeoffs, proxy fallbacks

## Tested Against

- Live production QBO connection: Vocify Inc. (realm 9341452938908333)
- 153 GL accounts, 752 vendors discovered
- Refresh token valid through Oct 16, 2026
- Token refresh via plugin code confirmed working (proxy 500 fix applied Jul 8, 2026)

## Version

0.1.0 — built Jul 6, 2026. Last tested Jul 8, 2026.
