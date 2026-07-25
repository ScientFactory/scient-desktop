import { describe, expect, it } from "vitest";

import { UpdateBackendRecoveryLatch } from "./updateBackendRecovery";

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
});
