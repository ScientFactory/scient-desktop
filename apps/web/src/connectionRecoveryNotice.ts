// FILE: connectionRecoveryNotice.ts
// Purpose: Owns privacy-safe copy and timing policy for local-service recovery notices.
// Layer: Web connection recovery presentation logic

import type { WsTransportState } from "./wsTransportEvents";

export const CONNECTION_NOTICE_DELAY_MS = 1_500;
export const CONNECTION_DETAILS_DELAY_MS = 10_000;

export interface ConnectionRecoveryNoticeCallbacks {
  readonly onClear: () => void;
  readonly onRecovered: () => void;
  readonly onShow: (stateStartedAt: Date) => void;
  readonly onShowDetails: (stateStartedAt: Date) => void;
}

export interface ConnectionRecoveryNoticeClock {
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  readonly now: () => Date;
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

const systemClock: ConnectionRecoveryNoticeClock = {
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  now: () => new Date(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

/**
 * Owns one post-ready reconnect notice. Initial connection remains on the
 * existing startup surface, and every transition cancels stale timers.
 */
export class ConnectionRecoveryNoticeController {
  readonly #callbacks: ConnectionRecoveryNoticeCallbacks;
  readonly #clock: ConnectionRecoveryNoticeClock;
  #detailsTimer: ReturnType<typeof setTimeout> | null = null;
  #dismissed = false;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnecting = false;
  #visible = false;

  constructor(
    callbacks: ConnectionRecoveryNoticeCallbacks,
    clock: ConnectionRecoveryNoticeClock = systemClock,
  ) {
    this.#callbacks = callbacks;
    this.#clock = clock;
  }

  handleState(state: WsTransportState): void {
    if (state === "reconnecting") {
      if (this.#reconnecting) return;
      this.#reset();
      this.#callbacks.onClear();
      this.#reconnecting = true;
      const stateStartedAt = this.#clock.now();
      this.#noticeTimer = this.#clock.setTimeout(() => {
        this.#noticeTimer = null;
        if (!this.#reconnecting || this.#dismissed) return;
        this.#visible = true;
        this.#callbacks.onShow(stateStartedAt);
      }, CONNECTION_NOTICE_DELAY_MS);
      this.#detailsTimer = this.#clock.setTimeout(() => {
        this.#detailsTimer = null;
        if (!this.#reconnecting || this.#dismissed || !this.#visible) return;
        this.#callbacks.onShowDetails(stateStartedAt);
      }, CONNECTION_DETAILS_DELAY_MS);
      return;
    }

    const shouldAnnounceRecovery = state === "open" && this.#visible && !this.#dismissed;
    this.#reset();
    if (shouldAnnounceRecovery) this.#callbacks.onRecovered();
    else this.#callbacks.onClear();
  }

  dismissCurrentOutage(): void {
    if (!this.#reconnecting) return;
    this.#dismissed = true;
    this.#visible = false;
    this.#cancelTimer("details");
  }

  dispose(): void {
    this.#reset();
    this.#callbacks.onClear();
  }

  #cancelTimer(kind: "details" | "notice"): void {
    const timer = kind === "details" ? this.#detailsTimer : this.#noticeTimer;
    if (timer !== null) this.#clock.clearTimeout(timer);
    if (kind === "details") this.#detailsTimer = null;
    else this.#noticeTimer = null;
  }

  #reset(): void {
    this.#cancelTimer("notice");
    this.#cancelTimer("details");
    this.#dismissed = false;
    this.#reconnecting = false;
    this.#visible = false;
  }
}

export interface ConnectionRecoveryDiagnosticsInput {
  readonly appVersion: string;
  readonly desktopApp: boolean;
  readonly generatedAt: Date;
  readonly navigatorOnline: boolean | null;
  readonly platform: string;
  readonly state: WsTransportState;
  readonly stateStartedAt: Date;
  readonly visibility: string;
}

/**
 * Produces a bounded local summary that intentionally excludes URLs, paths,
 * project names, conversation content, process command lines, and credentials.
 */
export function formatConnectionRecoveryDiagnostics(
  input: ConnectionRecoveryDiagnosticsInput,
): string {
  const elapsedSeconds = Math.max(
    0,
    Math.round((input.generatedAt.getTime() - input.stateStartedAt.getTime()) / 1_000),
  );
  return [
    "Scient connection diagnostics",
    `Generated: ${input.generatedAt.toISOString()}`,
    `App version: ${input.appVersion}`,
    `Transport state: ${input.state}`,
    `State started: ${input.stateStartedAt.toISOString()}`,
    `Elapsed: ${elapsedSeconds}s`,
    `Platform: ${input.platform || "unknown"}`,
    `Desktop app: ${input.desktopApp ? "yes" : "no"}`,
    `Browser online: ${input.navigatorOnline === null ? "unknown" : input.navigatorOnline ? "yes" : "no"}`,
    `Window visibility: ${input.visibility || "unknown"}`,
  ].join("\n");
}
