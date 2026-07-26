import { describe, expect, it, vi } from "vitest";

import {
  coordinateBackendRecoveryAfterUpdaterFailure,
  resolveQuittingAfterUpdaterFailure,
  UpdateBackendRecoveryLatch,
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
      }),
    ).toBe(false);
    expect(
      resolveQuittingAfterUpdaterFailure({
        desktopShutdownInFlight: true,
        desktopShutdownComplete: false,
      }),
    ).toBe(true);
    expect(
      resolveQuittingAfterUpdaterFailure({
        desktopShutdownInFlight: false,
        desktopShutdownComplete: true,
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
