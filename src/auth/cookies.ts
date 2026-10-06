/**
 * Minimal `Cookie` header parsing and `Set-Cookie` serialisation.
 *
 * Node ships no cookie helpers, and pulling a package in for this would be the
 * only runtime dependency in the project — for two functions.
 *
 * Security defaults, applied by {@link serializeSessionCookie}:
 *
 *   * `HttpOnly` — the session cookie is unreadable from JavaScript, so an XSS
 *     bug cannot exfiltrate it (which is exactly why the console no longer keeps
 *     a long-lived credential in `localStorage`).
 *   * `SameSite=Strict` — a cross-site form post cannot ride along on the
 *     session, which is what makes `POST /admin/api/*` safe without a separate
 *     CSRF token.
 *   * `Path=/` — the console and its API live under `/admin`, the log stream and
 *     `/v1` do not share a parent below the root.
 *   * `Secure` — set whenever the request arrived over HTTPS (or when the
 *     operator forces it), so the cookie is never sent in clear text.
 */

export interface CookieOptions {
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  secure?: boolean;
}

/** Parses a `Cookie` request header into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (typeof header !== 'string' || header === '') return jar;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name === '') continue;
    let value = part.slice(index + 1).trim();
    // A quoted value may itself contain '='; strip the quotes only.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // First occurrence wins, mirroring how browsers resolve duplicates.
    if (!(name in jar)) jar[name] = value;
  }
  return jar;
}

/** Reads a single cookie, or an empty string when it is absent. */
export function readCookie(header: string | undefined, name: string): string {
  return parseCookies(header)[name] ?? '';
}

/** Serialises one `Set-Cookie` value. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Serialises the cookie that clears a session (`Max-Age=0`). */
export function serializeClearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
}

/**
 * Whether the request reached us over HTTPS.
 *
 * Nami is usually deployed behind a reverse proxy, which terminates TLS and
 * forwards plain HTTP to us, so the socket alone is not authoritative. Only
 * `X-Forwarded-Proto` is consulted — and only when the proxy is trusted
 * (`NAMI_TRUST_PROXY`), because any client can set that header otherwise, and a
 * forged value would silently change how the cookie is issued.
 */
export function isSecureRequest(
  headers: Record<string, string | string[] | undefined>,
  options: { trustProxy: boolean },
): boolean {
  if (options.trustProxy) {
    const forwarded = headers['x-forwarded-proto'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof value === 'string' && value.split(',')[0]?.trim().toLowerCase() === 'https') {
      return true;
    }
  }
  return false;
}
