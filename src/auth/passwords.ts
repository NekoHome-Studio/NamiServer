/**
 * Password hashing for the account/password login, built on Node's bundled
 * `scrypt`.
 *
 * Why scrypt and not something hand-rolled: it is memory-hard, it ships with
 * Node, and it keeps the project's "zero runtime dependencies" property intact.
 * The cost parameters below target roughly 50-100 ms on a normal machine, which
 * is slow enough to make offline guessing expensive and fast enough that a login
 * is not perceptibly delayed.
 *
 * The stored form is self-describing — `scrypt$N$r$p$<salt>$<hash>` — so the
 * parameters can be raised later without invalidating every existing password:
 * `verifyPassword` reads the cost out of the stored string rather than assuming
 * the current constants.
 *
 * Stored hashes are compared in constant time, and `hashPassword` never returns
 * anything that reveals the input.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Current cost parameters. Raise `N` (a power of two) to make hashing harder. */
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const ALGORITHM = 'scrypt';

/**
 * `maxmem` must exceed `128 * N * r` (16 MiB here) or Node refuses the call.
 * Doubling it leaves headroom for a future bump without a second magic number.
 */
const MAX_MEM = 32 * 1024 * 1024;

/** Shortest password the API will accept. */
export const MIN_PASSWORD_LENGTH = 10;

/** Longest password accepted, so a huge body cannot be turned into CPU burn. */
export const MAX_PASSWORD_LENGTH = 256;

/** Thrown with an operator-readable reason when a password fails the policy. */
export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * Enforces the password policy.
 *
 * Only length is enforced: composition rules ("one digit, one symbol") push
 * people towards predictable patterns and are no longer recommended, while a
 * long passphrase is what actually resists guessing.
 *
 * @throws {PasswordPolicyError}
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`密码最长 ${MAX_PASSWORD_LENGTH} 个字符。`);
  }
}

/** Unicode-normalises so the same typed password always hashes the same way. */
function normalise(password: string): string {
  return password.normalize('NFKC');
}

/** Hashes a password into the self-describing stored form. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(normalise(password), salt, KEY_BYTES, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });
  return [
    ALGORITHM,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false — rather than throwing — for a malformed or truncated stored
 * value, so a corrupted row denies access instead of producing a 500 that would
 * distinguish it from a wrong password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== ALGORITHM) return false;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 1 || r <= 0 || p <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltRaw, 'base64');
    expected = Buffer.from(hashRaw, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(normalise(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(MAX_MEM, 256 * N * r),
    });
  } catch {
    // Parameters that Node refuses are treated as a failed login, not a crash.
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Burns roughly the same time as a real verification.
 *
 * Called when the username does not exist, so "no such user" and "wrong
 * password" cannot be told apart by response time — otherwise an attacker could
 * enumerate valid usernames before spending a single guess on a password.
 */
export async function burnVerificationTime(): Promise<void> {
  await scrypt(normalise('nami-placeholder-password'), randomBytes(SALT_BYTES), KEY_BYTES, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });
}
