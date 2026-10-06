/**
 * A single WebSocket connection: framing lifecycle, fragmentation, control
 * frames, heartbeats and graceful close.
 */

import type { Socket } from 'node:net';
import {
  FrameParser,
  OPCODE,
  WebSocketProtocolError,
  decodeClosePayload,
  encodeClosePayload,
  encodeFrame,
} from './frames.ts';
import type { Opcode } from './frames.ts';

export interface ConnectionHandlers {
  onMessage?: (text: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
}

export interface ConnectionOptions {
  maxPayloadBytes: number;
  heartbeatMs: number;
}

export class WebSocketConnection {
  readonly remoteAddress: string;

  private readonly socket: Socket;
  private readonly parser: FrameParser;
  private readonly options: ConnectionOptions;

  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private fragmentBytes = 0;

  private closed = false;
  private closeFrameSent = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private awaitingPong = false;

  private handlers: ConnectionHandlers = {};

  constructor(socket: Socket, options: ConnectionOptions) {
    this.socket = socket;
    this.options = options;
    this.parser = new FrameParser(options.maxPayloadBytes);
    this.remoteAddress = socket.remoteAddress ?? 'unknown';

    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', (error: Error) => this.handleError(error));
    socket.on('close', () => this.finish(1006, 'socket closed'));

    if (options.heartbeatMs > 0) this.startHeartbeat();
  }

  on(handlers: ConnectionHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Feeds bytes that arrived in the same TCP packet as the HTTP upgrade.
   * Node hands those to the `upgrade` event as `head`, and they would otherwise
   * be dropped before the socket's own data listener is attached.
   */
  ingest(chunk: Buffer): void {
    if (chunk.length > 0) this.handleData(chunk);
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed && this.socket.writable;
  }

  /* ------------------------------ outbound ----------------------------- */

  send(data: string | Buffer, opcode: Opcode = OPCODE.TEXT): boolean {
    if (!this.isOpen) return false;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    try {
      return this.socket.write(encodeFrame(opcode, payload));
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  sendJson(value: unknown): boolean {
    return this.send(JSON.stringify(value ?? null));
  }

  ping(): void {
    if (!this.isOpen) return;
    try {
      this.socket.write(encodeFrame(OPCODE.PING, Buffer.alloc(0)));
    } catch {
      this.terminate();
    }
  }

  /** Sends a close frame and lets the peer reply before the socket ends. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    if (!this.closeFrameSent) {
      this.closeFrameSent = true;
      try {
        this.socket.write(encodeFrame(OPCODE.CLOSE, encodeClosePayload(code, reason)));
      } catch {
        /* fall through to teardown */
      }
    }
    // Give the peer a moment to complete the closing handshake.
    const timer = setTimeout(() => this.terminate(), 1000);
    timer.unref?.();
  }

  terminate(): void {
    if (this.closed) return;
    this.stopHeartbeat();
    this.socket.destroy();
    this.finish(1006, 'terminated');
  }

  /* ------------------------------ lifecycle ---------------------------- */

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (!this.isOpen) {
        this.stopHeartbeat();
        return;
      }
      if (this.awaitingPong) {
        // Peer missed a full interval: it is gone.
        this.terminate();
        return;
      }
      this.awaitingPong = true;
      this.ping();
    }, this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private handleData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (error) {
      if (error instanceof WebSocketProtocolError) {
        this.close(error.closeCode, error.message.slice(0, 100));
      } else {
        this.handleError(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE.TEXT:
        case OPCODE.BINARY:
          if (this.fragmentOpcode !== null) {
            this.close(1002, 'expected a continuation frame');
            return;
          }
          if (frame.fin) {
            this.deliver(frame.opcode, [frame.payload]);
          } else {
            this.fragmentOpcode = frame.opcode;
            this.fragments = [frame.payload];
            this.fragmentBytes = frame.payload.length;
          }
          break;

        case OPCODE.CONTINUATION: {
          if (this.fragmentOpcode === null) {
            this.close(1002, 'unexpected continuation frame');
            return;
          }
          this.fragmentBytes += frame.payload.length;
          if (this.fragmentBytes > this.options.maxPayloadBytes) {
            this.close(1009, 'reassembled message is too large');
            return;
          }
          this.fragments.push(frame.payload);
          if (frame.fin) {
            const opcode = this.fragmentOpcode;
            const parts = this.fragments;
            this.fragmentOpcode = null;
            this.fragments = [];
            this.fragmentBytes = 0;
            this.deliver(opcode, parts);
          }
          break;
        }

        case OPCODE.PING:
          if (this.isOpen) {
            try {
              this.socket.write(encodeFrame(OPCODE.PONG, frame.payload));
            } catch {
              this.terminate();
            }
          }
          break;

        case OPCODE.PONG:
          this.awaitingPong = false;
          break;

        case OPCODE.CLOSE: {
          const { code, reason } = decodeClosePayload(frame.payload);
          if (!this.closeFrameSent) {
            this.closeFrameSent = true;
            try {
              this.socket.write(encodeFrame(OPCODE.CLOSE, encodeClosePayload(code === 1005 ? 1000 : code)));
            } catch {
              /* ignore */
            }
          }
          this.finish(code, reason);
          this.socket.end();
          break;
        }

        default:
          this.close(1002, `unsupported opcode ${frame.opcode}`);
          return;
      }
    }
  }

  private deliver(opcode: number, parts: Buffer[]): void {
    if (opcode !== OPCODE.TEXT) {
      // The Nami channel is JSON text only.
      this.close(1003, 'binary frames are not accepted on this endpoint');
      return;
    }
    const text = Buffer.concat(parts).toString('utf8');
    try {
      this.handlers.onMessage?.(text);
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleError(error: Error): void {
    this.handlers.onError?.(error);
    this.terminate();
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.handlers.onClose?.(code, reason);
  }
}
