---
name: "QuickBooks Online Setup"
description: >-
  Connect a Vellum Assistant to a QuickBooks Online account through Intuit OAuth,
  learn the books' structure on first connect, and keep the connection alive.
  Use when the user wants to connect, set up, or reconnect QBO access.
metadata:
  vellum:
    emoji: 📚
    display-name: "QuickBooks Online Setup"
    activation-hints:
      - "connect my QuickBooks"
      - "set up QBO access"
      - "reconnect QuickBooks"
      - "my QBO connection broke"
      - "connect QBO"
      - "QuickBooks Online setup"
    avoid-when:
      - "user wants help with a non-QBO bookkeeping platform (Xero, Sage, Wave)"
      - "user wants general bookkeeping Q&A without a QBO realm"
      - "user wants to operate on QBO data (reclasses, categorize, spend pacing) — that is a separate Operating-layer skill"
    category: "integrations"
---

## What This Plugin Does

Connects a Vellum Assistant to a QuickBooks Online account through Intuit's standard OAuth flow, learns the structure of the books, and keeps the connection alive.

This plugin ships four tools that handle the full connector lifecycle:

- **qbo_connect** — runs the OAuth flow (start + exchange phases)
- **qbo_status** — checks connection health (token expiry, snapshot status)
- **qbo_refresh** — forces a token refresh
- **qbo_discover** — builds the business snapshot (accounts, vendors, preferences)

You do not need to run bash commands or manage token files manually. The tools handle state persistence, token rotation, and API calls.

## Reading Levels

This skill is written in three concentric rings. Pick the one that matches the owner:

- **Beginner** (1-2 sentences per concept, no jargon): what OAuth is, what each code does, why some steps can't be skipped. Read if the owner asks "why does this need three codes?" or doesn't know where their Intuit app lives.
- **Operator** (the working path, Steps 0-6 below): the default sequence to run a first-connect or reauth. Read this when executing the flow.
- **Developer** (edge cases, entity-shape cookbook, CSRF tradeoffs, proxy fallbacks): the diagnostic and override surface. Read when the default path breaks and you need to understand why.

A condensed **Beginner view** is at the bottom for non-technical owners. The Operator view is Steps 0-6. The Developer view is the appendices.

## Step 0: Confirm Prerequisites

Before starting the OAuth flow, confirm the owner has what they need:

1. The owner has at least one QuickBooks Online company (an Intuit user account with at least one active realm). **Only a QBO Master Admin or Company Admin can authorize third-party app access** — Intuit will reject the consent screen for non-admin users.
2. The owner has an Intuit developer app registered, which gives them a Client ID and Client Secret. The redirect URI defaults to Intuit's OAuth Playground, so no custom app configuration is needed — but the developer app itself is required (it's Intuit's gate, not ours).

If the owner doesn't have a developer app yet, walk them through **Creating an Intuit Developer App** below. If they have one but don't know where to find the credentials, use the **Beginner-Friendly Walkthrough** at the bottom of this skill.

### Creating an Intuit Developer App (first time only)

If the owner has never registered an app with Intuit, walk them through these steps. This is a one-time setup that takes about 5 minutes:

1. Go to **developer.intuit.com** and sign in with the same Intuit account they use for QuickBooks Online (their admin credentials).
2. Go to **My Apps** → **Create an app**.
3. Select **QuickBooks Online and Payments** as the platform.
4. Fill in an app name — anything works, it's just a label. Something like "Vellum Connector" or "[Company Name] Assistant" is fine.
5. Once the app is created, go to the **Keys** tab (sometimes called **Credentials** or **Production Keys**).
6. They'll see a **Production Client ID** and **Production Client Secret**. These are the two things the connector needs.
7. **They do not need to configure a redirect URI** — the connector uses Intuit's OAuth Playground URL as the default. If they want to set one up later for a custom flow, that's optional.
8. Have them paste the **Client ID** in chat (it's public, safe to share) and provide the **Client Secret** through the secure prompt (it's private, never goes in chat).

Once they have the Client ID and Client Secret, proceed to Step 1.

## Step 1: Start the OAuth Flow

Call the **qbo_connect** tool with `step: "start"`.

Required input:
- `client_id` — the owner's Intuit app Client ID (public, safe in chat)

Optional input:
- `client_secret` — the owner's Intuit app Client Secret (private). If omitted, the tool will ask for it during the exchange step.
- `redirect_uri` — if omitted, defaults to the Intuit OAuth Playground URL (`https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`). Only provide if the owner has a custom registered app.

The tool will:
1. Save the credentials to the plugin's data directory.
2. Generate a CSRF state token and write it to disk.
3. Return the Intuit authorization URL.

**Surface the URL to the owner as a clickable link.** They must click through Intuit's consent screen — this is intrinsically human and cannot be automated.

## Step 2: Exchange the Authorization Code

After the owner clicks through Intuit's consent screen, Intuit redirects to the redirect URI with `code`, `realmId`, and optionally `state` in the URL.

Ask the owner to copy the `code` and `realmId` from the redirect URL. Then call **qbo_connect** with `step: "exchange"`.

Required input:
- `code` — the authorization code from Intuit's callback
- `realm_id` — the realm ID from Intuit's callback

Optional input:
- `state_token` — the CSRF state token from Step 1's response. If omitted (common when using the Playground, which doesn't surface state), the connection is annotated as `csrf_verified: false` and proceeds anyway. This is safe for operator-driven flows.

The tool will:
1. Exchange the code for access + refresh tokens.
2. Validate token shapes (RT must start with `RT1-`, AT must be a long JWT).
3. Calculate the refresh token expiry (issuance + 100 days, computed locally since Intuit doesn't return it).
4. Persist state.json with all 7 fields to the plugin's data directory.
5. Return the connection details.

If the exchange fails:
- `invalid_grant` → the code expired or was already used. Restart from Step 1.
- `invalid_client` → the client_id or client_secret is wrong. Check the Intuit developer portal.

## Step 3: Verify the Connection

Call **qbo_status** to check that the connection is live. The tool reads state.json and reports:
- Access token validity and time remaining
- Refresh token validity and time remaining
- Whether credentials are saved
- Whether a business snapshot exists

You can also call **qbo_refresh** to force a token refresh and confirm the refresh loop works end-to-end.

## Step 4: Build the Business Snapshot

Call **qbo_discover** to run the five discovery queries and save the result:

1. `SELECT * FROM CompanyInfo` — entity, fiscal year, address, contact
2. `SELECT Id, Name, AccountType, AccountSubType, CurrentBalance FROM Account MAXRESULTS 1000` — GL accounts
3. `SELECT Id, Name FROM Class MAXRESULTS 200` — classes (if the owner uses class tracking)
4. `SELECT Id, DisplayName FROM Vendor MAXRESULTS 1000` — vendors
5. `SELECT Id, Name, Value FROM Preferences` — preferences

The tool also runs sandbox detection. If it detects test data (company name contains "sample", empty vendor list, all-zero balances), it warns the owner and marks the snapshot as not production-ready.

The snapshot is saved to `business-snapshot.json` in the plugin's data directory. Future QBO queries can reference accounts and vendors from the snapshot without re-explaining the books.

## Step 5: Reauth Warning Profile

During onboarding, ask the owner: "How loud do you want reauth warnings when your connection is about to expire?"

Accept one of:
- **Quiet** — surface only on the assistant's normal heartbeat; no DM/notification.
- **Heads-up** — chat message 14 days before RT expiry; strong message 3 days before.
- **Loud** — notification/email at 30, 14, 7, 3, 1 days.

The default (set in config.json) is "heads-up". The owner can change it by editing `config.json` in the plugin directory.

## Step 6: Ongoing Health Checks

Before any QBO operation, call **qbo_status** to verify the connection is still live. If the access token is near expiry, any query tool will auto-refresh it. If the refresh token is expired, the tool will tell the owner to reauthorize via **qbo_connect**.

## Operating-Ready Handoff

Once Steps 0-6 are complete and the snapshot is saved, the connection is ready for an Operating-layer skill. The Operating layer reads:
- `state.json` (token + realm_id) from the plugin's data directory
- `business-snapshot.json` (accounts, vendors, preferences) from the plugin's data directory
- The owner's reauth warning profile from `config.json`

An Operating-layer skill uses those paths and operates on the books. It does not need tokens passed to it — the connector's tools reconstruct them from state.json.

## Beginner-Friendly Walkthrough

If the owner doesn't know what their Intuit app is or where the codes are, walk them through this instead of Step 0:

> **If you've never created an Intuit developer app:** I'll walk you through that first — it's a one-time 5-minute setup. See the "Creating an Intuit Developer App" section above.
>
> **If you already have an app but need to find the credentials:**
>
> 1. **Redirect URL** — if you've never registered an app in Intuit's developer portal, I'll use Intuit's test playground URL (a known-valid default). If you have registered your own app, paste me the redirect URL you set up.
>
> 2. **App username (client_id)** — public, you can paste it in chat. Find it at developer.intuit.com → Your Apps → click your app → look for "Client ID" or "Key".
>
> 3. **App password (client_secret)** — private, I'll collect it through a secure prompt so it goes into an encrypted vault, never through chat.

QBO uses a security pattern where I hold a "refresh token" that lets me silently reconnect without bothering you, plus an "access token" for each query. About every 100 days the refresh token expires or Intuit revokes it; you then do a one-time login and I get a fresh pair. Three intrinsically-manual steps in that flow: your Intuit MFA login, the "Authorize this app" consent click, the browser capturing the auth code. Everything else is orchestration I should be doing invisibly.

## Developer Appendix

### Things-that-Bit-You (Connector-Layer)

1. **Token shape validation** — Intuit RTs are ~41 chars (`RT1-{epoch}-{...}` pattern). ATs are JWT-format strings much longer. The tools validate both shapes before persisting and refuse to save anything that doesn't match.

2. **Refresh rotation is atomic** — Every refresh rotates BOTH the access token AND the refresh token. The old RT is immediately invalid. The tools handle this atomically (tmp file → rename).

3. **Realm_id is returned at OAuth, not at registration** — Don't pre-fill from client_id/secret. The callback `realmId` parameter is the source of truth.

4. **Sandbox intersection** — Intuit dev accounts use a separate OAuth app + endpoint. Don't mix sandbox and production client_id/client_secret — they identify distinct OAuth apps.

5. **Rate limits** — QBO enforces ~500 req/min per realm. If a sibling skill is hammering, back off rather than bursting.

6. **Proxy failures are not API failures** — When `quickbooks.api.intuit.com` returns 502 through the proxy, the tools retry with a direct `fetch` call. The proxy is convenience, not the actual transport.

7. **CSRF state is not capturable from the Playground** — The Intuit OAuth Playground shows `code` and `realmId` but not `state`. Manual operator flows get `csrf_verified: false` annotation and proceed. CSRF is meaningful for headless flows; it's theater when the owner is the operator.

8. **Out-of-band Intuit RT kills** — Intuit can close the connection while state.json still shows `refresh_expires_utc` as future-dated. The tools trust the API response (`invalid_grant`) over local state.

### QBO Query Cookbook

- `Transaction` is abstract in QBO. Query `Bill` or `Purchase` directly.
- `Purchase` uses `EntityRef`, not `VendorRef`. `EntityRef` is not queryable — pull by date range and filter client-side.
- GL accounts are under the `Account` entity (not `GLAccount`).
- Classes are under `Class` (only if class tracking is enabled).

### Data Directory Layout

```
plugins/qbo-connector/data/
├── state.json              # Live tokens + realm_id (chmod 600)
├── credentials.json        # client_id, client_secret, redirect_uri (chmod 600)
├── business-snapshot.json  # Discovery snapshot (5 queries + sandbox check)
└── .oauth_state            # CSRF state token (deleted after exchange)
```

This is separate from any existing QBO connection at `/workspace/data/qbo/`. The plugin does not touch or read from that path.

### Config (user-editable, survives upgrades)

```json
{
  "redirect_uri_default": "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl",
  "reauth_warning_profile_default": "heads-up",
  "token_refresh_threshold_seconds": 60,
  "refresh_expiry_days": 100
}
```

Edit `config.json` in the plugin root to change defaults. The data directory is preserved across plugin reinstalls.

## SKILL COMPLETE WHEN

- [ ] qbo_connect succeeded (state.json with all 7 fields saved)
- [ ] qbo_status shows connection healthy (access + refresh tokens valid)
- [ ] qbo_discover built the business snapshot (5 sections + sandbox check)
- [ ] Sandbox-vs-production check issued; result recorded in snapshot
- [ ] Reauth warning profile collected from owner (or default accepted)
- [ ] Owner told how loud reauth warnings will be
- [ ] Owner has acknowledged completion
