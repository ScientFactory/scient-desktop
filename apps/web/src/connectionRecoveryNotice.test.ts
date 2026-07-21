// FILE: connectionRecoveryNotice.test.ts
// Purpose: Verifies recovery-notice timing and privacy-safe diagnostic copy.
// Layer: Web connection recovery presentation tests

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTION_DETAILS_DELAY_MS,
  CONNECTION_NOTICE_DELAY_MS,
  ConnectionRecoveryNoticeController,
  formatConnectionRecoveryDiagnostics,
} from "./connectionRecoveryNotice";

afterEach(() => {
  vi.useRealTimers();
});

describe("connection recovery notice", () => {
  it("waits before notifying and reserves detailed help for sustained outages", () => {
    expect(CONNECTION_NOTICE_DELAY_MS).toBeGreaterThanOrEqual(1_000);
    expect(CONNECTION_DETAILS_DELAY_MS).toBeGreaterThan(CONNECTION_NOTICE_DELAY_MS);
  });

  it("stays silent for initial connection and brief reconnects", async () => {
    vi.useFakeTimers();
    const callbacks = {
      onClear: vi.fn(),
      onRecovered: vi.fn(),
      onShow: vi.fn(),
      onShowDetails: vi.fn(),
    };
    const controller = new ConnectionRecoveryNoticeController(callbacks);

    controller.handleState("connecting");
    controller.handleState("open");
    controller.handleState("reconnecting");
    await vi.advanceTimersByTimeAsync(CONNECTION_NOTICE_DELAY_MS - 1);
    controller.handleState("open");

    expect(callbacks.onShow).not.toHaveBeenCalled();
    expect(callbacks.onShowDetails).not.toHaveBeenCalled();
    expect(callbacks.onRecovered).not.toHaveBeenCalled();
  });

  it("uses one notice through delayed details and recovery", async () => {
    vi.useFakeTimers();
    const callbacks = {
      onClear: vi.fn(),
      onRecovered: vi.fn(),
      onShow: vi.fn(),
      onShowDetails: vi.fn(),
    };
    const controller = new ConnectionRecoveryNoticeController(callbacks);

    controller.handleState("reconnecting");
    await vi.advanceTimersByTimeAsync(CONNECTION_NOTICE_DELAY_MS);
    expect(callbacks.onShow).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CONNECTION_DETAILS_DELAY_MS - CONNECTION_NOTICE_DELAY_MS);
    expect(callbacks.onShowDetails).toHaveBeenCalledOnce();

    controller.handleState("open");
    expect(callbacks.onRecovered).toHaveBeenCalledOnce();
  });

  it("cancels stale timers and respects manual dismissal across repeated cycles", async () => {
    vi.useFakeTimers();
    const callbacks = {
      onClear: vi.fn(),
      onRecovered: vi.fn(),
      onShow: vi.fn(),
      onShowDetails: vi.fn(),
    };
    const controller = new ConnectionRecoveryNoticeController(callbacks);

    controller.handleState("reconnecting");
    await vi.advanceTimersByTimeAsync(CONNECTION_NOTICE_DELAY_MS);
    controller.dismissCurrentOutage();
    await vi.advanceTimersByTimeAsync(CONNECTION_DETAILS_DELAY_MS);
    controller.handleState("open");
    expect(callbacks.onShowDetails).not.toHaveBeenCalled();
    expect(callbacks.onRecovered).not.toHaveBeenCalled();

    controller.handleState("reconnecting");
    controller.handleState("open");
    await vi.advanceTimersByTimeAsync(CONNECTION_DETAILS_DELAY_MS);
    expect(callbacks.onShow).toHaveBeenCalledOnce();
  });

  it("formats bounded local diagnostics without project, URL, command, or content fields", () => {
    const diagnostics = formatConnectionRecoveryDiagnostics({
      appVersion: "0.5.7",
      desktopApp: true,
      generatedAt: new Date("2026-07-21T00:00:12.000Z"),
      navigatorOnline: true,
      platform: "Linux x86_64",
      state: "reconnecting",
      stateStartedAt: new Date("2026-07-21T00:00:00.000Z"),
      visibility: "visible",
    });

    expect(diagnostics).toContain("Transport state: reconnecting");
    expect(diagnostics).toContain("Elapsed: 12s");
    expect(diagnostics).toContain("Platform: Linux x86_64");
    expect(diagnostics).not.toMatch(/project|conversation|command line|websocket url|token/i);
  });

  it("never reports a negative elapsed duration when clocks move backwards", () => {
    const diagnostics = formatConnectionRecoveryDiagnostics({
      appVersion: "0.5.7",
      desktopApp: false,
      generatedAt: new Date("2026-07-21T00:00:00.000Z"),
      navigatorOnline: null,
      platform: "",
      state: "connecting",
      stateStartedAt: new Date("2026-07-21T00:00:03.000Z"),
      visibility: "",
    });

    expect(diagnostics).toContain("Elapsed: 0s");
    expect(diagnostics).toContain("Browser online: unknown");
  });
});
