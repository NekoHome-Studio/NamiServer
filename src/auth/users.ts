/**
 * Username rules and the safe projection of a user row.
 *
 * Kept apart from `passwords.ts` because the two have different failure modes:
 * a bad password is a policy decision, a bad username is an identity decision,
 * and the routes report them differently.
 */

import type { PublicUser, UserRecord } from '../core/types.ts';

/**
 * Usernames are case-insensitive and normalised to lower case.
 *
 * Without this, `Admin` and `admin` are two rows that look identical in a UI and
 * in a log line — an easy way to end up with a second account nobody notices.
 */
export function normaliseUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Longest username accepted, mirroring the pattern above. */
export const MAX_USERNAME_LENGTH = 32;

/** Thrown with an operator-readable reason when a username is unusable. */
export class UsernamePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsernamePolicyError';
  }
}

/**
 * Validates an already-normalised username.
 *
 * @throws {UsernamePolicyError}
 */
export function assertUsernameAcceptable(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new UsernamePolicyError(
      '用户名只能是 3-32 个字符，由小写字母、数字、点、下划线或连字符组成，且以字母或数字开头。',
    );
  }
}

/** Strips the password hash before a user leaves the process. */
export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}
