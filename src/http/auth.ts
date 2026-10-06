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

interface Credential {
  value: string;
  via: AuthVia;
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
 * @throws {HttpError} 401 when the credential is missing, unknown, or when an
 * admin token is presented as an API key.
 */
export function authenticate(
  config: Config,
  req: IncomingMessage,
  url: URL,
  options: { allowQuery?: boolean } = {},
): AuthInfo {
  const credentials = readCredentials(req, url, options.allowQuery ?? false);
  if (credentials.length === 0) {
    throw new HttpError(
      401,
      'Missing API key. Send "Authorization: Bearer <key>".',
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
 * Authenticates an `/admin/api/*` request.
 *
 * Every credential presented is considered, not just the first one. The web
 * panel deliberately sends both `Authorization` and `X-Admin-Token` so that one
 * build works whether or not the server has an admin token configured; if only
 * the first header were inspected, the panel would be rejected as soon as an
 * admin token existed.
 *
 * @param options.allowQuery Accept `?key=`. Only for endpoints a browser must
 *   reach with `EventSource`, which cannot set request headers. Everywhere else
 *   a query credential is refused so keys cannot leak into access logs.
 */
export function authenticateAdmin(
  config: Config,
  req: IncomingMessage,
  url: URL,
  options: { allowQuery?: boolean } = {},
): AuthInfo {
  const credentials = readCredentials(req, url, options.allowQuery ?? false);
  if (credentials.length === 0) {
    throw new HttpError(
      401,
      'Missing credentials. Send "Authorization: Bearer <key>" or "X-Admin-Token: <token>".',
      'missing_api_key',
    );
  }

  if (config.adminToken) {
    const match = credentials.find((credential) =>
      constantTimeEqual(credential.value, config.adminToken as string),
    );
    if (match) return { key: 'admin', via: match.via, isAdmin: true };
    throw new HttpError(403, 'This endpoint requires the admin token.', 'admin_required');
  }

  for (const credential of credentials) {
    const auth = classify(config, credential);
    if (auth) return { ...auth, isAdmin: true };
  }
  throw new HttpError(401, 'Invalid API key.', 'invalid_api_key');
}

/** Masks a key for logging: `nami_abcd…wxyz`. */
export function maskKey(key: string): string {
  if (key === 'admin' || key === 'anonymous') return key;
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
