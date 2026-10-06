/**
 * A ~1KB path router.
 *
 * Patterns are slash-separated with `:name` placeholders, e.g.
 * `/v1/sessions/:id/messages`. Matching is exact on segment count, so a route
 * never accidentally swallows a deeper path.
 */

import type { RouteHandler } from './types.ts';

export interface MatchResult {
  handler: RouteHandler;
  params: Record<string, string>;
  pattern: string;
}

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    const normalised = pattern.startsWith('/') ? pattern : `/${pattern}`;
    this.routes.push({
      method: method.toUpperCase(),
      pattern: normalised,
      segments: splitPath(normalised),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Finds a handler for the method+path, or reports that only other methods match. */
  match(method: string, pathname: string): MatchResult | { methodMismatch: string[] } | null {
    const parts = splitPath(pathname);
    const allowed = new Set<string>();
    let sawPathMatch = false;

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index] as string;
        const value = parts[index] as string;
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      sawPathMatch = true;
      if (route.method === method.toUpperCase() || route.method === 'ALL') {
        return { handler: route.handler, params, pattern: route.pattern };
      }
      allowed.add(route.method);
    }

    if (sawPathMatch) return { methodMismatch: [...allowed].sort() };
    return null;
  }

  get size(): number {
    return this.routes.length;
  }

  /** Registered routes, for diagnostics. */
  describe(): Array<{ method: string; pattern: string }> {
    return this.routes.map((route) => ({ method: route.method, pattern: route.pattern }));
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}
