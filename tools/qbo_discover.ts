// qbo_discover: Build the business snapshot.
// Runs the five discovery queries, saves the result, and checks for sandbox data.
// This is Step 4 from the original skill, now as a single tool call.

import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";
import {
  qboQuery,
  detectSandbox,
  writeSnapshot,
  readConfig,
  readSnapshot,
  nowUtc,
} from "../src/qbo-client";
import type { QboBusinessSnapshot } from "../src/types";

export default {
  description:
    "Discover the structure of the connected QuickBooks Online books. Runs " +
    "five queries (company info, GL accounts, classes, vendors, preferences), " +
    "saves the result as a business snapshot, and checks for sandbox/test data. " +
    "Call this after qbo_connect succeeds. The snapshot lets future QBO " +
    "queries reference accounts and vendors without re-explaining the books.",

  defaultRiskLevel: "low" as const,

  input_schema: {
    type: "object",
    properties: {
      force: {
        type: "boolean",
        description:
          "If true, rebuilds the snapshot even if one already exists. " +
          "Default: false (returns existing snapshot if present).",
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const workingDir = ctx.workingDir;
    const force = Boolean(input.force);

    if (!force) {
      const existing = readSnapshot(workingDir);
      if (existing) {
        return {
          content:
            "Business snapshot already exists (captured " + existing.captured_utc + ").\n" +
            "Production ready: " + existing.production_ready + "\n" +
            "Sandbox: " + existing.sandbox_check.is_sandbox + "\n\n" +
            "Call with force=true to rebuild.",
          isError: false,
        };
      }
    }

    const queries = {
      company_info: "SELECT * FROM CompanyInfo",
      gl_accounts: "SELECT Id, Name, AccountType, AccountSubType, CurrentBalance FROM Account MAXRESULTS 1000",
      classes: "SELECT Id, Name FROM Class MAXRESULTS 200",
      vendors: "SELECT Id, DisplayName FROM Vendor MAXRESULTS 1000",
      preferences: "SELECT * FROM Preferences",
    };

    const results: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const [key, query] of Object.entries(queries)) {
      const r = await qboQuery(workingDir, query);
      if (r.success && r.data) {
        results[key] = r.data;
      } else {
        errors.push(key + ": " + r.error);
        results[key] = null;
      }
    }

    const sandboxCheck = detectSandbox(
      results.company_info,
      results.vendors,
      results.gl_accounts,
    );

    const config = readConfig(workingDir);
    const snapshot: QboBusinessSnapshot = {
      company_info: results.company_info,
      gl_accounts: results.gl_accounts,
      classes: results.classes,
      vendors: results.vendors,
      preferences: results.preferences,
      sandbox_check: sandboxCheck,
      production_ready: !sandboxCheck.is_sandbox,
      reauth_warning_profile: config.reauth_warning_profile_default,
      captured_utc: nowUtc(),
    };

    writeSnapshot(workingDir, snapshot);

    const lines: string[] = [];
    lines.push("Business Snapshot Built");
    lines.push("========================================");

    const ci = results.company_info as {
      QueryResponse?: { CompanyInfo?: { CompanyName?: string; Country?: string } };
    } | undefined;
    const companyName = ci?.QueryResponse?.CompanyInfo?.CompanyName;
    lines.push("Company: " + (companyName ?? "unknown"));

    const gl = results.gl_accounts as {
      QueryResponse?: { Account?: unknown[] };
    } | undefined;
    const accountCount = gl?.QueryResponse?.Account?.length ?? 0;
    lines.push("GL Accounts: " + accountCount);

    const v = results.vendors as {
      QueryResponse?: { Vendor?: unknown[] };
    } | undefined;
    const vendorCount = v?.QueryResponse?.Vendor?.length ?? 0;
    lines.push("Vendors: " + vendorCount);

    lines.push("");
    if (sandboxCheck.is_sandbox) {
      lines.push("SANDBOX DATA DETECTED:");
      sandboxCheck.signals.forEach((s) => lines.push("  - " + s));
      lines.push("  These books look like Intuit sandbox/test data - no real money.");
      lines.push("  Do NOT proceed with operating on these books.");
    } else {
      lines.push("Production data confirmed (no sandbox signals detected).");
    }

    if (errors.length > 0) {
      lines.push("");
      lines.push("Some queries had errors:");
      errors.forEach((e) => lines.push("  - " + e));
    }

    lines.push("");
    lines.push("Snapshot saved to plugin data dir.");
    lines.push("Reauth warning profile: " + config.reauth_warning_profile_default);

    return { content: lines.join("\n"), isError: false };
  },
};
