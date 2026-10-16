/**
 * Console account authentication.
 *
 *   POST   /admin/api/auth/login          username + password → session cookie
 *   POST   /admin/api/auth/logout         revoke the session and clear the cookie
 *   GET    /admin/api/auth/me             who am I (never fails; `authenticated: false`)
 *   POST   /admin/api/auth/password       change your own password
 *   GET    /admin/api/users               list accounts
 *   POST   /admin/api/users               create an account
 *   PUT    /admin/api/users/:id           enable/disable, promote/demote
 *   DELETE /admin/api/users/:id           delete an account
 *   POST   /admin/api/users/:id/password  reset someone else's password
 *
 * Design notes that matter:
 *
 *   * **The session cookie is the only credential the browser keeps.** It is
 *     HttpOnly, so an XSS bug cannot read it, and SameSite=Strict, so a
 *     cross-site form post cannot ride along on it. That is also why none of
 *     these endpoints need a separate CSRF token.
 *   * **Login failures are counted in the database**, per username *and* per
 *     client address. Keying only by username would let anyone lock a known
 *     account out at will; keying only by address would let a botnet spread its
 *     guesses. Persisting the counters means a restart is not a reset.
 *   * **A wrong password and an unknown user are indistinguishable** — same
 *     status, same message, and the same amount of work (see
 *     `burnVerificationTime`), so neither the body nor the latency enumerates
 *     accounts.
 *   * **Changing a password revokes every existing session** for that account,
 *     which is what makes "I think someone else has my password" actionable.
 */

import type { AppDeps } from '../app.ts';
import {
  isSecureRequest,
  readCookie,
  serializeClearCookie,
  serializeCookie,
  type CookieOptions,
} from '../auth/cookies.ts';
import {
  PasswordPolicyError,
  assertPasswordAcceptable,
  burnVerificationTime,
  hashPassword,
  verifyPassword,
} from '../auth/passwords.ts';
import { hashSessionToken, newSessionToken } from '../auth/tokens.ts';
import {
  UsernamePolicyError,
  assertUsernameAcceptable,
  normaliseUsername,
  toPublicUser,
} from '../auth/users.ts';
import type { PublicUser, UserRecord } from '../core/types.ts';
import { asObject } from '../http/body.ts';
import type { Router } from '../http/router.ts';
import { HttpError, sendJson } from '../http/response.ts';
import type { RequestContext } from '../http/types.ts';

/** Failure counters live under these two scopes. */
const SCOPE_USER = 'user';
const SCOPE_ADDRESS = 'ip';

/**
 * Client address used for the per-address lockout.
 *
 * `X-Forwarded-For` is only consulted when the operator declared a trusted
 * proxy; otherwise any client could rotate that header to get unlimited
 * attempts.
 */
function clientAddress(ctx: RequestContext, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = ctx.req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  return ctx.req.socket.remoteAddress ?? 'unknown';
}

/** Reads a required, non-empty string field out of a JSON body. */
function requireString(body: Record<string, unknown>, field: string, label: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(400, `${label}不能为空。`, 'invalid_request');
  }
  return value;
}

/** Runs a policy check and converts its error into a 400. */
function checkPolicy(action: () => void, code: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof PasswordPolicyError || error instanceof UsernamePolicyError) {
      throw new HttpError(400, error.message, code);
    }
    throw error;
  }
}

export function registerAuthRoutes(router: Router, deps: AppDeps): void {
  const { config, store, log } = deps;
  const auth = config.auth;

  /** Whether an issued cookie should carry `Secure`. */
  const secureCookie = (ctx: RequestContext): boolean => {
    if (auth.cookieSecure === 'always') return true;
    if (auth.cookieSecure === 'never') return false;
    return isSecureRequest(ctx.req.headers, { trustProxy: auth.trustProxy });
  };

  const cookieOptions = (ctx: RequestContext): CookieOptions => ({
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: secureCookie(ctx),
  });

  /** Creates the session row and attaches the cookie to the response. */
  const issueSession = (ctx: RequestContext, user: UserRecord): number => {
    const { token, hash } = newSessionToken();
    const session = store.createAuthSession({
      tokenHash: hash,
      userId: user.id,
      ttlMs: auth.sessionTtlMs,
      userAgent:
        typeof ctx.req.headers['user-agent'] === 'string' ? ctx.req.headers['user-agent'] : null,
      ip: clientAddress(ctx, auth.trustProxy),
    });
    ctx.res.setHeader(
      'set-cookie',
      serializeCookie(auth.cookieName, token, {
        ...cookieOptions(ctx),
        maxAgeSeconds: Math.floor(auth.sessionTtlMs / 1000),
      }),
    );
    return session.expiresAt;
  };

  /** The lockout deadline from either scope, or null when not locked. */
  const lockedUntil = (username: string, address: string): number | null => {
    const now = Date.now();
    for (const [scope, subject] of [
      [SCOPE_USER, username],
      [SCOPE_ADDRESS, address],
    ] as const) {
      const locked = store.readLoginAttempt(scope, subject)?.lockedUntil ?? null;
      if (locked !== null && locked > now) return locked;
    }
    return null;
  };

  const recordFailure = (username: string, address: string): void => {
    const options = {
      windowMs: auth.attemptWindowMs,
      maxAttempts: auth.maxAttempts,
      lockoutMs: auth.lockoutMs,
    };
    store.recordLoginFailure(SCOPE_USER, username, options);
    store.recordLoginFailure(SCOPE_ADDRESS, address, options);
  };

  /* ------------------------------- login ------------------------------- */

  router.post('/admin/api/auth/login', async (ctx) => {
    const body = asObject(ctx.body);
    const username = normaliseUsername(typeof body.username === 'string' ? body.username : '');
    const password = typeof body.password === 'string' ? body.password : '';
    const address = clientAddress(ctx, auth.trustProxy);

    if (username === '' || password === '') {
      throw new HttpError(400, '用户名和密码都必须填写。', 'invalid_request');
    }

    const locked = lockedUntil(username, address);
    if (locked !== null) {
      const retryAfter = Math.max(1, Math.ceil((locked - Date.now()) / 1000));
      ctx.res.setHeader('retry-after', String(retryAfter));
      throw new HttpError(429, `登录失败次数过多，请在 ${retryAfter} 秒后重试。`, 'login_locked');
    }

    const user = store.findUserByUsername(username);
    const passwordOk =
      user !== null && !user.disabled
        ? await verifyPassword(password, user.passwordHash)
        : await burnVerificationTime().then(() => false);

    if (user === null || user.disabled || !passwordOk) {
      recordFailure(username, address);
      log.warn('console login failed', {
        username,
        address,
        reason: user === null ? 'unknown-user' : user.disabled ? 'disabled' : 'bad-password',
      });
      throw new HttpError(401, '用户名或密码不正确。', 'invalid_credentials');
    }

    store.clearLoginAttempts(SCOPE_USER, username);
    store.clearLoginAttempts(SCOPE_ADDRESS, address);
    store.touchUserLogin(user.id);

    const expiresAt = issueSession(ctx, user);
    log.info('console login', { username: user.username, userId: user.id, address });

    sendJson(ctx.res, 200, {
      object: 'auth.session',
      user: toPublicUser(user),
      expiresAt,
    });
  });

  /* ------------------------------- logout ------------------------------- */

  router.post('/admin/api/auth/logout', (ctx) => {
    const token = readCookie(ctx.req.headers.cookie, auth.cookieName);
    const revoked = token === '' ? false : store.deleteAuthSession(hashSessionToken(token));
    ctx.res.setHeader('set-cookie', serializeClearCookie(auth.cookieName, cookieOptions(ctx)));
    if (revoked && ctx.auth.user) log.info('console logout', { username: ctx.auth.user.username });
    sendJson(ctx.res, 200, { object: 'auth.logout', loggedOut: true, revoked });
  });

  /* --------------------------------- me --------------------------------- */

  /**
   * Always 200.
   *
   * The console calls this on boot to choose between the login page and the
   * dashboard. A 401 here would be indistinguishable from "your credential was
   * rejected" and would raise a spurious warning, so "no session" is a normal
   * answer rather than an error.
   */
  router.get('/admin/api/auth/me', (ctx) => {
    const caller = ctx.auth.user;
    const keyAuthenticated = caller === undefined && ctx.auth.key !== 'anonymous' && ctx.auth.key !== '';
    const record = caller ? store.findUserById(caller.id) : null;

    sendJson(ctx.res, 200, {
      object: 'auth.me',
      authenticated: caller !== undefined,
      user: record ? toPublicUser(record) : null,
      via: ctx.auth.via,
      // An API key or admin token is authorized but has no account behind it.
      keyAuthenticated,
      users: store.countUsers(),
    });
  });

  /* --------------------------- change password --------------------------- */

  router.post('/admin/api/auth/password', async (ctx) => {
    const caller = ctx.auth.user;
    if (!caller) {
      throw new HttpError(
        403,
        '修改密码需要以账号登录（Cookie 会话）；API Key / Admin Token 没有对应的账号。',
        'session_required',
      );
    }

    const body = asObject(ctx.body);
    const currentPassword = requireString(body, 'currentPassword', '当前密码');
    const newPassword = requireString(body, 'newPassword', '新密码');

    const user = store.findUserById(caller.id);
    if (!user) throw new HttpError(401, '账号不存在。', 'invalid_credentials');

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new HttpError(401, '当前密码不正确。', 'invalid_password');
    }
    checkPolicy(() => assertPasswordAcceptable(newPassword), 'weak_password');
    if (newPassword === currentPassword) {
      throw new HttpError(400, '新密码不能与当前密码相同。', 'password_unchanged');
    }

    store.setUserPassword(user.id, await hashPassword(newPassword));

    /*
     * Every existing session is dropped — this is the action an operator takes
     * when they suspect someone else has the password, so it has to end that
     * access. The caller gets a fresh session so the device in their hand stays
     * signed in.
     */
    const revoked = store.deleteUserAuthSessions(user.id);
    const refreshed = store.findUserById(user.id);
    if (refreshed) issueSession(ctx, refreshed);
    log.info('console password changed', { username: user.username, revokedSessions: revoked });

    sendJson(ctx.res, 200, { object: 'auth.password', changed: true, revokedSessions: revoked });
  });

  /* -------------------------- account management -------------------------- */

  const requireUser = (id: string): UserRecord => {
    const user = store.findUserById(id);
    if (!user) throw new HttpError(404, '账号不存在。', 'user_not_found');
    return user;
  };

  /** Refuses an edit that would remove the last usable administrator. */
  const guardLastAdmin = (action: string): void => {
    if (store.countActiveAdmins() <= 1) {
      throw new HttpError(409, `不能${action}最后一个可用的管理员账号。`, 'last_admin');
    }
  };

  router.get('/admin/api/users', (ctx) => {
    const users: PublicUser[] = store.listUsers().map(toPublicUser);
    sendJson(ctx.res, 200, {
      object: 'list',
      data: users,
      sessions: store.countAuthSessions(),
      caller: ctx.auth.user?.id ?? null,
    });
  });

  router.post('/admin/api/users', async (ctx) => {
    const body = asObject(ctx.body);
    const username = normaliseUsername(requireString(body, 'username', '用户名'));
    const password = requireString(body, 'password', '密码');
    const isAdmin = body.isAdmin === undefined ? true : body.isAdmin === true;

    checkPolicy(() => {
      assertUsernameAcceptable(username);
      assertPasswordAcceptable(password);
    }, 'invalid_user');

    if (store.findUserByUsername(username)) {
      throw new HttpError(409, '该用户名已存在。', 'username_taken');
    }

    let created: UserRecord;
    try {
      created = store.createUser({ username, passwordHash: await hashPassword(password), isAdmin });
    } catch (error) {
      // The UNIQUE index is the real arbiter: two concurrent creates can both
      // pass the check above, and this is what makes the second one fail cleanly.
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new HttpError(409, '该用户名已存在。', 'username_taken');
      }
      throw error;
    }

    log.info('console user created', { username: created.username, isAdmin });
    sendJson(ctx.res, 201, { object: 'user', user: toPublicUser(created) });
  });

  router.put('/admin/api/users/:id', (ctx) => {
    const target = requireUser(ctx.params.id ?? '');
    const body = asObject(ctx.body);

    const disabled = typeof body.disabled === 'boolean' ? body.disabled : target.disabled;
    const isAdmin = typeof body.isAdmin === 'boolean' ? body.isAdmin : target.isAdmin;

    if (disabled === target.disabled && isAdmin === target.isAdmin) {
      throw new HttpError(400, '没有需要修改的字段（disabled 或 isAdmin）。', 'no_changes');
    }
    if (ctx.auth.user?.id === target.id && disabled) {
      throw new HttpError(409, '不能停用当前登录的账号。', 'cannot_disable_self');
    }
    // Only an edit that actually removes a working admin is restricted.
    if (target.isAdmin && !target.disabled && (disabled || !isAdmin)) {
      guardLastAdmin(disabled ? '停用' : '降级');
    }

    store.setUserDisabled(target.id, disabled);
    store.setUserAdmin(target.id, isAdmin);

    const updated = requireUser(target.id);
    log.info('console user updated', {
      username: updated.username,
      disabled: updated.disabled,
      isAdmin: updated.isAdmin,
    });
    sendJson(ctx.res, 200, { object: 'user', user: toPublicUser(updated) });
  });

  router.delete('/admin/api/users/:id', (ctx) => {
    const target = requireUser(ctx.params.id ?? '');
    if (ctx.auth.user?.id === target.id) {
      throw new HttpError(409, '不能删除当前登录的账号。', 'cannot_delete_self');
    }
    if (target.isAdmin && !target.disabled) guardLastAdmin('删除');

    // auth_sessions rows cascade with the user, so their logins end immediately.
    store.deleteUser(target.id);
    log.info('console user deleted', { username: target.username });
    sendJson(ctx.res, 200, { object: 'user', deleted: true, id: target.id });
  });

  router.post('/admin/api/users/:id/password', async (ctx) => {
    const target = requireUser(ctx.params.id ?? '');
    const body = asObject(ctx.body);
    const password = requireString(body, 'password', '新密码');

    checkPolicy(() => assertPasswordAcceptable(password), 'weak_password');

    store.setUserPassword(target.id, await hashPassword(password));
    // The owner must sign in again with the new password.
    const revoked = store.deleteUserAuthSessions(target.id);
    log.info('console password reset by admin', {
      username: target.username,
      revokedSessions: revoked,
    });

    sendJson(ctx.res, 200, {
      object: 'auth.password',
      changed: true,
      revokedSessions: revoked,
      user: toPublicUser(requireUser(target.id)),
    });
  });
}
