import { describe, expect, it, vi } from "vitest";

import {
  coordinateBackendRecoveryAfterUpdaterFailure,
  coordinateUpdaterFailureContinuation,
  resolveQuittingAfterUpdaterFailure,
  routeDesktopQuitRequest,
  UpdateBackendRecoveryLatch,
  UpdateQuitAuthorityLatch,
} from "./updateBackendRecovery";

describe("UpdateBackendRecoveryLatch", () => {
  it("restores a previously running backend exactly once", () => {
    const latch = new UpdateBackendRecoveryLatch();

    latch.capture(true);

    expect(latch.consume()).toBe(true);
    expect(latch.consume()).toBe(false);
  });

  it("keeps a crash-breaker-paused backend stopped", () => {
    const latch = new UpdateBackendRecoveryLatch();

    latch.capture(false);

    expect(latch.consume()).toBe(false);
  });

  it("never lets updater failure cancel concurrent desktop shutdown authority", () => {
    expect(
      resolveQuittingAfterUpdaterFailure({
        desktopShutdownInFlight: false,
        desktopShutdownComplete: false,
        pendingQuitRequest: false,
      }),
    ).toBe(false);
    expect(
      resolveQuittingAfterUpdaterFailure({
        desktopShutdownInFlight: true,
        desktopShutdownComplete: false,
        pendingQuitRequest: false,
      }),
    ).toBe(true);
    expect(
      resolveQuittingAfterUpdaterFailure({
        desktopShutdownInFlight: false,
        desktopShutdownComplete: true,
        pendingQuitRequest: false,
      }),
    ).toBe(true);
    expect(
      resolveQuittingAfterUpdaterFailure({
        desktopShutdownInFlight: false,
        desktopShutdownComplete: false,
        pendingQuitRequest: true,
      }),
    ).toBe(true);
  });

  it("preserves the recovery latch while desktop shutdown owns the lifecycle", () => {
    const latch = new UpdateBackendRecoveryLatch();
    const resume = vi.fn();
    const showRecovery = vi.fn();
    latch.capture(true);

    expect(
      coordinateBackendRecoveryAfterUpdaterFailure({
        recoveryLatch: latch,
        desktopShutdownInFlight: true,
        desktopShutdownComplete: false,
        recoveryPending: false,
        recoveryDialogOpen: false,
        resume,
        showRecovery,
      }),
    ).toBe("none");
    expect(resume).not.toHaveBeenCalled();
    expect(showRecovery).not.toHaveBeenCalled();
    expect(latch.consume()).toBe(true);
  });
});

describe("updater install quit authority", () => {
  it.each([
    ["before-quit", "SIGTERM", "Windows session end"],
    ["SIGINT", "before-quit", "Windows session end"],
    ["Windows session end", "before-quit", "SIGTERM"],
  ])(
    "preserves the first %s request across later %s and %s handlers",
    (firstReason, secondReason, thirdReason) => {
      const quitAuthority = new UpdateQuitAuthorityLatch();
      const startShutdown = vi.fn();

      for (const reason of [firstReason, secondReason, thirdReason]) {
        expect(
          routeDesktopQuitRequest({
            reason,
            updaterInstallPreparing: true,
            quitAuthority,
            startShutdown,
          }),
        ).toBe("deferred");
      }

      expect(startShutdown).not.toHaveBeenCalled();
      expect(quitAuthority.consume()).toBe(firstReason);
      expect(quitAuthority.consume()).toBeNull();
    },
  );

  it("continues the deferred handler request instead of recovering after updater failure", () => {
    const quitAuthority = new UpdateQuitAuthorityLatch();
    const startShutdown = vi.fn();
    const recover = vi.fn();

    expect(
      routeDesktopQuitRequest({
        reason: "before-quit",
        updaterInstallPreparing: true,
        quitAuthority,
        startShutdown,
      }),
    ).toBe("deferred");
    const pendingReason = quitAuthority.consume();
    expect(pendingReason).toBe("before-quit");

    expect(
      coordinateUpdaterFailureContinuation({
        pendingQuitReason: pendingReason,
        requestQuit: (reason) => {
          routeDesktopQuitRequest({
            reason,
            updaterInstallPreparing: false,
            quitAuthority,
            startShutdown,
          });
        },
        recover,
      }),
    ).toBe("quit");
    expect(startShutdown).toHaveBeenCalledOnce();
    expect(startShutdown).toHaveBeenCalledWith("before-quit");
    expect(recover).not.toHaveBeenCalled();
  });

  it("recovers normally when no quit handler requested authority", () => {
    const requestQuit = vi.fn();
    const recover = vi.fn();

    expect(
      coordinateUpdaterFailureContinuation({
        pendingQuitReason: null,
        requestQuit,
        recover,
      }),
    ).toBe("recover");
    expect(requestQuit).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
  });
});
