/**
 * Session token generation and storage form.
 *
 * The token handed to the browser is 32 random bytes; the database stores only
 * its SHA-256. That way a leaked database (or a stray backup) does not contain
 * credentials that can be replayed as a live session — the same reasoning that
 * applies to storing password hashes rather than passwords.
 *
 * SHA-256 without a salt/stretching is the right primitive here, unlike for
 * passwords: the input is 256 bits of entropy we generated ourselves, so there
 * is nothing to brute-force.
 */

import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

export interface SessionToken {
  /** The value that goes into the cookie. Never stored. */
  token: string;
  /** What actually goes into the database. */
  hash: string;
}

/** Mints a new session token and the hash to persist alongside it. */
export function newSessionToken(): SessionToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

/** Hashes a presented token into its stored form. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
