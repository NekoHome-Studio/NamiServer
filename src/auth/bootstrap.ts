/**
 * First-boot console account.
 *
 * A freshly started Nami has no accounts, so someone has to create the first
 * one. Two rules shape how that happens:
 *
 *   1. **The database is authoritative once it has a user.** `NAMI_ADMIN_USER` /
 *      `NAMI_ADMIN_PASSWORD` are read only while the `users` table is empty.
 *      Otherwise deleting the variable (or changing it) would silently create or
 *      rewrite an account, which is a back door with a friendly name.
 *   2. **A fresh install never comes up with a guessable default.** If no
 *      password was supplied, Nami invents a strong one and prints it once. If a
 *      supplied password fails the policy, Nami says so and *still* starts with a
 *      generated password rather than leaving the console unreachable.
 */

import { randomBytes } from 'node:crypto';
import type { ConsoleAccountSeed } from '../app.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordPolicyError, assertPasswordAcceptable, hashPassword } from './passwords.ts';
import { UsernamePolicyError, assertUsernameAcceptable, normaliseUsername } from './users.ts';
import type { SessionStore } from '../store/store.ts';

/** Characters used for a generated password: unambiguous ones only. */
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GENERATED_PASSWORD_LENGTH = 24;

/** Cryptographically random password from an alphabet without look-alikes. */
function generatePassword(): string {
  const bytes = randomBytes(GENERATED_PASSWORD_LENGTH);
  let out = '';
  for (const byte of bytes) {
    out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  }
  return out;
}

/**
 * Ensures at least one console account exists.
 *
 * @returns what happened, for the startup banner. Safe to call on every boot.
 */
export async function seedConsoleAccount(
  config: Config,
  store: SessionStore,
  log: Logger,
): Promise<ConsoleAccountSeed> {
  if (store.countUsers() > 0) {
    // Keep the environment honest: someone who sets these later should not be
    // left believing they took effect.
    if (config.auth.bootstrapPassword !== '') {
      log.warn('NAMI_ADMIN_PASSWORD ignored: accounts already exist', {
        hint: 'change a password in the console, or run `npm run passwd`',
      });
    }
    return { created: false, username: '', generatedPassword: null, rejectedReason: null };
  }

  let username = normaliseUsername(config.auth.bootstrapUser);
  let rejectedReason: string | null = null;

  try {
    assertUsernameAcceptable(username);
  } catch (error) {
    rejectedReason = error instanceof UsernamePolicyError ? error.message : String(error);
    log.error('NAMI_ADMIN_USER is not usable; falling back to "admin"', {
      value: config.auth.bootstrapUser,
      reason: rejectedReason,
    });
    username = 'admin';
  }

  let password = config.auth.bootstrapPassword;
  let generatedPassword: string | null = null;

  if (password === '') {
    password = generatePassword();
    generatedPassword = password;
  } else {
    try {
      assertPasswordAcceptable(password);
    } catch (error) {
      rejectedReason = error instanceof PasswordPolicyError ? error.message : String(error);
      log.error('NAMI_ADMIN_PASSWORD does not meet the password policy; generating one instead', {
        reason: rejectedReason,
        minimumLength: MIN_PASSWORD_LENGTH,
        maximumLength: MAX_PASSWORD_LENGTH,
      });
      password = generatePassword();
      generatedPassword = password;
    }
  }

  store.createUser({ username, passwordHash: await hashPassword(password), isAdmin: true });
  log.info('created the first console account', { username });

  return { created: true, username, generatedPassword, rejectedReason };
}
