// Shared types for the QBO connector plugin.

export interface QboState {
  refresh_token: string;
  access_token: string;
  access_expires_utc: string;
  refresh_expires_utc: string;
  last_refresh_utc: string;
  updated_utc: string;
  realm_id: string;
  csrf_verified?: boolean;
}

export interface QboCredentials {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

export interface QboBusinessSnapshot {
  company_info: unknown;
  gl_accounts: unknown;
  classes: unknown;
  vendors: unknown;
  preferences: unknown;
  sandbox_check: {
    is_sandbox: boolean;
    signals: string[];
  };
  production_ready: boolean;
  reauth_warning_profile?: string;
  captured_utc: string;
}

export interface QboConfig {
  redirect_uri_default: string;
  reauth_warning_profile_default: string;
  token_refresh_threshold_seconds: number;
  refresh_expiry_days: number;
}
