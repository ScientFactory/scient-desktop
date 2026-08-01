import { describe, expect, it } from "vitest";

import { forkCursorNotificationDrain } from "./CursorAdapter.ts";
import {
  observeNotificationDrainAbandonedStart,
  observeNotificationDrainLifetime,
  observeNotificationDrainReplacement,
} from "./ProviderNotificationDrain.testSupport.ts";

describe("CursorAdapter notification drain lifetime", () => {
  it("keeps draining after the start caller completes and stops at session teardown", async () => {
    await expect(observeNotificationDrainLifetime(forkCursorNotificationDrain)).resolves.toEqual({
      deliveredAfterCallerCompleted: true,
      interruptedBeforeSessionTeardown: false,
      interruptedAfterSessionTeardown: true,
    });
  });

  it("interrupts a stopped session drain without silencing its replacement", async () => {
    await expect(observeNotificationDrainReplacement(forkCursorNotificationDrain)).resolves.toEqual(
      {
        stoppedDrainDelivered: false,
        stoppedDrainInterrupted: true,
        replacementDrainDelivered: true,
        replacementDrainInterruptedAfterTeardown: true,
      },
    );
  });

  it("interrupts the drain when startup fails before session ownership transfers", async () => {
    await expect(
      observeNotificationDrainAbandonedStart(forkCursorNotificationDrain),
    ).resolves.toEqual({
      deliveredAfterStartupFailure: false,
      interruptedByStartupCleanup: true,
    });
  });
});
