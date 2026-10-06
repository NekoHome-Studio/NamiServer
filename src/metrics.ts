/**
 * Process-wide counters for the admin panel.
 *
 * Deliberately tiny: cumulative counters plus a couple of gauges, no histograms
 * and no external monitoring dependency.
 */

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  requests: {
    total: number;
    byStatus: Record<string, number>;
    byRoute: Record<string, number>;
    rejectedAuth: number;
    rejectedRateLimit: number;
    errors: number;
  };
  agent: {
    runsStarted: number;
    runsCompleted: number;
    runsFailed: number;
    runsCancelled: number;
    toolCalls: number;
    deltaEvents: number;
    streamedChars: number;
  };
  websocket: {
    connectionsOpened: number;
    connectionsClosed: number;
    active: number;
    messagesIn: number;
    messagesOut: number;
  };
  onebot: {
    /** Events accepted at POST /onebot/event. */
    eventsReceived: number;
    /** Events that passed the filter and started a run. */
    eventsHandled: number;
    /** Events dropped: wrong type, self-message, trigger miss, allowlist, busy. */
    eventsSkipped: number;
    /** QQ messages actually sent back. */
    repliesSent: number;
    failures: number;
  };
  transfer: {
    requestBytes: number;
    responseBytes: number;
  };
}

export class Metrics {
  private readonly startedAt = Date.now();

  private readonly byStatus = new Map<string, number>();
  private readonly byRoute = new Map<string, number>();

  private requestsTotal = 0;
  private rejectedAuth = 0;
  private rejectedRateLimit = 0;
  private errors = 0;

  private runsStarted = 0;
  private runsCompleted = 0;
  private runsFailed = 0;
  private runsCancelled = 0;
  private toolCalls = 0;
  private deltaEvents = 0;
  private streamedChars = 0;

  private wsOpened = 0;
  private wsClosed = 0;
  private wsActive = 0;
  private wsIn = 0;
  private wsOut = 0;

  private obReceived = 0;
  private obHandled = 0;
  private obSkipped = 0;
  private obReplies = 0;
  private obFailures = 0;

  private requestBytes = 0;
  private responseBytes = 0;

  recordRequest(route: string, status: number): void {
    this.requestsTotal += 1;
    this.byStatus.set(String(status), (this.byStatus.get(String(status)) ?? 0) + 1);
    this.byRoute.set(route, (this.byRoute.get(route) ?? 0) + 1);
  }

  recordAuthRejection(): void {
    this.rejectedAuth += 1;
  }

  recordRateLimitRejection(): void {
    this.rejectedRateLimit += 1;
  }

  recordError(): void {
    this.errors += 1;
  }

  recordBytesIn(bytes: number): void {
    this.requestBytes += bytes;
  }

  recordBytesOut(bytes: number): void {
    this.responseBytes += bytes;
  }

  recordRunStart(): void {
    this.runsStarted += 1;
  }

  recordRunEnd(status: 'succeeded' | 'failed' | 'cancelled'): void {
    if (status === 'succeeded') this.runsCompleted += 1;
    else if (status === 'cancelled') this.runsCancelled += 1;
    else this.runsFailed += 1;
  }

  recordToolCall(): void {
    this.toolCalls += 1;
  }

  recordDelta(chars: number): void {
    this.deltaEvents += 1;
    this.streamedChars += chars;
  }

  recordWsOpen(): void {
    this.wsOpened += 1;
    this.wsActive += 1;
  }

  recordWsClose(): void {
    this.wsClosed += 1;
    this.wsActive = Math.max(0, this.wsActive - 1);
  }

  recordWsIn(): void {
    this.wsIn += 1;
  }

  recordWsOut(): void {
    this.wsOut += 1;
  }

  recordOneBotReceived(): void {
    this.obReceived += 1;
  }

  recordOneBotHandled(): void {
    this.obHandled += 1;
  }

  recordOneBotSkipped(): void {
    this.obSkipped += 1;
  }

  recordOneBotReply(count = 1): void {
    this.obReplies += count;
  }

  recordOneBotFailure(): void {
    this.obFailures += 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: {
        total: this.requestsTotal,
        byStatus: Object.fromEntries(this.byStatus),
        byRoute: Object.fromEntries(this.byRoute),
        rejectedAuth: this.rejectedAuth,
        rejectedRateLimit: this.rejectedRateLimit,
        errors: this.errors,
      },
      agent: {
        runsStarted: this.runsStarted,
        runsCompleted: this.runsCompleted,
        runsFailed: this.runsFailed,
        runsCancelled: this.runsCancelled,
        toolCalls: this.toolCalls,
        deltaEvents: this.deltaEvents,
        streamedChars: this.streamedChars,
      },
      websocket: {
        connectionsOpened: this.wsOpened,
        connectionsClosed: this.wsClosed,
        active: this.wsActive,
        messagesIn: this.wsIn,
        messagesOut: this.wsOut,
      },
      onebot: {
        eventsReceived: this.obReceived,
        eventsHandled: this.obHandled,
        eventsSkipped: this.obSkipped,
        repliesSent: this.obReplies,
        failures: this.obFailures,
      },
      transfer: {
        requestBytes: this.requestBytes,
        responseBytes: this.responseBytes,
      },
    };
  }
}
