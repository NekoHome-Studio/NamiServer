/**
 * API key authentication.
 *
 * Keys are compared in constant time. Query-string credentials are accepted
 * only where explicitly allowed (the WebSocket handshake, where browsers cannot
 * set headers), keeping keys out of ordinary access logs.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config.ts';
import type { AuthInfo, AuthVia } from './types.ts';
import { HttpError } from './response.ts';
import { readCookie } from '../auth/cookies.ts';

interface Credential {
  value: string;
  via: AuthVia;
}

/**
 * A cookie session that the caller has already validated.
 *
 * Deliberately a plain callback rather than the store itself: this module stays
 * about *credentials*, and the store is what knows how to map a token hash to a
 * live, unexpired session.
 */
export interface SessionResolution {
  user: { id: string; username: string; isAdmin: boolean };
  /** Hash of the presented token, so a route can revoke this exact session. */
  sessionTokenHash: string;
}

export interface AuthOptions {
  /** Accept `?key=`. Only for endpoints a browser reaches with `EventSource`. */
  allowQuery?: boolean;
  /** Validates a session cookie. When absent, cookie auth is unavailable. */
  resolveSession?: (token: string) => SessionResolution | null;
  cookieName?: string;
}

/** Length-independent, constant-time string comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so the timing does not leak the length.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function readCredentials(
  req: IncomingMessage,
  url: URL,
  allowQuery: boolean,
): Credential[] {
  const found: Credential[] = [];

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) found.push({ value: match[1].trim(), via: 'bearer' });
  }

  const adminHeader = req.headers['x-admin-token'];
  if (typeof adminHeader === 'string' && adminHeader.trim() !== '') {
    found.push({ value: adminHeader.trim(), via: 'admin-token' });
  }

  if (allowQuery) {
    const query = url.searchParams.get('key') ?? url.searchParams.get('api_key');
    if (query && query.trim() !== '') found.push({ value: query.trim(), via: 'query' });
  }

  return found;
}

function classify(config: Config, credential: Credential): AuthInfo | null {
  if (config.adminToken && constantTimeEqual(credential.value, config.adminToken)) {
    return { key: 'admin', via: credential.via, isAdmin: true };
  }
  for (const key of config.apiKeys) {
    if (constantTimeEqual(credential.value, key)) {
      return { key, via: credential.via, isAdmin: false };
    }
  }
  return null;
}

/**
 * Authenticates a `/v1/*` request.
 *
 * A console session is accepted as well as an API key. The WebUI is a
 * first-party client of this surface — the chat page streams
 * `POST /v1/agent/run`, and the models page reads `/v1/models` — so a signed-in
 * operator would otherwise hit a 401 on their own console. The session cookie is
 * `SameSite=Strict`, so accepting it here does not open a CSRF hole.
 *
 * @throws {HttpError} 401 when the credential is missing, unknown, or when an
 * admin token is presented as an API key.
 */
export function authenticate(
  config: Config,
  req: IncomingMessage,
  url: URL,
  options: AuthOptions = {},
): AuthInfo {
  const session = readSessionAuth(req, options);
  if (session) return session;

  const credentials = readCredentials(req, url, options.allowQuery ?? false);
  if (credentials.length === 0) {
    throw new HttpError(
      401,
      'Missing API key. Send "Authorization: Bearer <key>", or sign in to the console.',
      'missing_api_key',
    );
  }
  for (const credential of credentials) {
    const auth = classify(config, credential);
    if (auth) return auth;
  }
  throw new HttpError(401, 'Invalid API key.', 'invalid_api_key');
}

/**
 * Resolves a console session from the request cookie.
 *
 * Checked before API keys on purpose: a valid session means the operator proved
 * a password, so it must keep working even when `NAMI_ADMIN_TOKEN` is set (which
 * deliberately rejects plain API keys). It also means the WebUI no longer needs
 * to keep a long-lived key in `localStorage`.
 */
function readSessionAuth(req: IncomingMessage, options: AuthOptions): AuthInfo | null {
  const resolve = options.resolveSession;
  if (!resolve) return null;

  const token = readCookie(req.headers.cookie, options.cookieName ?? 'nami_session');
  if (token === '') return null;

  const found = resolve(token);
  if (!found) return null;

  return {
    // Prefixed so the logger can tell a username from a secret and skip masking.
    key: `user:${found.user.username}`,
    via: 'session',
    isAdmin: found.user.isAdmin,
    user: { ...found.user, sessionTokenHash: found.sessionTokenHash },
  };
}

/**
 * Tries every accepted credential, returning null instead of throwing.
 *
 * Shared by {@link authenticateAdmin} (which turns null into a 401/403) and
 * {@link authenticateOptional} (which does not).
 */
function tryAuthenticateAdmin(
  config: Config,
  req: IncomingMessage,
  url: URL,
  options: AuthOptions,
): AuthInfo | null {
  const session = readSessionAuth(req, options);
  if (session) return session;

  const credentials = readCredentials(req, url, options.allowQuery ?? false);
  if (credentials.length === 0) return null;

  if (config.adminToken) {
    const match = credentials.find((credential) =>
      constantTimeEqual(credential.value, config.adminToken as string),
    );
    // Anything other than the admin token is simply "not authorized" here; the
    // caller decides whether that is an error.
    return match ? { key: 'admin', via: match.via, isAdmin: true } : null;
  }

  for (const credential of credentials) {
    const auth = classify(config, credential);
    if (auth) return { ...auth, isAdmin: true };
  }
  return null;
}

/**
 * Authenticates an `/admin/api/*` request.
 *
 * Every credential presented is considered, not just the first one. The web
 * panel deliberately sends both `Authorization` and `X-Admin-Token` so that one
 * build works whether or not the server has an admin token configured; if only
 * the first header were inspected, the panel would be rejected as soon as an
 * admin token existed.
 *
 * A cookie session is accepted first (see {@link readSessionAuth}); credentials
 * then behave exactly as before.
 *
 * @param options.allowQuery Accept `?key=`. Only for endpoints a browser must
 *   reach with `EventSource`, which cannot set request headers. Everywhere else
 *   a query credential is refused so keys cannot leak into access logs.
 */
export function authenticateAdmin(
  config: Config,
  req: IncomingMessage,
  url: URL,
  options: AuthOptions = {},
): AuthInfo {
  const auth = tryAuthenticateAdmin(config, req, url, options);
  if (auth) return auth;

  const credentials = readCredentials(req, url, options.allowQuery ?? false);
  if (credentials.length === 0) {
    throw new HttpError(
      401,
      'Missing credentials. Log in, or send "Authorization: Bearer <key>" / "X-Admin-Token: <token>".',
      'missing_api_key',
    );
  }
  if (config.adminToken) {
    // The caller presented *something*, but not the admin token.
    throw new HttpError(403, 'This endpoint requires the admin token.', 'admin_required');
  }
  throw new HttpError(401, 'Invalid API key.', 'invalid_api_key');
}

/**
 * Best-effort authentication for endpoints that work either way.
 *
 * Used by the login endpoints: `/me` has to report *who* the caller is, which is
 * only possible if the session is resolved even though a missing session must
 * not be an error. Returning `anonymous` here is what lets `/me` answer
 * `authenticated: false` with a 200 instead of a 401 the console would have to
 * special-case.
 */
export function authenticateOptional(
  config: Config,
  req: IncomingMessage,
  url: URL,
  options: AuthOptions = {},
): AuthInfo {
  return (
    tryAuthenticateAdmin(config, req, url, options) ?? {
      key: 'anonymous',
      via: 'none',
      isAdmin: false,
    }
  );
}

/**
 * Masks a key for logging: `nami_abcd…wxyz`.
 *
 * Session keys (`user:<name>`) pass through unmasked — an account name is not a
 * secret, and knowing who made a change is the whole point of logging it.
 */
export function maskKey(key: string): string {
  if (key === 'admin' || key === 'anonymous') return key;
  if (key.startsWith('user:')) return key;
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
