import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { ClaudeSecret, CodexSecret } from './store';

/**
 * The providers' own sign-in/refresh endpoints, called BY THE HUB (§14.115).
 * Same clients and parameters as their CLIs (`claude auth login`, `codex
 * login --device-auth`): the hub simply stands where the CLI used to, as the
 * single holder of each login. Verified end-to-end against the live services.
 */

const CLAUDE = {
  authorize: 'https://claude.com/cai/oauth/authorize',
  token: 'https://platform.claude.com/v1/oauth/token',
  redirect: 'https://platform.claude.com/oauth/code/callback',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  api: 'https://api.anthropic.com',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code',
    'user:mcp_servers', 'user:file_upload', 'user:plugins'],
};
const CODEX = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  verifyUrl: 'https://auth.openai.com/codex/device',
  usage: 'https://chatgpt.com/backend-api/wham/usage',
};
const UA = 'charon-hub';
const TIMEOUT_MS = 30_000;

export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null,
    readonly retryAfterMs: number | null = null) { super(message); }
  /** The login itself is dead: sign in again (vs a transient failure). */
  get revoked(): boolean {
    return this.status === 400 || this.status === 401 || this.status === 403
      || /invalid_grant|refresh_token_(reused|expired|invalidated)|revoked/i.test(this.code ?? this.message);
  }
}

function retryAfterMs(h: Headers): number | null {
  const v = h.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function call(url: string, init: RequestInit & { json?: unknown; form?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { 'User-Agent': UA, ...(init.headers as Record<string, string> | undefined) };
  let body: BodyInit | undefined;
  if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.json); }
  if (init.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
  const res = await fetch(url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

function fail(what: string, r: { status: number; body: any; headers: Headers }): never {
  const err = r.body?.error;
  const code = typeof err === 'string' ? err : err?.code ?? err?.type ?? null;
  const message = (typeof err === 'object' && err?.message) || r.body?.error_description || (typeof r.body === 'string' ? r.body.slice(0, 200) : '') || `HTTP ${r.status}`;
  throw new ProviderHttpError(`${what}: ${message}`, r.status, code, retryAfterMs(r.headers));
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Claude ───────────────────────────────────────────────────────────────────

export type ClaudeAuthorize = { url: string; verifier: string; state: string };

export function claudeAuthorize(): ClaudeAuthorize {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    code: 'true', client_id: CLAUDE.clientId, response_type: 'code', redirect_uri: CLAUDE.redirect,
    scope: CLAUDE.scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  return { url: `${CLAUDE.authorize}?${q.toString()}`, verifier, state };
}

type ClaudeTokens = { access_token: string; refresh_token: string; expires_in: number; refresh_token_expires_in?: number; scope?: string;
  account?: { uuid?: string; email_address?: string }; organization?: { uuid?: string; name?: string } };

/** The pasted callback value is `code#state`. */
export async function claudeExchange(pasted: string, attempt: ClaudeAuthorize): Promise<ClaudeTokens> {
  const [code, state] = pasted.trim().split('#');
  if (!code) throw new ProviderHttpError('Paste the code shown after signing in.', 400, 'invalid_code');
  if (state && state !== attempt.state) throw new ProviderHttpError('This code belongs to another sign-in attempt.', 400, 'state_mismatch');
  const r = await call(CLAUDE.token, { json: { grant_type: 'authorization_code', code, redirect_uri: CLAUDE.redirect,
    client_id: CLAUDE.clientId, code_verifier: attempt.verifier, state: attempt.state } });
  if (r.status !== 200 || !r.body?.access_token) fail('Claude sign-in', r);
  return r.body as ClaudeTokens;
}

export async function claudeRefresh(secret: ClaudeSecret): Promise<ClaudeTokens> {
  const r = await call(CLAUDE.token, { json: { grant_type: 'refresh_token', refresh_token: secret.refreshToken,
    client_id: CLAUDE.clientId, scope: (secret.scopes?.length ? secret.scopes : CLAUDE.scopes.slice(1)).join(' ') } });
  if (r.status !== 200 || !r.body?.access_token) fail('Claude refresh', r);
  return r.body as ClaudeTokens;
}

async function claudeGet(path: string, token: string): Promise<{ status: number; body: any; headers: Headers }> {
  return call(`${CLAUDE.api}${path}`, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' } });
}

export type ClaudeProfile = { account: Record<string, any>; organization: Record<string, any> };

export async function claudeProfile(token: string): Promise<ClaudeProfile> {
  const r = await claudeGet('/api/oauth/profile', token);
  if (r.status !== 200 || !r.body?.account) fail('Claude profile', r);
  return r.body as ClaudeProfile;
}

/** The CLI's own plan words, from the profile (its `subscriptionType`). */
export function claudePlan(p: ClaudeProfile): string | null {
  const type = String(p.organization?.organization_type ?? '');
  const m = /^claude_(max|pro|team|enterprise)$/.exec(type);
  if (m) return m[1];
  if (p.account?.has_claude_max) return 'max';
  if (p.account?.has_claude_pro) return 'pro';
  return null;
}

/** `.claude.json` `oauthAccount`, as the CLI writes it after a sign-in. */
export function claudeOauthAccount(p: ClaudeProfile): Record<string, unknown> {
  const a = p.account ?? {}; const o = p.organization ?? {};
  const out: Record<string, unknown> = {
    accountUuid: a.uuid, emailAddress: a.email, organizationUuid: o.uuid,
    displayName: a.display_name ?? undefined, fullName: a.full_name ?? undefined,
    organizationName: o.name ?? undefined, organizationType: o.organization_type ?? undefined,
    billingType: o.billing_type ?? undefined, organizationRateLimitTier: o.rate_limit_tier ?? undefined,
    hasExtraUsageEnabled: o.has_extra_usage_enabled ?? undefined, planDisplayName: o.plan_display_name ?? undefined,
    accountCreatedAt: a.created_at ?? undefined, subscriptionCreatedAt: o.subscription_created_at ?? undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function claudeSecretFrom(t: ClaudeTokens, now: number, previous?: ClaudeSecret, profile?: ClaudeProfile): ClaudeSecret {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || previous?.refreshToken || '',
    expiresAt: now + t.expires_in * 1000,
    refreshTokenExpiresAt: typeof t.refresh_token_expires_in === 'number' ? now + t.refresh_token_expires_in * 1000 : previous?.refreshTokenExpiresAt ?? null,
    scopes: t.scope ? t.scope.split(' ').filter(Boolean) : previous?.scopes ?? CLAUDE.scopes.slice(1),
    subscriptionType: profile ? claudePlan(profile) : previous?.subscriptionType ?? null,
    rateLimitTier: profile ? (profile.organization?.rate_limit_tier ?? null) : previous?.rateLimitTier ?? null,
    oauthAccount: profile ? claudeOauthAccount(profile) : previous?.oauthAccount ?? null,
  };
}

export async function claudeUsage(token: string): Promise<{ status: number; body: any; retryAfterMs: number | null; orgId: string | null }> {
  const r = await claudeGet('/api/oauth/usage', token);
  return { status: r.status, body: r.body, retryAfterMs: retryAfterMs(r.headers), orgId: r.headers.get('anthropic-organization-id') };
}

// ── Codex (ChatGPT device code) ──────────────────────────────────────────────

export type CodexDevice = { deviceAuthId: string; userCode: string; intervalMs: number; expiresAt: number; url: string };

export async function codexDeviceStart(): Promise<CodexDevice> {
  const r = await call(`${CODEX.issuer}/api/accounts/deviceauth/usercode`, { json: { client_id: CODEX.clientId } });
  if (r.status !== 200 || !r.body?.device_auth_id) fail('Codex device code', r);
  const userCode = r.body.user_code ?? r.body.usercode;
  const interval = Number(r.body.interval);
  const expires = Date.parse(r.body.expires_at ?? '');
  return { deviceAuthId: r.body.device_auth_id, userCode, intervalMs: Math.max(2, Number.isFinite(interval) ? interval : 5) * 1000,
    expiresAt: Number.isFinite(expires) ? expires : Date.now() + 15 * 60_000, url: CODEX.verifyUrl };
}

/** null = still pending; tokens once the user approved. */
export async function codexDevicePoll(d: CodexDevice): Promise<CodexSecret | null> {
  const r = await call(`${CODEX.issuer}/api/accounts/deviceauth/token`, { json: { device_auth_id: d.deviceAuthId, user_code: d.userCode } });
  if (r.status === 403 || r.status === 404) {
    const code = r.body?.error?.code ?? '';
    if (!code || /pending|slow_down|not_found/i.test(code) || r.status === 404) return null;
    fail('Codex device code', r);
  }
  if (r.status !== 200 || !r.body?.authorization_code) fail('Codex device code', r);
  const x = await call(`${CODEX.issuer}/oauth/token`, { form: {
    grant_type: 'authorization_code', code: r.body.authorization_code, redirect_uri: `${CODEX.issuer}/deviceauth/callback`,
    client_id: CODEX.clientId, code_verifier: r.body.code_verifier,
  } });
  if (x.status !== 200 || !x.body?.access_token) fail('Codex sign-in', x);
  return codexSecretFrom(x.body);
}

export function jwtClaims(jwt: string): Record<string, any> {
  try {
    const part = jwt.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}

export function codexIdentity(s: CodexSecret): { email: string | null; plan: string | null; accountId: string | null; accessExp: number | null } {
  const id = jwtClaims(s.idToken);
  const auth = id['https://api.openai.com/auth'] ?? {};
  const access = jwtClaims(s.accessToken);
  return { email: typeof id.email === 'string' ? id.email : null, plan: auth.chatgpt_plan_type ?? null,
    accountId: auth.chatgpt_account_id ?? s.accountId ?? null, accessExp: typeof access.exp === 'number' ? access.exp * 1000 : null };
}

function codexSecretFrom(body: any, previous?: CodexSecret): CodexSecret {
  const idToken = body.id_token || previous?.idToken || '';
  const auth = jwtClaims(idToken)['https://api.openai.com/auth'] ?? {};
  return { idToken, accessToken: body.access_token, refreshToken: body.refresh_token || previous?.refreshToken || '',
    accountId: auth.chatgpt_account_id ?? previous?.accountId ?? '', planType: auth.chatgpt_plan_type ?? previous?.planType ?? null };
}

export async function codexRefresh(secret: CodexSecret): Promise<{ secret: CodexSecret; earliestRefreshAt: number | null }> {
  const r = await call(`${CODEX.issuer}/oauth/token`, { json: { client_id: CODEX.clientId, grant_type: 'refresh_token',
    refresh_token: secret.refreshToken, scope: 'openid profile email' } });
  if (r.status !== 200 || !r.body?.access_token) fail('Codex refresh', r);
  const earliest = r.body.earliest_refresh_at;
  const at = typeof earliest === 'number' ? (earliest > 1e12 ? earliest : earliest * 1000) : Date.parse(earliest ?? '');
  return { secret: codexSecretFrom(r.body, secret), earliestRefreshAt: Number.isFinite(at) ? at : null };
}

export async function codexUsage(s: CodexSecret): Promise<{ status: number; body: any; retryAfterMs: number | null }> {
  const r = await call(CODEX.usage, { headers: { Authorization: `Bearer ${s.accessToken}`, 'ChatGPT-Account-Id': s.accountId } });
  return { status: r.status, body: r.body, retryAfterMs: retryAfterMs(r.headers) };
}
