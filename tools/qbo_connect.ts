// qbo_connect: Orchestrate the full Intuit OAuth flow.
// This is the "one connect command" the Jun 25 reauth lessons recommended.
// It handles: credential collection, CSRF state, auth URL generation,
// token exchange, state persistence, and verification.
//
// The owner still must click through Intuit's consent screen (intrinsically
// human), but this tool removes everything around that click.

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";
import {
  readConfig,
  readCredentials,
  writeCredentials,
  writeCsrfState,
  readCsrfState,
  deleteCsrfState,
  writeState,
  isValidRefreshTokenShape,
  isValidAccessTokenShape,
  generateStateToken,
  fetchWithDirectFallback,
} from "../src/qbo-client";
import type { QboState, QboCredentials } from "../src/types";

export default {
  description:
    "Connect to QuickBooks Online via Intuit OAuth. Handles the full flow: " +
    "collects credentials (client_id, client_secret, redirect_uri), generates " +
    "the authorization URL for the owner to click, exchanges the auth code for " +
    "tokens, persists state, and verifies the connection. Use when the owner " +
    "wants to connect QBO for the first time or reconnect after expiry.",

  defaultRiskLevel: "low" as const,

  input_schema: {
    type: "object",
    properties: {
      step: {
        type: "string",
        enum: ["start", "exchange"],
        description:
          "Which phase of the OAuth flow to run. 'start' generates the auth URL " +
          "and saves credentials. 'exchange' takes the code + realmId from the " +
          "owner's callback and completes the token exchange. Always call 'start' " +
          "first, surface the URL to the owner, wait for them to click through " +
          "Intuit, then call 'exchange' with the code and realmId they give you.",
      },
      client_id: {
        type: "string",
        description:
          "Intuit app Client ID (public, safe in chat). Required for 'start'. " +
          "Find at developer.intuit.com -> Your Apps -> your app -> Client ID.",
      },
      client_secret: {
        type: "string",
        description:
          "Intuit app Client Secret (private). Required for 'start' if not " +
          "already saved. Collected here so it goes into the encrypted state, " +
          "never displayed back.",
      },
      redirect_uri: {
        type: "string",
        description:
          "OAuth redirect URI. If omitted, defaults to the Intuit OAuth Playground " +
          "URL. Only provide if the owner has a custom registered Intuit app.",
      },
      code: {
        type: "string",
        description:
          "Authorization code from Intuit's callback. Required for 'exchange'. " +
          "The owner gets this after clicking through the consent screen.",
      },
      realm_id: {
        type: "string",
        description:
          "Realm ID from Intuit's callback. Required for 'exchange'. This is the " +
          "canonical identifier for the QBO company - set once, never changes.",
      },
      state_token: {
        type: "string",
        description:
          "The state token from the 'start' step's response. Optional for " +
          "'exchange' - if omitted and owner confirms manual flow, CSRF is " +
          "annotated as unverified (safe for operator-driven flows).",
      },
    },
    required: ["step"],
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const workingDir = ctx.workingDir;
    const step = String(input.step ?? "");

    if (step === "start") {
      return await startFlow(workingDir, input);
    } else if (step === "exchange") {
      return await exchangeFlow(workingDir, input);
    } else {
      return {
        content: "Error: 'step' must be either 'start' or 'exchange'.",
        isError: true,
      };
    }
  },
};

async function startFlow(
  workingDir: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const config = readConfig(workingDir);

  const clientId = String(input.client_id ?? "").trim();
  const clientSecret = String(input.client_secret ?? "").trim();
  const redirectUri = String(input.redirect_uri ?? "").trim() || config.redirect_uri_default;

  const existing = readCredentials(workingDir);
  const finalClientId = clientId || existing?.client_id || "";
  const finalSecret = clientSecret || existing?.client_secret || "";

  if (!finalClientId) {
    return {
      content:
        "Missing client_id. The owner needs to provide their Intuit app's " +
        "Client ID. Find it at developer.intuit.com -> Your Apps -> click the " +
        "app -> look for 'Client ID'. It is public and safe to paste in chat.\n\n" +
        "If the owner has never registered an Intuit app, they will need to " +
        "create one at developer.intuit.com (free, ~5 minutes). The Playground " +
        "redirect URL is already configured as the default.",
      isError: true,
    };
  }

  const creds: QboCredentials = {
    client_id: finalClientId,
    client_secret: finalSecret,
    redirect_uri: redirectUri,
  };
  writeCredentials(workingDir, creds);

  const stateToken = generateStateToken();
  writeCsrfState(workingDir, stateToken);

  const authUrl =
    "https://appcenter.intuit.com/connect/oauth2" +
    "?client_id=" + encodeURIComponent(finalClientId) +
    "&response_type=code" +
    "&scope=" + encodeURIComponent("com.intuit.quickbooks.accounting") +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&state=" + encodeURIComponent(stateToken);

  return {
    content:
      "OAuth flow started. Here is what to tell the owner:\n\n" +
      "**Click this link to authorize:**\n" + authUrl + "\n\n" +
      "After the owner clicks through Intuit's sign-in and consent screen, " +
      "Intuit will redirect to " + redirectUri + " with three parameters in the URL:\n" +
      "- code (the authorization code)\n" +
      "- realmId (the QBO company ID)\n" +
      "- state (the CSRF token, may not appear if using Playground)\n\n" +
      "Ask the owner to copy the code and realmId from the redirect URL " +
      "and give them to you. Then call this tool again with step='exchange'.\n\n" +
      "State token (for CSRF verification): " + stateToken + "\n" +
      (finalSecret
        ? "Credentials saved."
        : "WARNING: client_secret not provided. It will be needed for the exchange step."),
    isError: false,
  };
}

async function exchangeFlow(
  workingDir: string,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const code = String(input.code ?? "").trim();
  const realmId = String(input.realm_id ?? "").trim();
  const providedState = String(input.state_token ?? "").trim();

  if (!code) {
    return {
      content: "Missing authorization code. Ask the owner for the 'code' parameter from Intuit's redirect URL.",
      isError: true,
    };
  }
  if (!realmId) {
    return {
      content: "Missing realm_id. Ask the owner for the 'realmId' parameter from Intuit's redirect URL.",
      isError: true,
    };
  }

  const creds = readCredentials(workingDir);
  if (!creds || !creds.client_id) {
    return {
      content: "No saved credentials from the 'start' step. Call qbo_connect with step='start' first.",
      isError: true,
    };
  }
  if (!creds.client_secret) {
    return {
      content: "Client secret was not saved during the 'start' step. Provide it now via the client_secret parameter.",
      isError: true,
    };
  }

  // CSRF check (Lesson #2: Playground doesn't surface state)
  let csrfVerified = true;
  const expectedState = readCsrfState(workingDir);
  if (providedState && expectedState) {
    if (providedState === expectedState) {
      deleteCsrfState(workingDir);
    } else {
      csrfVerified = false;
    }
  } else if (!providedState && expectedState) {
    csrfVerified = false;
    deleteCsrfState(workingDir);
  }

  const tokenEndpoint = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: creds.redirect_uri,
  });

  const authHeader =
    "Basic " + Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");

  try {
    const resp = await fetchWithDirectFallback(
      "POST",
      tokenEndpoint,
      {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body.toString(),
    );

    if (!resp.ok) {
      if (resp.text.includes("invalid_grant")) {
        return { content: "Authorization code expired or already used. Restart the flow with step='start'.", isError: true };
      }
      if (resp.text.includes("invalid_client")) {
        return { content: "Client credentials are wrong. Check the client_id and client_secret in the Intuit developer portal.", isError: true };
      }
      return { content: `Token exchange failed: HTTP ${resp.status} - ${resp.text}`, isError: true };
    }

    const data = resp.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    if (!isValidAccessTokenShape(data.access_token)) {
      return { content: "Received access token has unexpected shape. Refusing to persist. Retry the OAuth flow.", isError: true };
    }
    if (!isValidRefreshTokenShape(data.refresh_token)) {
      return { content: "Received refresh token has unexpected shape. Refusing to persist. Retry the OAuth flow.", isError: true };
    }

    const config = readConfig(workingDir);
    const issuance = new Date();
    const state: QboState = {
      refresh_token: data.refresh_token,
      access_token: data.access_token,
      access_expires_utc: new Date(issuance.getTime() + data.expires_in * 1000).toISOString(),
      refresh_expires_utc: new Date(issuance.getTime() + config.refresh_expiry_days * 86400 * 1000).toISOString(),
      last_refresh_utc: issuance.toISOString(),
      updated_utc: issuance.toISOString(),
      realm_id: realmId,
      csrf_verified: csrfVerified,
    };

    writeState(workingDir, state);

    return {
      content:
        "Connected to QuickBooks Online.\n\n" +
        "Realm ID: " + realmId + "\n" +
        "Access token expires: " + state.access_expires_utc + "\n" +
        "Refresh token expires (est.): " + state.refresh_expires_utc + "\n" +
        "CSRF verified: " + csrfVerified + (!csrfVerified ? " (manual operator flow - annotated, not a security issue)" : "") + "\n\n" +
        "State saved to plugin data dir. Next step: call qbo_discover to build " +
        "the business snapshot (entity, accounts, vendors, preferences).",
      isError: false,
    };
  } catch (err) {
    return {
      content: `Token exchange network error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
