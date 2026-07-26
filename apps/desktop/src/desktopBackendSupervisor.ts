import { performance } from "node:perf_hooks";

import type { ScientBackendShutdownMessage } from "@synara/shared/backendControl";

export interface DesktopBackendChild {
  readonly pid?: number | undefined;
  readonly connected?: boolean | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  send?(message: ScientBackendShutdownMessage, callback?: (error: Error | null) => void): boolean;
}

export interface DesktopBackendGeneration {
  readonly child: DesktopBackendChild;
  readonly number: number;
}

export interface DesktopBackendExit {
  readonly generation: number;
  readonly pid: number | null;
  readonly reason: string;
  readonly expected: boolean;
}

export interface DesktopBackendSupervisorOptions {
  readonly prepareStart: (generation: number) => Promise<void>;
  readonly spawn: (generation: number) => DesktopBackendChild;
  readonly requestGracefulShutdown: (
    child: DesktopBackendChild,
    reason: string,
  ) => boolean | Promise<boolean>;
  readonly forceTerminateTree: (child: DesktopBackendChild) => Promise<void> | void;
  readonly onGenerationStarted?: (generation: DesktopBackendGeneration) => void;
  readonly onGenerationExited?: (exit: DesktopBackendExit) => void;
  readonly onRestartScheduled?: (input: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly reason: string;
  }) => void;
  readonly onRestartLimitReached?: (input: {
    readonly error: DesktopBackendRestartLimitError;
    readonly failures: number;
    readonly maxFailures: number;
    readonly reason: string;
    readonly windowMs: number;
  }) => void;
  readonly classifyStartFailure?: (error: unknown) => "fatal" | "retry";
  readonly onFatalStartFailure?: (error: unknown) => void;
  readonly onUnrecoverableGeneration?: (input: {
    readonly error: Error;
    readonly generation: DesktopBackendGeneration;
    readonly reason: string;
  }) => void;
  readonly onError?: (error: unknown, context: string) => void;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  readonly restartBaseDelayMs?: number;
  readonly restartMaxDelayMs?: number;
  readonly restartMaxFailures?: number;
  readonly restartFailureWindowMs?: number;
  readonly restartStabilityThresholdMs?: number;
  readonly gracefulShutdownTimeoutMs?: number;
  readonly forcedExitTimeoutMs?: number;
  readonly now?: () => number;
}

interface ActiveGeneration extends DesktopBackendGeneration {
  closed: boolean;
}

const DEFAULT_RESTART_BASE_DELAY_MS = 500;
const DEFAULT_RESTART_MAX_DELAY_MS = 10_000;
// Four automatic retries are enough to absorb transient startup races; the fifth
// failure pauses supervision before a deterministic crash can churn disk or CPU.
const DEFAULT_RESTART_MAX_FAILURES = 5;
const DEFAULT_RESTART_FAILURE_WINDOW_MS = 60_000;
// Readiness proves that startup completed, but not that the process is healthy.
// Require a short continuous healthy interval before forgiving earlier failures.
const DEFAULT_RESTART_STABILITY_THRESHOLD_MS = 30_000;
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 8_000;
const DEFAULT_FORCED_EXIT_TIMEOUT_MS = 2_000;

function childHasExited(child: DesktopBackendChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return `code=${code ?? "null"} signal=${signal ?? "null"}`;
}

export class DesktopBackendTerminationError extends Error {
  readonly generation: number;
  readonly pid: number | null;
  readonly reason: string;

  constructor(active: DesktopBackendGeneration, reason: string) {
    super(`Backend generation ${active.number} remained alive after force termination.`);
    this.name = "DesktopBackendTerminationError";
    this.generation = active.number;
    this.pid = active.child.pid ?? null;
    this.reason = reason;
  }
}

export class DesktopBackendRestartLimitError extends Error {
  readonly failures: number;
  readonly maxFailures: number;
  readonly reason: string;
  readonly windowMs: number;

  constructor(input: {
    readonly failures: number;
    readonly maxFailures: number;
    readonly reason: string;
    readonly windowMs: number;
  }) {
    super(
      `Backend stopped ${input.failures} times within ${input.windowMs}ms; ` +
        `automatic restarts are paused (last failure: ${input.reason}).`,
    );
    this.name = "DesktopBackendRestartLimitError";
    this.failures = input.failures;
    this.maxFailures = input.maxFailures;
    this.reason = input.reason;
    this.windowMs = input.windowMs;
  }
}

/**
 * Owns exactly one desired desktop backend process. Every mutation is serialized,
 * and generation checks prevent late events from an old child changing current state.
 */
export class DesktopBackendSupervisor {
  readonly #options: DesktopBackendSupervisorOptions;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #now: () => number;

  #desiredRunning = false;
  #active: ActiveGeneration | null = null;
  #generation = 0;
  #restartFailures: number[] = [];
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  #stabilityGeneration: number | null = null;
  #transition: Promise<void> = Promise.resolve();
  readonly #stoppingGenerations = new Set<number>();

  constructor(options: DesktopBackendSupervisorOptions) {
    this.#options = options;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    // Restart diagnostics measure elapsed process time. Wall-clock corrections must not forgive
    // a crash loop early; failures remain retained until proven stability or explicit retry.
    this.#now = options.now ?? (() => performance.now());
  }

  get desiredRunning(): boolean {
    return this.#desiredRunning;
  }

  get currentGeneration(): DesktopBackendGeneration | null {
    return this.#active ? { child: this.#active.child, number: this.#active.number } : null;
  }

  start(): Promise<void> {
    const deliberateStart = !this.#desiredRunning;
    this.#desiredRunning = true;
    if (deliberateStart) this.#resetRestartState();
    return this.#enqueue(() => this.#ensureStarted());
  }

  resume(): Promise<void> {
    // Expected lifecycle interruptions, such as a failed updater handoff, must not erase
    // instability that has not yet been forgiven by a stable generation or explicit retry.
    this.#desiredRunning = true;
    return this.#enqueue(() => this.#ensureStarted());
  }

  stop(reason: string): Promise<void> {
    this.#desiredRunning = false;
    if (this.#active) this.#stoppingGenerations.add(this.#active.number);
    this.#clearRestartTimer();
    this.#clearStabilityTimer();
    return this.#enqueue(async () => {
      const active = this.#active;
      if (await this.#stopActive(reason)) return;
      throw new DesktopBackendTerminationError(active!, reason);
    });
  }

  markReady(generation: number): void {
    if (
      !this.#active ||
      this.#active.number !== generation ||
      this.#active.closed ||
      !this.#desiredRunning
    ) {
      return;
    }
    // Readiness may be observed again when a window is recreated for the same healthy process.
    // Preserve the original stability deadline so duplicate observations cannot postpone failure
    // forgiveness and turn a stable generation into a false crash-loop stop.
    if (this.#stabilityGeneration === generation && this.#stabilityTimer !== null) {
      return;
    }
    this.#clearStabilityTimer();
    const thresholdMs =
      this.#options.restartStabilityThresholdMs ?? DEFAULT_RESTART_STABILITY_THRESHOLD_MS;
    if (thresholdMs <= 0) {
      this.#resetRestartState();
      return;
    }
    this.#stabilityGeneration = generation;
    this.#stabilityTimer = this.#setTimer(() => {
      this.#stabilityTimer = null;
      const stableGeneration = this.#stabilityGeneration;
      this.#stabilityGeneration = null;
      if (
        stableGeneration === generation &&
        this.#desiredRunning &&
        this.#active?.number === generation &&
        !this.#active.closed
      ) {
        this.#restartFailures = [];
      }
    }, thresholdMs);
    this.#stabilityTimer.unref?.();
  }

  restartGeneration(generation: number, reason: string): Promise<void> {
    return this.#enqueue(async () => {
      if (
        !this.#desiredRunning ||
        !this.#active ||
        this.#active.number !== generation ||
        this.#active.closed
      ) {
        return;
      }
      const target = { child: this.#active.child, number: generation };
      const exited = await this.#stopActive(reason);
      if (exited && this.#desiredRunning) {
        this.#scheduleRestart(reason);
        return;
      }
      if (exited) return;

      const error = new DesktopBackendTerminationError(target, reason);
      this.#desiredRunning = false;
      this.#clearRestartTimer();
      this.#clearStabilityTimer();
      this.#options.onError?.(error, `generation ${generation} restart blocked`);
      this.#options.onUnrecoverableGeneration?.({
        error,
        generation: target,
        reason,
      });
    });
  }

  #enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.#transition.then(action, action);
    this.#transition = next.catch((error: unknown) => {
      this.#options.onError?.(error, "backend lifecycle transition");
    });
    return next;
  }

  async #ensureStarted(): Promise<void> {
    if (!this.#desiredRunning || this.#active) return;

    const generation = ++this.#generation;
    try {
      await this.#options.prepareStart(generation);
      if (!this.#desiredRunning || this.#active) return;

      const child = this.#options.spawn(generation);
      const active: ActiveGeneration = { child, number: generation, closed: false };
      this.#active = active;
      this.#bindChild(active);
      this.#options.onGenerationStarted?.(active);
    } catch (error) {
      if (!this.#desiredRunning) return;
      if (this.#options.classifyStartFailure?.(error) === "fatal") {
        this.#desiredRunning = false;
        this.#options.onFatalStartFailure?.(error);
        return;
      }
      this.#scheduleRestart(error instanceof Error ? error.message : String(error));
    }
  }

  #bindChild(active: ActiveGeneration): void {
    active.child.on("error", (error) => {
      if (active.child.pid === undefined) {
        this.#handleGenerationClosed(active, `spawn error=${error.message}`);
        return;
      }
      this.#options.onError?.(error, `generation ${active.number} process error`);
    });
    active.child.once("exit", (code, signal) => {
      this.#handleGenerationClosed(active, exitReason(code, signal));
    });
  }

  #handleGenerationClosed(active: ActiveGeneration, reason: string): void {
    if (active.closed) return;
    active.closed = true;
    const wasCurrent = this.#active === active;
    if (wasCurrent) this.#active = null;
    const expected = this.#stoppingGenerations.delete(active.number) || !this.#desiredRunning;
    this.#options.onGenerationExited?.({
      generation: active.number,
      pid: active.child.pid ?? null,
      reason,
      expected,
    });
    if (this.#stabilityGeneration === active.number) this.#clearStabilityTimer();
    if (wasCurrent && !expected) {
      void this.#enqueue(() => this.#cleanupExitedGenerationAndRestart(active, reason));
    }
  }

  async #cleanupExitedGenerationAndRestart(
    active: ActiveGeneration,
    reason: string,
  ): Promise<void> {
    try {
      await this.#options.forceTerminateTree(active.child);
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error("Failed to clean up the exited backend process tree.", { cause });
      this.#desiredRunning = false;
      this.#clearRestartTimer();
      this.#clearStabilityTimer();
      this.#options.onError?.(error, `generation ${active.number} descendant cleanup`);
      this.#options.onUnrecoverableGeneration?.({
        error,
        generation: active,
        reason,
      });
      return;
    }
    this.#scheduleRestart(reason);
  }

  #scheduleRestart(reason: string): void {
    if (!this.#desiredRunning || this.#restartTimer) return;
    const baseDelay = this.#options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    const maxDelay = this.#options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    const maxFailures = Math.max(
      1,
      Math.floor(this.#options.restartMaxFailures ?? DEFAULT_RESTART_MAX_FAILURES),
    );
    const configuredWindowMs = Math.max(
      1,
      this.#options.restartFailureWindowMs ?? DEFAULT_RESTART_FAILURE_WINDOW_MS,
    );
    const now = this.#now();
    // A generation is forgiven only after it remains ready for the stability
    // threshold (or after an explicit user retry resets supervision). Expiring
    // failures by wall time lets a deterministic but slower crash loop run
    // forever without ever demonstrating a healthy generation.
    this.#restartFailures.push(now);
    const failures = this.#restartFailures.length;
    if (failures >= maxFailures) {
      const firstFailureAt = this.#restartFailures[0] ?? now;
      const windowMs = Math.max(configuredWindowMs, Math.ceil(now - firstFailureAt));
      const error = new DesktopBackendRestartLimitError({
        failures,
        maxFailures,
        reason,
        windowMs,
      });
      this.#desiredRunning = false;
      this.#clearStabilityTimer();
      this.#options.onError?.(error, "backend restart limit reached");
      this.#options.onRestartLimitReached?.({ error, failures, maxFailures, reason, windowMs });
      return;
    }
    const attempt = failures - 1;
    const delayMs = Math.min(baseDelay * 2 ** attempt, maxDelay);
    this.#options.onRestartScheduled?.({ attempt, delayMs, reason });
    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = null;
      void this.#enqueue(() => this.#ensureStarted());
    }, delayMs);
    this.#restartTimer.unref?.();
  }

  #clearRestartTimer(): void {
    if (!this.#restartTimer) return;
    this.#clearTimer(this.#restartTimer);
    this.#restartTimer = null;
  }

  #clearStabilityTimer(): void {
    if (this.#stabilityTimer) this.#clearTimer(this.#stabilityTimer);
    this.#stabilityTimer = null;
    this.#stabilityGeneration = null;
  }

  #resetRestartState(): void {
    this.#restartFailures = [];
    this.#clearStabilityTimer();
  }

  async #stopActive(reason: string): Promise<boolean> {
    const active = this.#active;
    if (!active) return true;
    this.#stoppingGenerations.add(active.number);
    if (childHasExited(active.child)) {
      this.#handleGenerationClosed(active, "already exited");
      return true;
    }

    const gracefulTimeoutMs =
      this.#options.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    const forcedExitTimeoutMs = this.#options.forcedExitTimeoutMs ?? DEFAULT_FORCED_EXIT_TIMEOUT_MS;

    const exitedGracefully = await this.#waitForExit(active, gracefulTimeoutMs, () => {
      const sent = this.#options.requestGracefulShutdown(active.child, reason);
      if (!sent) {
        this.#options.onError?.(
          new Error("Backend IPC shutdown request was unavailable."),
          `generation ${active.number} graceful shutdown`,
        );
      }
      return sent;
    });
    if (exitedGracefully) return true;

    try {
      await this.#options.forceTerminateTree(active.child);
    } catch (error) {
      this.#options.onError?.(error, `generation ${active.number} force termination`);
    }
    const exitedAfterForce = await this.#waitForExit(active, forcedExitTimeoutMs);
    return exitedAfterForce;
  }

  async #waitForExit(
    active: ActiveGeneration,
    timeoutMs: number,
    begin?: () => boolean | void | Promise<boolean | void>,
  ): Promise<boolean> {
    if (active.closed || childHasExited(active.child)) return true;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (exited: boolean) => {
        if (settled) return;
        settled = true;
        active.child.off("exit", onExit);
        this.#clearTimer(timeout);
        resolve(exited);
      };
      const onExit = () => settle(true);
      active.child.once("exit", onExit);
      const timeout = this.#setTimer(() => settle(false), Math.max(0, timeoutMs));
      timeout.unref?.();
      try {
        void Promise.resolve(begin?.()).then(
          (started) => {
            if (started === false) settle(false);
          },
          (error: unknown) => {
            this.#options.onError?.(error, `generation ${active.number} graceful shutdown request`);
            settle(false);
          },
        );
      } catch (error) {
        this.#options.onError?.(error, `generation ${active.number} graceful shutdown request`);
        settle(false);
      }
      if (active.closed || childHasExited(active.child)) settle(true);
    });
  }
}
