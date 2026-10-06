/**
 * Request body reading with a hard size cap.
 */

import type { IncomingMessage } from 'node:http';
import { HttpError } from './response.ts';

/**
 * Reads the whole request body as UTF-8 text.
 *
 * @throws {HttpError} 413 when the cap is exceeded, 415 for an encoding we do
 * not decode. The connection is destroyed in both cases, since the remaining
 * bytes are unread.
 */
export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding && encoding !== 'identity') {
    throw new HttpError(
      415,
      `content-encoding "${encoding}" is not supported; send an uncompressed body`,
      'unsupported_content_encoding',
    );
  }

  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `request body exceeds the ${maxBytes} byte limit`, 'payload_too_large');
  }

  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise<string>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new HttpError(413, `request body exceeds the ${maxBytes} byte limit`, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) {
        resolve('');
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => reject(error));
    req.on('aborted', () => reject(new HttpError(400, 'client aborted the request', 'client_aborted')));
  });
}

/** Parses a raw body as JSON. An empty body yields `undefined`. */
export function parseJsonBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new HttpError(
      400,
      `request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_json',
    );
  }
}

/** Reads and parses in one step. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes);
  return parseJsonBody(raw);
}

/** Narrows an unknown parsed body to an object, rejecting arrays and scalars. */
export function asObject(body: unknown, what = 'request body'): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, `${what} must be a JSON object`, 'invalid_body');
  }
  return body as Record<string, unknown>;
}
