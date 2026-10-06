/**
 * Outbound HTTP tool.
 *
 * Disabled by default, and even when enabled it requires an explicit host
 * allowlist. Redirects are followed manually so every hop is re-validated —
 * `fetch`'s automatic redirect following would happily leave the allowlist.
 */

import type { Config } from '../../config.ts';
import type { Tool } from '../types.ts';

const MAX_REDIRECTS = 3;

/** Matches `example.com`, `example.com:8443` and `*.example.com`. */
export function hostAllowed(url: URL, patterns: string[]): boolean {
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  return patterns.some((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase();
    if (pattern === '') return false;
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return pattern === host || pattern === hostname;
  });
}

function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid absolute URL (include http:// or https://)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`protocol "${url.protocol}" is not allowed; use http or https`);
  }
  return url;
}

export function createHttpGetTool(config: Config): Tool {
  const { httpAllowHosts, httpTimeoutMs, httpMaxBytes } = config.tools;

  return {
    name: 'http_get',
    description:
      'Fetch a URL with an HTTP GET request and return the response body as text. ' +
      'Only hosts on the server allowlist may be reached. Use this to read public ' +
      'web pages or call JSON APIs.',
    danger: 'caution',
    enabled: config.tools.httpEnabled && httpAllowHosts.length > 0,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to fetch.',
          minLength: 8,
          maxLength: 2048,
        },
        maxBytes: {
          type: 'integer',
          description: 'Optional cap on how many response bytes to read.',
          minimum: 256,
          maximum: Math.max(256, httpMaxBytes),
        },
      },
      required: ['url'],
      additionalProperties: false,
    },

    async run(args, context) {
      const limit = Math.min(Number(args.maxBytes ?? httpMaxBytes) || httpMaxBytes, httpMaxBytes);
      let url = parseTarget(String(args.url));
      let response: Response | null = null;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (!hostAllowed(url, httpAllowHosts)) {
          throw new Error(
            `host "${url.host}" is not on the allowlist (${httpAllowHosts.join(', ')})`,
          );
        }

        const signal = AbortSignal.any([
          context.signal,
          AbortSignal.timeout(httpTimeoutMs),
        ]);

        response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: {
            accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5',
            'user-agent': 'nami-agent-server/1.0 (+https://github.com/neko-nami)',
          },
        });

        const location = response.headers.get('location');
        const isRedirect = response.status >= 300 && response.status < 400 && location;
        if (!isRedirect) break;
        if (hop === MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);

        // Drain the redirect body so the socket can be reused.
        await response.body?.cancel().catch(() => {});
        url = parseTarget(new URL(location as string, url).toString());
        response = null;
      }

      if (!response) throw new Error('request failed without a response');

      const contentType = response.headers.get('content-type') ?? '';
      const { text, bytes, truncated } = await readCapped(response, limit);

      return {
        url: url.toString(),
        status: response.status,
        ok: response.ok,
        contentType,
        bytesRead: bytes,
        truncated,
        body: text,
      };
    },
  };
}

/** Streams the body, stopping once the byte budget is spent. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: '', bytes: 0, truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - bytes;
      if (value.byteLength >= remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        bytes += remaining;
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return { text, bytes, truncated };
}
