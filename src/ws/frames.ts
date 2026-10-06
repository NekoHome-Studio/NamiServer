/**
 * RFC 6455 WebSocket frame codec and handshake helpers.
 *
 * Node ships a WebSocket *client* but no server, and Nami deliberately has zero
 * runtime dependencies, so the wire protocol is implemented here. Scope is
 * exactly what a JSON control channel needs: text frames, fragmentation,
 * ping/pong/close, and a payload cap.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/** RFC 6455 §4.2.2 connection upgrade GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocketProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode = 1002) {
    super(message);
    this.name = 'WebSocketProtocolError';
    this.closeCode = closeCode;
  }
}

/** Computes the `Sec-WebSocket-Accept` value for a client key. */
export function computeAcceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(clientKey + WS_GUID)
    .digest('base64');
}

/**
 * Validates the upgrade request and returns the 101 response, or an error
 * describing why the handshake must be refused.
 */
export function buildHandshake(
  req: IncomingMessage,
): { ok: true; response: string } | { ok: false; status: number; message: string } {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket') {
    return { ok: false, status: 400, message: 'Expected an Upgrade: websocket header' };
  }

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.trim() === '') {
    return { ok: false, status: 400, message: 'Missing Sec-WebSocket-Key' };
  }

  const version = String(req.headers['sec-websocket-version'] ?? '');
  if (version !== '13') {
    return { ok: false, status: 426, message: 'Only WebSocket protocol version 13 is supported' };
  }

  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${computeAcceptKey(key.trim())}`,
    '\r\n',
  ].join('\r\n');

  return { ok: true, response };
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

/** Builds a server-to-client frame (never masked, per RFC 6455 §5.1). */
export function encodeFrame(opcode: Opcode, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, payload], header.length + length);
}

/** Encodes a close frame body: 2-byte status code followed by a UTF-8 reason. */
export function encodeClosePayload(code: number, reason = ''): Buffer {
  // Control frame payloads are capped at 125 bytes by the RFC.
  const reasonBuffer = Buffer.from(reason.slice(0, 100), 'utf8');
  const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  return payload;
}

export function decodeClosePayload(payload: Buffer): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1005, reason: '' };
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString('utf8'),
  };
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

export interface RawFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/**
 * Incremental frame parser.
 *
 * `push` accepts arbitrary TCP chunks and returns every complete frame they
 * completed; partial frames stay buffered.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxPayload: number;

  constructor(maxPayload: number) {
    this.maxPayload = maxPayload;
  }

  push(chunk: Buffer): RawFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: RawFrame[] = [];

    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      frames.push(frame);
    }

    return frames;
  }

  private readFrame(): RawFrame | null {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;

    const byte0 = buffer[0] as number;
    const byte1 = buffer[1] as number;

    const fin = (byte0 & 0x80) !== 0;
    if ((byte0 & 0x70) !== 0) {
      throw new WebSocketProtocolError('RSV bits must be zero (no extension negotiated)');
    }
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let length = byte1 & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WebSocketProtocolError('frame length exceeds the supported range', 1009);
      }
      length = Number(big);
      offset = 10;
    }

    if (length > this.maxPayload) {
      throw new WebSocketProtocolError(
        `frame payload of ${length} bytes exceeds the ${this.maxPayload} byte limit`,
        1009,
      );
    }

    // Control frames must be short and unfragmented.
    const isControl = (opcode & 0x08) !== 0;
    if (isControl) {
      if (!fin) throw new WebSocketProtocolError('control frames must not be fragmented');
      if (length > 125) throw new WebSocketProtocolError('control frame payload must be <= 125 bytes');
    } else if (opcode !== OPCODE.CONTINUATION && opcode !== OPCODE.TEXT && opcode !== OPCODE.BINARY) {
      throw new WebSocketProtocolError(`unsupported opcode 0x${opcode.toString(16)}`);
    }

    // RFC 6455 §5.1: every client-to-server frame must be masked.
    if (!masked) throw new WebSocketProtocolError('client frames must be masked');

    if (buffer.length < offset + 4) return null;
    const maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;

    if (buffer.length < offset + length) return null;
    const payload = unmask(buffer.subarray(offset, offset + length), maskKey);
    this.buffer = buffer.subarray(offset + length);

    return { fin, opcode, payload };
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}

/** XORs a payload with the 4-byte masking key, returning a fresh buffer. */
export function unmask(payload: Buffer, maskKey: Buffer): Buffer {
  const output = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = (payload[index] as number) ^ (maskKey[index & 3] as number);
  }
  return output;
}
