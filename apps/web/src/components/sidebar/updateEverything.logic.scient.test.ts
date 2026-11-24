import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveRestoredRetry,
  type UpdateEverythingMachine,
  type UpdateRunMachine,
} from "./updateEverything.logic";

const lab = EnvironmentId.make("lab");

/** The lab server as this app sees it now: connected, behind, offering `selfUpdate`. */
function current(
  serverVersion: string,
  selfUpdate: "boot-service" | "respawn" | "desktop-managed",
): ReadonlyArray<UpdateEverythingMachine> {
  return [
    {
      environmentId: lab,
      label: "lab",
      serverConfig: {
        environment: {
          environmentId: lab,
          label: "lab",
          platform: { os: "linux", arch: "x64" },
          serverVersion,
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: selfUpdate,
            ...(selfUpdate === "desktop-managed"
              ? { desktopAppUpdate: true, desktopAppChannelSwitch: true }
              : {}),
          },
        },
        settings: { continueThreadsAfterServerUpdate: false },
      },
      connected: true,
      hostedByThisApp: false,
      canMaintain: true,
      updateState: { status: "idle" },
    },
  ];
}

/** A row restored from a saved handoff, with the mechanism the user confirmed, if it was saved. */
function restored(handedOffSelfUpdate?: "boot-service"): UpdateRunMachine {
  return {
    environmentId: lab,
    label: "lab",
    updatesProviders: false,
    server: null,
    handedOffVersion: "0.6.21",
    ...(handedOffSelfUpdate === undefined ? {} : { handedOffSelfUpdate }),
    startedAt: 0,
    result: "failed",
    failure: "Not back after 32 minutes",
    providerFailure: null,
  };
}

describe("resolveRestoredRetry keeps the confirmed update mechanism", () => {
  it("rebuilds the target while the server offers the confirmed mechanism", () => {
    expect(
      resolveRestoredRetry(restored("boot-service"), current("0.6.20", "boot-service")),
    ).toMatchObject({ environmentId: lab, selfUpdate: "boot-service", targetVersion: "0.6.21" });
  });

  it("offers no Retry when the same server and version now use another mechanism", () => {
    expect(resolveRestoredRetry(restored("boot-service"), current("0.6.20", "respawn"))).toBeNull();
    // Substituting the remote desktop app's own update for a confirmed service update.
    expect(
      resolveRestoredRetry(restored("boot-service"), current("0.6.20", "desktop-managed")),
    ).toBeNull();
  });

  it("offers no Retry for a row saved without its mechanism", () => {
    expect(resolveRestoredRetry(restored(), current("0.6.20", "boot-service"))).toBeNull();
  });

  it("still settles a server already on its target, whatever was saved", () => {
    expect(resolveRestoredRetry(restored(), current("0.6.21", "respawn"))).toBe("current");
  });
});
