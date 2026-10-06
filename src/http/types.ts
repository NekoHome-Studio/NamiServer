/**
 * Request-scoped types shared by the router and every route module.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../logger.ts';

export type AuthVia = 'bearer' | 'admin-token' | 'query' | 'session' | 'none';

export interface AuthInfo {
  /** API key that authenticated the request, or `anonymous`. */
  key: string;
  via: AuthVia;
  /** True when the caller presented a valid admin token. */
  isAdmin: boolean;
  /**
   * Set only for cookie-authenticated console sessions.
   *
   * Present so a route can answer "who am I" without re-reading the session row,
   * and so `maskKey` has something better than a token hash to log.
   */
  user?: {
    id: string;
    username: string;
    isAdmin: boolean;
    /** Hash of the session token, needed to revoke exactly this session. */
    sessionTokenHash: string;
  };
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Path parameters extracted from the matched route pattern. */
  params: Record<string, string>;
  /** Pattern that matched, e.g. `/v1/sessions/:id`. */
  route: string;
  /** Parsed JSON body, or `undefined` when there was none. */
  body: unknown;
  rawBody: string;
  requestId: string;
  auth: AuthInfo;
  log: Logger;
}

export type RouteHandler = (context: RequestContext) => Promise<void> | void;
