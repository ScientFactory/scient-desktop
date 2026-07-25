import { describe, expect, it, vi } from "vitest";

import {
  buildBackendRestartRecoveryDialog,
  handleBackendRestartRecoveryAction,
  resolveBackendRestartRecoveryAction,
  shouldShowBackendRestartRecovery,
} from "./backendRestartRecovery";

describe("backend restart recovery", () => {
  it("suppresses the initial recovery dialog once shutdown begins", () => {
    expect(shouldShowBackendRestartRecovery(false)).toBe(true);
    expect(shouldShowBackendRestartRecovery(true)).toBe(false);
  });

  it("offers retry and logs while keeping cancellation non-destructive", () => {
    const options = buildBackendRestartRecoveryDialog({
      appName: "Scient",
      failures: 5,
      windowMs: 60_000,
      logFilePath: "/tmp/scient/server-child.log",
    });

    expect(options.buttons).toEqual(["Try again", "Open logs", "Keep Scient open"]);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(2);
    expect(options.detail).toContain("5 failures in 60 seconds");
    expect(options.detail).toContain("/tmp/scient/server-child.log");
  });

  it("explains a log-opening failure when recovery choices reopen", () => {
    const options = buildBackendRestartRecoveryDialog({
      appName: "Scient",
      failures: 5,
      windowMs: 60_000,
      logFilePath: "/tmp/scient/server-child.log",
      openLogsErrorMessage: "permission denied",
    });

    expect(options.detail).toContain("Scient could not open the logs folder: permission denied");
    expect(options.detail).toContain("/tmp/scient/server-child.log");
  });

  it("reopens recovery choices after logs open successfully", async () => {
    const retry = vi.fn();
    const reopen = vi.fn();
    const onOpenLogsError = vi.fn();

    await handleBackendRestartRecoveryAction({
      action: "open-logs",
      openLogs: vi.fn(async () => undefined),
      retry,
      reopen,
      isQuitting: () => false,
      onOpenLogsError,
    });

    expect(reopen).toHaveBeenCalledOnce();
    expect(onOpenLogsError).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("reports log-open failure and still reopens recovery choices", async () => {
    const failure = new Error("logs unavailable");
    const reopen = vi.fn();
    const onOpenLogsError = vi.fn();

    await handleBackendRestartRecoveryAction({
      action: "open-logs",
      openLogs: vi.fn(async () => {
        throw failure;
      }),
      retry: vi.fn(),
      reopen,
      isQuitting: () => false,
      onOpenLogsError,
    });

    expect(onOpenLogsError).toHaveBeenCalledWith(failure);
    expect(reopen).toHaveBeenCalledOnce();
  });

  it("does not reopen recovery choices once quitting begins", async () => {
    const reopen = vi.fn();

    await handleBackendRestartRecoveryAction({
      action: "open-logs",
      openLogs: vi.fn(async () => {
        throw new Error("logs unavailable");
      }),
      retry: vi.fn(),
      reopen,
      isQuitting: () => true,
      onOpenLogsError: vi.fn(),
    });

    expect(reopen).not.toHaveBeenCalled();
  });

  it("maps only explicit actionable buttons to native effects", () => {
    expect(resolveBackendRestartRecoveryAction(0)).toBe("retry");
    expect(resolveBackendRestartRecoveryAction(1)).toBe("open-logs");
    expect(resolveBackendRestartRecoveryAction(2)).toBe("dismiss");
    expect(resolveBackendRestartRecoveryAction(-1)).toBe("dismiss");
  });
});
