/**
 * Response helpers: JSON/text writers, CORS, and the typed HTTP error used to
 * abort a request from anywhere in a handler.
 */

import type { ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? defaultCode(status);
    if (details !== undefined) this.details = details;
  }
}

function defaultCode(status: number): string {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 415) return 'unsupported_media_type';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  return 'error';
}

/** Writes a JSON response and returns the number of body bytes sent. */
export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): number {
  const body = JSON.stringify(payload ?? null);
  const bytes = Buffer.byteLength(body);
  if (!res.headersSent) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes),
      ...extraHeaders,
    });
  }
  res.end(body);
  return bytes;
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
  extraHeaders: Record<string, string> = {},
): number {
  const bytes = Buffer.byteLength(body);
  if (!res.headersSent) {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(bytes),
      ...extraHeaders,
    });
  }
  res.end(body);
  return bytes;
}

export interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
    request_id?: string;
    details?: unknown;
  };
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  options: { code?: string; requestId?: string; details?: unknown } = {},
): number {
  const payload: ErrorBody = {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code: options.code ?? defaultCode(status),
    },
  };
  if (options.requestId) payload.error.request_id = options.requestId;
  if (options.details !== undefined) payload.error.details = options.details;
  return sendJson(res, status, payload);
}

export function applyCors(
  res: ServerResponse,
  requestOrigin: string | undefined,
  allowOrigin: string,
): void {
  const origin = allowOrigin === '*' ? '*' : allowOrigin;
  res.setHeader('access-control-allow-origin', origin);
  if (origin !== '*') res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,x-request-id,x-admin-token',
  );
  res.setHeader('access-control-expose-headers', 'x-request-id,x-ratelimit-remaining');
  res.setHeader('access-control-max-age', '600');
  if (requestOrigin === undefined) return;
}
