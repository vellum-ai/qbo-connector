// qbo_status: Check the health of the QBO connection.
// Shows token expiry, refresh status, and whether the connection is live.

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";
import {
  readState,
  readCredentials,
  isExpired,
  secondsUntilExpiry,
  humanizeSeconds,
  readSnapshot,
} from "../src/qbo-client";

export default {
  description:
    "Check the health of the QuickBooks Online connection. Shows token " +
    "expiry (access + refresh), whether tokens need refreshing, and if a " +
    "business snapshot exists. Use this before any QBO operation to verify " +
    "the connection is live, or when the owner asks 'is QBO still connected?'",

  defaultRiskLevel: "low" as const,

  input_schema: {
    type: "object",
    properties: {},
  },

  async execute(
    _input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const workingDir = ctx.workingDir;
    const state = readState(workingDir);
    const creds = readCredentials(workingDir);
    const snapshot = readSnapshot(workingDir);

    if (!state) {
      return {
        content:
          "Not connected. No state.json found.\n\n" +
          "To connect, call qbo_connect with step='start' to begin the OAuth flow.",
        isError: false,
      };
    }

    const atSeconds = secondsUntilExpiry(state.access_expires_utc);
    const rtSeconds = secondsUntilExpiry(state.refresh_expires_utc);
    const atExpired = isExpired(state.access_expires_utc, 60);
    const rtExpired = isExpired(state.refresh_expires_utc);
    const hasCreds = creds && creds.client_id && creds.client_secret;

    const lines: string[] = [];
    lines.push("QBO Connection Status");
    lines.push("========================================");
    lines.push("Realm ID: " + state.realm_id);
    lines.push("Access token: " + (atExpired ? "EXPIRED" : "valid") + " (" + humanizeSeconds(atSeconds) + " remaining)");
    lines.push("Refresh token: " + (rtExpired ? "EXPIRED" : "valid") + " (" + humanizeSeconds(rtSeconds) + " remaining)");
    lines.push("Credentials saved: " + (hasCreds ? "yes" : "no (needed for refresh)"));
    lines.push("CSRF verified: " + (state.csrf_verified === false ? "annotated unverified" : "yes"));
    lines.push("Last refresh: " + state.last_refresh_utc);
    lines.push("Business snapshot: " + (snapshot ? "exists" : "not built (call qbo_discover)"));

    if (snapshot) {
      lines.push("  Production ready: " + (snapshot.production_ready ? "yes" : "sandbox detected"));
      lines.push("  Captured: " + snapshot.captured_utc);
    }

    lines.push("");
    if (rtExpired) {
      lines.push("ACTION REQUIRED: Refresh token has expired. The connection is dead.");
      lines.push("  Call qbo_connect with step='start' to reauthorize through Intuit.");
    } else if (atExpired) {
      lines.push("Access token needs refreshing. Call qbo_refresh to get a new one.");
      lines.push("  (Any QBO query tool will also auto-refresh, so this is not urgent.)");
    } else {
      lines.push("Connection is healthy.");
    }

    return { content: lines.join("\n"), isError: false };
  },
};
