// FILE: connectionSupervisor.ts
// Purpose: Owns one desired browser-to-server connection across retries and wake probes.
// Layer: Web transport lifecycle
// Exports: ConnectionSupervisor and its observable lifecycle snapshot.

export type ConnectionSupervisorPhase = "connecting" | "ready" | "reconnecting" | "disposed";

export interface ConnectionSupervisorSession<T> {
  readonly generation: number;
  readonly value: T;
}

export interface ConnectionSupervisorSnapshot {
  readonly phase: ConnectionSupervisorPhase;
  readonly generation: number | null;
  readonly retryAttempt: number;
  readonly retryDelayMs: number | null;
}

export interface ConnectionSupervisorOptions<T> {
  readonly connect: (generation: number, signal: AbortSignal) => Promise<T>;
  readonly close: (session: ConnectionSupervisorSession<T>) => Promise<void> | void;
  readonly probe: (session: ConnectionSupervisorSession<T>) => Promise<void>;
  readonly onReady?: (session: ConnectionSupervisorSession<T>) => void;
  readonly onInvalidated?: (session: ConnectionSupervisorSession<T>, reason: string) => void;
  readonly onSnapshot?: (snapshot: ConnectionSupervisorSnapshot) => void;
  readonly onError?: (error: unknown, context: string) => void;
  readonly onRetryScheduled?: (input: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly reason: string;
  }) => void;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  readonly random?: () => number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly retryJitterRatio?: number;
  /** Maximum duration of one complete connection creation attempt. */
  readonly connectTimeoutMs?: number;
  /** Healthy time required before prior retry failures are forgiven. */
  readonly retryResetAfterMs?: number;
  /**
   * Maximum time replacement creation waits for an old session to dispose.
   * A timed-out session remains stale by generation and may finish disposing in
   * the background, but it cannot indefinitely block recovery.
   */
  readonly closeTimeoutMs?: number;
}

interface SessionWaiter<T> {
  readonly resolve: (session: ConnectionSupervisorSession<T>) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 16_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_RESET_AFTER_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serializes connection creation, invalidation, retry, and wake probing. Callers
 * may report the same broken generation more than once; only the current generation
 * can change state, so late stream exits cannot replace a healthy session.
 */
export class ConnectionSupervisor<T> {
  readonly #options: ConnectionSupervisorOptions<T>;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #random: () => number;

  #desiredRunning = false;
  #disposed = false;
  #generation = 0;
  #active: ConnectionSupervisorSession<T> | null = null;
  #connectInFlight: Promise<void> | null = null;
  #connectAbort: { readonly generation: number; readonly controller: AbortController } | null =
    null;
  #closeInFlight: Promise<void> | null = null;
  #probeInFlight: { readonly generation: number; readonly promise: Promise<void> } | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryResetTimer: ReturnType<typeof setTimeout> | null = null;
  #retryAttempt = 0;
  #hasBeenReady = false;
  #snapshot: ConnectionSupervisorSnapshot = {
    phase: "connecting",
    generation: null,
    retryAttempt: 0,
    retryDelayMs: null,
  };
  readonly #waiters = new Set<SessionWaiter<T>>();

  constructor(options: ConnectionSupervisorOptions<T>) {
    this.#options = options;
    this.#setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.#clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
    this.#random = options.random ?? Math.random;
  }

  get snapshot(): ConnectionSupervisorSnapshot {
    return this.#snapshot;
  }

  get currentSession(): ConnectionSupervisorSession<T> | null {
    return this.#active;
  }

  start(): void {
    if (this.#disposed) return;
    this.#desiredRunning = true;
    if (!this.#active && !this.#connectInFlight && !this.#retryTimer) {
      this.#beginConnect();
    }
  }

  waitForSession(options?: {
    readonly timeoutMs?: number;
  }): Promise<ConnectionSupervisorSession<T>> {
    if (this.#disposed) {
      return Promise.reject(new Error("Connection supervisor disposed"));
    }
    if (this.#active) return Promise.resolve(this.#active);
    this.start();
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const waiter: SessionWaiter<T> = {
        resolve: (session) => {
          if (timeout !== null) this.#clearTimer(timeout);
          this.#waiters.delete(waiter);
          resolve(session);
        },
        reject: (error) => {
          if (timeout !== null) this.#clearTimer(timeout);
          this.#waiters.delete(waiter);
          reject(error);
        },
      };
      this.#waiters.add(waiter);
      const timeoutMs = options?.timeoutMs;
      if (timeoutMs !== undefined) {
        timeout = this.#setTimer(
          () => {
            waiter.reject(new Error(`Connection unavailable after ${Math.max(0, timeoutMs)}ms`));
          },
          Math.max(0, timeoutMs),
        );
      }
    });
  }

  invalidate(generation: number, reason: string): boolean {
    const active = this.#active;
    if (this.#disposed || !active || active.generation !== generation) return false;

    this.#active = null;
    this.#clearRetryResetTimer();
    this.#options.onInvalidated?.(active, reason);
    this.#close(active, `generation ${generation} invalidation`);
    this.#scheduleRetry(reason);
    return true;
  }

  probe(reason: string): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.start();
    if (!this.#active) {
      this.#retryNow();
      return this.#connectInFlight ?? Promise.resolve();
    }
    if (this.#probeInFlight?.generation === this.#active.generation) {
      return this.#probeInFlight.promise;
    }

    const session = this.#active;
    const probe = this.#options
      .probe(session)
      .catch((error: unknown) => {
        if (this.#active?.generation !== session.generation) return;
        this.#options.onError?.(error, `generation ${session.generation} wake probe`);
        this.invalidate(session.generation, `${reason}: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (this.#probeInFlight?.promise === probe) this.#probeInFlight = null;
      });
    this.#probeInFlight = { generation: session.generation, promise: probe };
    return probe;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#desiredRunning = false;
    this.#clearRetryTimer();
    this.#clearRetryResetTimer();
    this.#connectAbort?.controller.abort(new Error("Connection supervisor disposed"));
    this.#connectAbort = null;
    this.#generation += 1;

    const active = this.#active;
    this.#active = null;
    if (active) {
      this.#options.onInvalidated?.(active, "disposed");
      this.#close(active, `generation ${active.generation} disposal`);
    }
    const error = new Error("Connection supervisor disposed");
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
    this.#publish({
      phase: "disposed",
      generation: null,
      retryAttempt: this.#retryAttempt,
      retryDelayMs: null,
    });
  }

  #beginConnect(): void {
    if (this.#disposed || !this.#desiredRunning || this.#active || this.#connectInFlight) {
      return;
    }
    this.#clearRetryTimer();
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#connectAbort = { generation, controller };
    this.#publish({
      phase: this.#hasBeenReady ? "reconnecting" : "connecting",
      generation,
      retryAttempt: this.#retryAttempt,
      retryDelayMs: null,
    });

    const connectResult = this.#connectWithTimeout(generation, controller);
    const connecting = connectResult
      .then((value) => {
        const session = { generation, value } satisfies ConnectionSupervisorSession<T>;
        if (this.#disposed || !this.#desiredRunning || generation !== this.#generation) {
          this.#close(session, `stale generation ${generation}`);
          return;
        }
        this.#active = session;
        this.#hasBeenReady = true;
        this.#publish({
          phase: "ready",
          generation,
          retryAttempt: this.#retryAttempt,
          retryDelayMs: null,
        });
        this.#armRetryReset(session);
        for (const waiter of this.#waiters) waiter.resolve(session);
        this.#waiters.clear();
        this.#options.onReady?.(session);
      })
      .catch((error: unknown) => {
        if (this.#disposed || !this.#desiredRunning || generation !== this.#generation) return;
        this.#options.onError?.(error, `generation ${generation} connect`);
        this.#scheduleRetry(errorMessage(error));
      })
      .finally(() => {
        if (this.#connectAbort?.generation === generation) this.#connectAbort = null;
        if (this.#connectInFlight === connecting) {
          this.#connectInFlight = null;
          if (!this.#disposed && this.#desiredRunning && !this.#active && !this.#retryTimer) {
            this.#beginConnect();
          }
        }
      });
    this.#connectInFlight = connecting;
  }

  async #connectWithTimeout(generation: number, controller: AbortController): Promise<T> {
    const timeoutMs = Math.max(0, this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    let acceptResult = true;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => undefined;
    const connect = (async () => {
      if (this.#closeInFlight) await this.#closeInFlight;
      if (controller.signal.aborted) throw controller.signal.reason;
      return this.#options.connect(generation, controller.signal);
    })().then((value) => {
      if (!acceptResult || controller.signal.aborted) {
        this.#close({ generation, value }, `late abandoned generation ${generation}`);
        throw (
          controller.signal.reason ?? new Error(`Connection generation ${generation} abandoned`)
        );
      }
      return value;
    });
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(
          controller.signal.reason ?? new Error(`Connection generation ${generation} aborted`),
        );
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    timeout = this.#setTimer(() => {
      controller.abort(
        new Error(`Connection generation ${generation} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    try {
      return await Promise.race([connect, aborted]);
    } finally {
      acceptResult = false;
      removeAbortListener();
      if (timeout !== null) this.#clearTimer(timeout);
    }
  }

  #armRetryReset(session: ConnectionSupervisorSession<T>): void {
    this.#clearRetryResetTimer();
    if (this.#retryAttempt === 0) return;
    const delayMs = Math.max(0, this.#options.retryResetAfterMs ?? DEFAULT_RETRY_RESET_AFTER_MS);
    this.#retryResetTimer = this.#setTimer(() => {
      this.#retryResetTimer = null;
      if (this.#disposed || this.#active?.generation !== session.generation) return;
      this.#retryAttempt = 0;
      this.#publish({
        phase: "ready",
        generation: session.generation,
        retryAttempt: 0,
        retryDelayMs: null,
      });
    }, delayMs);
  }

  #scheduleRetry(reason: string): void {
    if (this.#disposed || !this.#desiredRunning || this.#retryTimer) return;
    const attempt = this.#retryAttempt;
    const baseDelay = this.#options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxDelay = this.#options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const jitterRatio = Math.max(
      0,
      Math.min(this.#options.retryJitterRatio ?? DEFAULT_RETRY_JITTER_RATIO, 1),
    );
    const exponentialDelay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    const jitterMultiplier = 1 + (this.#random() * 2 - 1) * jitterRatio;
    const delayMs = Math.max(0, Math.round(exponentialDelay * jitterMultiplier));
    this.#retryAttempt += 1;
    this.#publish({
      phase: this.#hasBeenReady ? "reconnecting" : "connecting",
      generation: null,
      retryAttempt: this.#retryAttempt,
      retryDelayMs: delayMs,
    });
    this.#options.onRetryScheduled?.({ attempt, delayMs, reason });
    this.#retryTimer = this.#setTimer(() => {
      this.#retryTimer = null;
      this.#beginConnect();
    }, delayMs);
  }

  #retryNow(): void {
    if (this.#disposed || !this.#desiredRunning || this.#active) return;
    if (this.#retryTimer) {
      this.#clearRetryTimer();
    }
    this.#beginConnect();
  }

  #clearRetryTimer(): void {
    if (!this.#retryTimer) return;
    this.#clearTimer(this.#retryTimer);
    this.#retryTimer = null;
  }

  #clearRetryResetTimer(): void {
    if (!this.#retryResetTimer) return;
    this.#clearTimer(this.#retryResetTimer);
    this.#retryResetTimer = null;
  }

  #close(session: ConnectionSupervisorSession<T>, context: string): void {
    const previousClose = this.#closeInFlight ?? Promise.resolve();
    const closing = previousClose
      .then(() => this.#closeWithTimeout(session))
      .catch((error: unknown) => {
        this.#options.onError?.(error, context);
      })
      .finally(() => {
        if (this.#closeInFlight === closing) this.#closeInFlight = null;
      });
    this.#closeInFlight = closing;
  }

  async #closeWithTimeout(session: ConnectionSupervisorSession<T>): Promise<void> {
    const timeoutMs = Math.max(0, this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const close = Promise.resolve().then(() => this.#options.close(session));
    const timedOut = new Promise<never>((_, reject) => {
      timeout = this.#setTimer(() => {
        reject(
          new Error(
            `Connection generation ${session.generation} disposal timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });
    try {
      await Promise.race([close, timedOut]);
    } finally {
      if (timeout !== null) this.#clearTimer(timeout);
    }
  }

  #publish(snapshot: ConnectionSupervisorSnapshot): void {
    this.#snapshot = snapshot;
    this.#options.onSnapshot?.(snapshot);
  }
}
