// Shared QBO client: token lifecycle, API calls, state management.
// Bakes in the four Jun 25 reauth lessons as code, not prose:
//   1. Playground redirect URI as default (not a hard env-var requirement)
//   2. CSRF state optional for manual operator flows (annotate, don't ABORT)
//   3. Transaction is abstract — query Bill/Purchase directly
//   4. Proxy failures are not API failures — retry directly

import {
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import type {
  QboState,
  QboCredentials,
  QboBusinessSnapshot,
  QboConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PLUGIN_SEGMENT = ["plugins", "qbo-connector", "data"];

function dataDir(workingDir: string): string {
  return join(workingDir, ...PLUGIN_SEGMENT);
}

export function statePath(workingDir: string): string {
  return join(dataDir(workingDir), "state.json");
}

export function snapshotPath(workingDir: string): string {
  return join(dataDir(workingDir), "business-snapshot.json");
}

export function csrfPath(workingDir: string): string {
  return join(dataDir(workingDir), ".oauth_state");
}

export function credPath(workingDir: string): string {
  return join(dataDir(workingDir), "credentials.json");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function readConfig(workingDir: string): QboConfig {
  const p = join(workingDir, "plugins", "qbo-connector", "config.json");
  const defaults: QboConfig = {
    redirect_uri_default:
      "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl",
    reauth_warning_profile_default: "heads-up",
    token_refresh_threshold_seconds: 60,
    refresh_expiry_days: 100,
  };
  if (!existsSync(p)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(p, "utf-8")) };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// State I/O (atomic writes, chmod 600)
// ---------------------------------------------------------------------------

export function readState(workingDir: string): QboState | null {
  const p = statePath(workingDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as QboState;
  } catch {
    return null;
  }
}

export function writeState(workingDir: string, state: QboState): void {
  const dir = dataDir(workingDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "state.json.tmp");
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8" });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, statePath(workingDir));
}

// ---------------------------------------------------------------------------
// Credentials I/O
// ---------------------------------------------------------------------------

export function readCredentials(workingDir: string): QboCredentials | null {
  const p = credPath(workingDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as QboCredentials;
  } catch {
    return null;
  }
}

export function writeCredentials(
  workingDir: string,
  creds: QboCredentials,
): void {
  const dir = dataDir(workingDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "credentials.json.tmp");
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { encoding: "utf-8" });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, credPath(workingDir));
}

// ---------------------------------------------------------------------------
// CSRF state file
// ---------------------------------------------------------------------------

export function writeCsrfState(workingDir: string, state: string): void {
  const dir = dataDir(workingDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(csrfPath(workingDir), state, { encoding: "utf-8" });
}

export function readCsrfState(workingDir: string): string | null {
  const p = csrfPath(workingDir);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf-8").trim(); } catch { return null; }
}

export function deleteCsrfState(workingDir: string): void {
  const p = csrfPath(workingDir);
  if (existsSync(p)) { try { unlinkSync(p); } catch {} }
}

// ---------------------------------------------------------------------------
// Token shape validation (Things-that-Bit-You #1)
// ---------------------------------------------------------------------------

export function isValidRefreshTokenShape(token: string): boolean {
  return token.startsWith("RT1-") && token.length >= 30;
}

export function isValidAccessTokenShape(token: string): boolean {
  return token.length > 100 && token.includes(".");
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function nowUtc(): string {
  return new Date().toISOString();
}

export function isExpired(
  expiresUtc: string,
  thresholdSeconds: number = 0,
): boolean {
  const expiry = new Date(expiresUtc).getTime();
  return Date.now() >= expiry - thresholdSeconds * 1000;
}

export function secondsUntilExpiry(expiresUtc: string): number {
  const expiry = new Date(expiresUtc).getTime();
  return Math.floor((expiry - Date.now()) / 1000);
}

export function humanizeSeconds(total: number): string {
  if (total <= 0) return "expired";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// Direct HTTP fallback (Lesson #4 extension: proxy 5xx is not an API error)
// bun's fetch routes through the credential proxy, which returns HTTP 500
// for some Intuit endpoints. These helpers use node:https directly to bypass
// the proxy entirely. Used as a fallback when fetch returns 5xx.
// ---------------------------------------------------------------------------

interface DirectResponse {
  ok: boolean;
  status: number;
  text: string;
  json: () => unknown;
}

function directRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<DirectResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
    };
    const req = httpsRequest(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          ok: res.statusCode! >= 200 && res.statusCode! < 300,
          status: res.statusCode!,
          text: data,
          json: () => JSON.parse(data),
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Try fetch first. On 5xx (proxy failure) or network error, fall back to
 * a direct node:https call that bypasses the proxy.
 */
export async function fetchWithDirectFallback(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<DirectResponse> {
  try {
    const resp = await fetch(url, { method, headers, body });
    const text = await resp.text();
    const result: DirectResponse = {
      ok: resp.ok,
      status: resp.status,
      text,
      json: () => JSON.parse(text),
    };
    // 5xx likely a proxy issue, not an Intuit API error — retry direct
    if (resp.status >= 500) {
      return await directRequest(method, url, headers, body);
    }
    return result;
  } catch {
    // Network error (proxy unreachable) — try direct
    return await directRequest(method, url, headers, body);
  }
}

// ---------------------------------------------------------------------------
// Token refresh (Lesson: RT rotation is atomic — old RT dies immediately)
// ---------------------------------------------------------------------------

const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface RefreshResult {
  success: boolean;
  state?: QboState;
  error?: string;
}

export async function refreshTokens(
  workingDir: string,
  credentials?: QboCredentials,
  force: boolean = false,
): Promise<RefreshResult> {
  const state = readState(workingDir);
  if (!state) {
    return {
      success: false,
      error: "No state.json found. Connect first using the qbo_connect tool.",
    };
  }

  const config = readConfig(workingDir);
  if (!force && !isExpired(state.access_expires_utc, config.token_refresh_threshold_seconds)) {
    return { success: true, state };
  }

  const creds = credentials ?? readCredentials(workingDir);
  if (!creds || !creds.client_id || !creds.client_secret) {
    return {
      success: false,
      error: "No credentials found. Provide client_id and client_secret, or save them via qbo_connect.",
    };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refresh_token,
  });

  const authHeader =
    "Basic " +
    Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");

  try {
    const resp = await fetchWithDirectFallback(
      "POST",
      TOKEN_ENDPOINT,
      {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body.toString(),
    );

    if (!resp.ok) {
      if (resp.text.includes("invalid_grant")) {
        return {
          success: false,
          error: "Refresh token is invalid or revoked (invalid_grant). Intuit may have killed it out-of-band. Reauthorization required — call qbo_connect to start a new OAuth flow.",
        };
        }
        return {
          success: false,
          error: `Token refresh failed: HTTP ${resp.status} — ${resp.text}`,
        };
    }

    const data = resp.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    if (!isValidAccessTokenShape(data.access_token)) {
      return {
        success: false,
        error: "Received access token has unexpected shape. Refusing to persist.",
      };
    }
    if (!isValidRefreshTokenShape(data.refresh_token)) {
      return {
        success: false,
        error: "Received refresh token has unexpected shape. Refusing to persist.",
      };
    }

    const issuance = new Date();
    const newState: QboState = {
      refresh_token: data.refresh_token,
      access_token: data.access_token,
      access_expires_utc: new Date(issuance.getTime() + data.expires_in * 1000).toISOString(),
      refresh_expires_utc: new Date(issuance.getTime() + config.refresh_expiry_days * 86400 * 1000).toISOString(),
      last_refresh_utc: issuance.toISOString(),
      updated_utc: issuance.toISOString(),
      realm_id: state.realm_id,
      csrf_verified: state.csrf_verified,
    };

    writeState(workingDir, newState);
    return { success: true, state: newState };
  } catch (err) {
    return {
      success: false,
      error: `Token refresh network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// QBO API query (with auto-refresh + proxy fallback, Lesson #4)
// ---------------------------------------------------------------------------

export interface QueryResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export async function qboQuery(
  workingDir: string,
  query: string,
  credentials?: QboCredentials,
): Promise<QueryResult> {
  const state = readState(workingDir);
  if (!state) {
    return {
      success: false,
      error: "No state.json found. Connect first using the qbo_connect tool.",
    };
  }

  const config = readConfig(workingDir);
  if (isExpired(state.access_expires_utc, config.token_refresh_threshold_seconds)) {
    const r = await refreshTokens(workingDir, credentials);
    if (!r.success) {
      return { success: false, error: r.error };
    }
  }

  const currentState = readState(workingDir)!;
  const url = `https://quickbooks.api.intuit.com/v3/company/${currentState.realm_id}/query?query=${encodeURIComponent(query)}`;

  const headers = {
    Authorization: `Bearer ${currentState.access_token}`,
    Accept: "application/json",
  };

  try {
    const resp = await fetchWithDirectFallback("GET", url, headers);

    if (resp.status === 401) {
      const r = await refreshTokens(workingDir, credentials, true);
      if (!r.success || !r.state) {
        return {
          success: false,
          error: "Access token expired and refresh failed. Reauthorization required.",
        };
      }
      const retryState = readState(workingDir)!;
      const retryResp = await fetchWithDirectFallback("GET", url, {
        Authorization: `Bearer ${retryState.access_token}`,
        Accept: "application/json",
      });
      if (!retryResp.ok) {
        return { success: false, error: `QBO query retry failed: HTTP ${retryResp.status} — ${retryResp.text}` };
      }
      return { success: true, data: retryResp.json() };
    }

    if (!resp.ok) {
      return { success: false, error: `QBO query failed: HTTP ${resp.status} — ${resp.text}` };
    }

    return { success: true, data: resp.json() };
  } catch (err) {
    // Last-resort: proxy + direct both failed
    return {
      success: false,
      error: `QBO query network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Company info verification (the "gate" — not a saved state.json)
// ---------------------------------------------------------------------------

export interface CompanyInfo {
  success: boolean;
  company_name?: string;
  legal_name?: string;
  country?: string;
  fiscal_year_start?: string;
  error?: string;
}

export async function verifyCompanyInfo(
  workingDir: string,
  credentials?: QboCredentials,
): Promise<CompanyInfo> {
  const r = await qboQuery(workingDir, "SELECT * FROM CompanyInfo", credentials);
  if (!r.success || !r.data) {
    return { success: false, error: r.error };
  }

  const data = r.data as {
    QueryResponse?: {
      CompanyInfo?: {
        CompanyName?: string;
        LegalName?: string;
        Country?: string;
        FiscalYearStartMonth?: string;
      };
    };
  };

  const info = data.QueryResponse?.CompanyInfo;
  if (!info) {
    return { success: false, error: "CompanyInfo not found in QBO response." };
  }

  return {
    success: true,
    company_name: info.CompanyName,
    legal_name: info.LegalName,
    country: info.Country,
    fiscal_year_start: info.FiscalYearStartMonth,
  };
}

// ---------------------------------------------------------------------------
// Sandbox detection (Step 4 guard)
// ---------------------------------------------------------------------------

export function detectSandbox(
  companyInfo: unknown,
  vendors: unknown,
  glAccounts: unknown,
): { is_sandbox: boolean; signals: string[] } {
  const signals: string[] = [];

  const ci = companyInfo as {
    QueryResponse?: { CompanyInfo?: { CompanyName?: string } };
  } | undefined;
  const v = vendors as {
    QueryResponse?: { Vendor?: Array<{ Name?: string }> };
  } | undefined;
  const gl = glAccounts as {
    QueryResponse?: { Account?: Array<{ CurrentBalance?: number }> };
  } | undefined;

  const companyName = ci?.QueryResponse?.CompanyInfo?.CompanyName;
  if (companyName?.toLowerCase().includes("sample")) {
    signals.push("Company name contains 'sample'");
  }

  const vendorList = v?.QueryResponse?.Vendor;
  if (!vendorList || vendorList.length === 0) {
    signals.push("Vendor list is empty");
  } else if (vendorList.some((vd) => vd.Name?.toLowerCase().includes("sample"))) {
    signals.push("Vendor list contains a 'sample' vendor");
  }

  const accounts = gl?.QueryResponse?.Account;
  if (accounts && accounts.length > 0) {
    if (accounts.every((a) => (a.CurrentBalance ?? 0) === 0)) {
      signals.push("All GL account balances are zero");
    }
  }

  return { is_sandbox: signals.length >= 2, signals };
}

// ---------------------------------------------------------------------------
// Random CSRF state token
// ---------------------------------------------------------------------------

export function generateStateToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let token = "";
  for (let i = 0; i < bytes.length; i++) {
    token += chars[bytes[i] % chars.length];
  }
  return token;
}

// ---------------------------------------------------------------------------
// Snapshot I/O
// ---------------------------------------------------------------------------

export function readSnapshot(workingDir: string): QboBusinessSnapshot | null {
  const p = snapshotPath(workingDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as QboBusinessSnapshot;
  } catch {
    return null;
  }
}

export function writeSnapshot(
  workingDir: string,
  snapshot: QboBusinessSnapshot,
): void {
  const dir = dataDir(workingDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "business-snapshot.json.tmp");
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf-8" });
  renameSync(tmp, snapshotPath(workingDir));
}
