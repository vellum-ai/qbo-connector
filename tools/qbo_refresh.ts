// qbo_refresh: Force a token refresh.
// Normally auto-handled by qbo_query, but exposed as a standalone tool for
// when the owner wants to proactively refresh before a long batch job.

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";
import { refreshTokens, secondsUntilExpiry, humanizeSeconds } from "../src/qbo-client";

export default {
  description:
    "Force a QuickBooks Online token refresh. Rotates both the access token " +
    "and the refresh token (Intuit rotates both on every refresh). Use this " +
    "when the owner wants to proactively refresh before a batch of queries, " +
    "or when qbo_status shows the access token is near expiry. Most QBO tools " +
    "auto-refresh, so this is rarely needed manually.",

  defaultRiskLevel: "low" as const,

  input_schema: {
    type: "object",
    properties: {
      client_id: {
        type: "string",
        description: "Intuit Client ID. Optional if already saved from qbo_connect.",
      },
      client_secret: {
        type: "string",
        description: "Intuit Client Secret. Optional if already saved from qbo_connect.",
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const workingDir = ctx.workingDir;

    const creds = {
      client_id: String(input.client_id ?? ""),
      client_secret: String(input.client_secret ?? ""),
      redirect_uri: "",
    };

    const result = await refreshTokens(
      workingDir,
      creds.client_id ? creds : undefined,
      true,
    );

    if (!result.success) {
      return { content: "Token refresh failed: " + result.error, isError: true };
    }

    const state = result.state!;
    const atSeconds = secondsUntilExpiry(state.access_expires_utc);
    const rtSeconds = secondsUntilExpiry(state.refresh_expires_utc);

    return {
      content:
        "Tokens refreshed.\n\n" +
        "Access token: valid (" + humanizeSeconds(atSeconds) + " remaining)\n" +
        "Refresh token: valid (" + humanizeSeconds(rtSeconds) + " remaining)\n" +
        "Last refresh: " + state.last_refresh_utc + "\n\n" +
        "Note: Intuit rotates BOTH tokens on every refresh. The old refresh " +
        "token is now invalid - the new one is saved to state.json.",
      isError: false,
    };
  },
};
