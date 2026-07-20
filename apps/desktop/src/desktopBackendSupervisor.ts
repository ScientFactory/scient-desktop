import type { ScientBackendShutdownMessage } from "@synara/shared/backendControl";

export interface DesktopBackendChild {
  readonly pid?: number | undefined;
  readonly connected?: boolean | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  send?(message: ScientBackendShutdownMessage): boolean;
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
  readonly requestGracefulShutdown: (child: DesktopBackendChild, reason: string) => boolean;
  readonly forceTerminateTree: (child: DesktopBackendChild) => Promise<void> | void;
  readonly onGenerationStarted?: (generation: DesktopBackendGeneration) => void;
  readonly onGenerationExited?: (exit: DesktopBackendExit) => void;
  readonly onRestartScheduled?: (input: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly reason: string;
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
  readonly gracefulShutdownTimeoutMs?: number;
  readonly forcedExitTimeoutMs?: number;
}

interface ActiveGeneration extends DesktopBackendGeneration {
  closed: boolean;
}

const DEFAULT_RESTART_BASE_DELAY_MS = 500;
const DEFAULT_RESTART_MAX_DELAY_MS = 10_000;
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 8_000;
const DEFAULT_FORCED_EXIT_TIMEOUT_MS = 2_000;

function childHasExited(child: DesktopBackendChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return `code=${code ?? "null"} signal=${signal ?? "null"}`;
}

/**
 * Owns exactly one desired desktop backend process. Every mutation is serialized,
 * and generation checks prevent late events from an old child changing current state.
 */
export class DesktopBackendSupervisor {
  readonly #options: DesktopBackendSupervisorOptions;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;

  #desiredRunning = false;
  #active: ActiveGeneration | null = null;
  #generation = 0;
  #restartAttempt = 0;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #transition: Promise<void> = Promise.resolve();
  readonly #stoppingGenerations = new Set<number>();

  constructor(options: DesktopBackendSupervisorOptions) {
    this.#options = options;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  get desiredRunning(): boolean {
    return this.#desiredRunning;
  }

  get currentGeneration(): DesktopBackendGeneration | null {
    return this.#active ? { child: this.#active.child, number: this.#active.number } : null;
  }

  start(): Promise<void> {
    this.#desiredRunning = true;
    return this.#enqueue(() => this.#ensureStarted());
  }

  stop(reason: string): Promise<void> {
    this.#desiredRunning = false;
    if (this.#active) this.#stoppingGenerations.add(this.#active.number);
    this.#clearRestartTimer();
    return this.#enqueue(async () => {
      await this.#stopActive(reason);
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
    this.#restartAttempt = 0;
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
      } else if (!exited) {
        // A replacement must never overlap an old process that ignored force
        // termination. Stop automatic recovery and surface a fatal lifecycle
        // failure instead of leaving the app in an unreported half-alive state.
        const error = new Error("Backend remained alive after force termination.");
        this.#desiredRunning = false;
        this.#clearRestartTimer();
        this.#options.onError?.(error, `generation ${generation} restart blocked`);
        this.#options.onUnrecoverableGeneration?.({
          error,
          generation: target,
          reason,
        });
      }
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
      this.#handleGenerationClosed(active, `error=${error.message}`);
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
    if (wasCurrent && !expected) this.#scheduleRestart(reason);
  }

  #scheduleRestart(reason: string): void {
    if (!this.#desiredRunning || this.#restartTimer) return;
    const baseDelay = this.#options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    const maxDelay = this.#options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    const attempt = this.#restartAttempt;
    const delayMs = Math.min(baseDelay * 2 ** attempt, maxDelay);
    this.#restartAttempt += 1;
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
    if (!exitedAfterForce) return false;
    return true;
  }

  async #waitForExit(
    active: ActiveGeneration,
    timeoutMs: number,
    begin?: () => boolean | void,
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
      if (begin?.() === false) settle(false);
      if (active.closed || childHasExited(active.child)) settle(true);
    });
  }
}
