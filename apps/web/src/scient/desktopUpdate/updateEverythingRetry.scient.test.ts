import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";
import type {
  RestoredRetry,
  UpdateCapsuleView,
  UpdateRunMachineView,
} from "~/components/sidebar/updateEverything.logic";
import { offerEligibleUpdateRetry } from "./updateEverythingRetry";

const target: ServerUpdateTarget = {
  environmentId: EnvironmentId.make("lab"),
  serverLabel: "lab",
  selfUpdate: "boot-service",
  targetVersion: "0.6.21",
};
const retryView: UpdateCapsuleView = { tone: "failed", label: "Update failed", action: "retry" };

/** A row the relaunched app rebuilt from its saved handoff: only the version, no target. */
function restored(restoredRetry: RestoredRetry | null): UpdateRunMachineView {
  return {
    machine: {
      environmentId: target.environmentId,
      label: "lab",
      updatesProviders: false,
      server: null,
      handedOffVersion: "0.6.21",
      startedAt: 0,
      result: "failed",
      failure: "Not back after 10 minutes",
      providerFailure: null,
    },
    status: "failed",
    restoredRetry,
  };
}

describe("offerEligibleUpdateRetry for a server restored after a relaunch", () => {
  it("offers Retry for its rebuilt target while that target is qualified", () => {
    expect(offerEligibleUpdateRetry(retryView, [restored(target)], [target]).action).toBe("retry");
    expect(offerEligibleUpdateRetry(retryView, [restored(target)], []).action).toBe("dismiss");
    expect(
      offerEligibleUpdateRetry(
        retryView,
        [restored(target)],
        [{ ...target, targetVersion: "0.7.0" }],
      ).action,
    ).toBe("dismiss");
  });

  it("keeps Retry for one already on its target, which the retry settles", () => {
    expect(offerEligibleUpdateRetry(retryView, [restored("current")], []).action).toBe("retry");
  });

  it("offers Dismiss when nothing can be rebuilt", () => {
    expect(offerEligibleUpdateRetry(retryView, [restored(null)], [target]).action).toBe("dismiss");
  });
});
