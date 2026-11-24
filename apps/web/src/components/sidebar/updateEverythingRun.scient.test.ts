import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ServerUpdateTarget } from "../ServerUpdateAction";
import type { UpdateEverythingRun } from "./updateEverything.logic";
import {
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  startDesktopUpdateLaunchNotice,
} from "./updateEverythingRun";

const SAVED_RESULT_KEY = "t3code:update-everything-result:v1";
const now = 1_800_000_000_000;

function stubStorage(): Map<string, string> {
  vi.useFakeTimers({ now });
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  return store;
}

/** Relaunches the app on the saved handoff and returns the run it restores. */
async function relaunch(): Promise<UpdateEverythingRun | null> {
  const stop = startDesktopUpdateLaunchNotice();
  let run: UpdateEverythingRun | null = null;
  setUpdateEverythingRun((current) => (run = current));
  // Lets every restored server time out, so nothing it follows outlives the test.
  await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
  stop();
  setUpdateEverythingRun(() => null);
  return run;
}

describe("the server handoff saved across a relaunch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the update mechanism the user confirmed for the restored row", async () => {
    const environmentId = EnvironmentId.make("confirmed-machine");
    const store = stubStorage();
    const server: ServerUpdateTarget = {
      environmentId,
      serverLabel: "Lab",
      selfUpdate: "boot-service",
      targetVersion: "9.9.9",
    };
    setUpdateEverythingRun(() => ({
      localVersion: "9.9.9",
      phase: "installing",
      restartAt: null,
      machines: [
        {
          environmentId,
          label: "Lab",
          updatesProviders: false,
          server,
          handedOffVersion: null,
          startedAt: now,
          result: null,
          failure: null,
          providerFailure: null,
        },
      ],
    }));
    saveUpdateEverythingResult({
      localVersion: "9.9.9",
      updatedServers: 0,
      updatedProviders: 0,
      failures: [],
      restarting: [],
    });
    setUpdateEverythingRun(() => null);
    expect(JSON.parse(store.get(SAVED_RESULT_KEY)!).handedOff).toEqual([
      expect.objectContaining({
        environmentId,
        targetVersion: "9.9.9",
        selfUpdate: "boot-service",
      }),
    ]);

    const run = await relaunch();
    expect(run?.machines).toEqual([
      expect.objectContaining({
        environmentId,
        server: null,
        handedOffVersion: "9.9.9",
        handedOffSelfUpdate: "boot-service",
      }),
    ]);
  });

  it("still restores a record saved before the mechanism was kept, without one", async () => {
    const environmentId = EnvironmentId.make("legacy-machine");
    const store = stubStorage();
    store.set(
      SAVED_RESULT_KEY,
      JSON.stringify({
        savedAt: now,
        localVersion: null,
        updatedServers: 0,
        updatedProviders: 0,
        failures: [],
        handedOff: [{ environmentId, label: "Legacy", targetVersion: "9.9.9", startedAt: now }],
      }),
    );

    const run = await relaunch();
    expect(run?.machines).toHaveLength(1);
    expect(run?.machines[0]).toMatchObject({ environmentId, handedOffVersion: "9.9.9" });
    expect(run?.machines[0]).not.toHaveProperty("handedOffSelfUpdate");
  });
});
