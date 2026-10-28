import {
  EnvironmentId,
  type DesktopUpdateState,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  describeUpdateEverything,
  runUpdateEverything,
  shouldRunUpdateEverything,
  supportedBulkServerTargets,
  unsupportedBulkServerMachines,
  type UpdateEverythingMachine,
} from "./updateEverything.logic";
import { installDesktopUpdateNow } from "~/scient/desktopUpdate/updateReadyNotice";

const downloadedState: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.6.1",
  availableVersion: "0.6.2",
  downloadedVersion: "0.6.2",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates remote servers that can move to the target and names every skipped one", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("never-connected", "0.0.40", "boot-service", { serverConfig: null }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("busy", "0.0.40", "boot-service", {
          updateState: {
            status: "running",
            stage: "downloading",
            fromVersion: "0.0.40",
            targetVersion: "0.0.50",
          },
        }),
        machine("current", "0.0.50", "boot-service"),
        machine("current-offline", "0.0.50", "boot-service", { connected: false }),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["nightly-service", "on the nightly channel"],
      ["offline", "not connected"],
      ["never-connected", "not connected"],
      ["no-scope", "no permission"],
      ["busy", "already updating"],
      ["manual", "needs a manual update"],
    ]);
  });
});

describe("Scient bulk update authority", () => {
  it("requires owned exact artifact availability while retaining remote desktop feed authority", () => {
    const { targets: candidates } = collectServerUpdateTargets(
      [
        machine("service", "0.6.1", "boot-service"),
        machine("desktop", "0.6.1", "desktop-managed"),
        machine("respawn", "0.6.1", "respawn"),
      ],
      "0.6.2",
    );
    expect(candidates.map((target) => target.serverLabel)).toEqual([
      "service",
      "desktop",
      "respawn",
    ]);
    expect(supportedBulkServerTargets(candidates).map((target) => target.serverLabel)).toEqual([
      "desktop",
    ]);
    expect(
      supportedBulkServerTargets(candidates, false).map((target) => target.serverLabel),
    ).toEqual(["desktop"]);
    expect(
      supportedBulkServerTargets(candidates, true).map((target) => target.serverLabel),
    ).toEqual(["service", "desktop"]);
  });

  it("names each server the bulk filter leaves out, in Scient's words", () => {
    const { targets } = collectServerUpdateTargets(
      [
        machine("service", "0.6.1", "boot-service"),
        machine("desktop", "0.6.1", "desktop-managed"),
        machine("respawn", "0.6.1", "respawn"),
      ],
      "0.6.2",
    );
    const skipped = unsupportedBulkServerMachines(targets, supportedBulkServerTargets(targets));
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["service", "Scient server 0.6.2 is not published yet"],
      ["respawn", "update it separately"],
    ]);
    expect(skipped.some((entry) => /npm|t3@/.test(entry.reason))).toBe(false);
  });

  it("bundles other updates only with this app's download and keeps Restart direct", () => {
    expect(shouldRunUpdateEverything(true, false, "install")).toBe(false);
    expect(shouldRunUpdateEverything(true, false, "download")).toBe(true);
    expect(shouldRunUpdateEverything(true, false, "none")).toBe(false);
    expect(shouldRunUpdateEverything(true, true, "download")).toBe(false);
    expect(shouldRunUpdateEverything(false, false, "download")).toBe(false);
  });
});

describe("collectRestartingMachines", () => {
  it("lists updated servers, and this app's servers only when it installs", () => {
    const withContinuation = (
      id: string,
      overrides: Partial<UpdateEverythingMachine> = {},
      enabled = false,
    ) => {
      const base = machine(id, "0.0.40", "boot-service", overrides);
      return {
        ...base,
        serverConfig: {
          environment: base.serverConfig!.environment,
          settings: { continueThreadsAfterServerUpdate: enabled },
        },
      };
    };
    const machines = [
      withContinuation("this-app", { hostedByThisApp: true }, true),
      withContinuation("alvin", {}, true),
      withContinuation("opted-out", {}, false),
      machine("old", "0.0.40", "boot-service"),
      withContinuation("providers-only"),
    ];
    const servers = collectServerUpdateTargets(machines, "0.0.50").targets.filter((target) =>
      ["alvin", "opted-out", "old"].includes(target.environmentId),
    );

    expect(collectRestartingMachines(machines, servers, true)).toEqual([
      { environmentId: "this-app", continuesThreads: true },
      { environmentId: "alvin", continuesThreads: true },
      { environmentId: "opted-out", continuesThreads: false },
      { environmentId: "old", continuesThreads: false },
    ]);
    expect(
      collectRestartingMachines(machines, servers, false).map((entry) => entry.environmentId),
    ).toEqual(["alvin", "opted-out", "old"]);
  });
});

describe("runUpdateEverything", () => {
  // SCIENT-FORK:START — bulk and explicit Restart share Scient's one installer.
  it("composes bulk and explicit install actions through the one Scient installer", async () => {
    const calls: string[] = [];
    let finishInstall = () => {};
    let beganInstall = () => {};
    const installed = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const started = new Promise<void>((resolve) => {
      beganInstall = resolve;
    });
    const shell = {
      installUpdate: async () => {
        calls.push("install");
        beganInstall();
        await installed;
        return { accepted: true, completed: true, state: downloadedState };
      },
    };
    const outcome = await runUpdateEverything({
      downloadLocal: async () => {
        calls.push("download");
        return true;
      },
      updateProviders: async () => {
        calls.push("providers");
      },
      updateServers: async () => {
        calls.push("servers");
      },
    });
    expect(outcome.localReady).toBe(true);
    const reported: string[] = [];
    const bulkInstall = installDesktopUpdateNow(shell, (title, description) => {
      reported.push(`${title}: ${description}`);
    });
    await started;
    const explicitRestart = installDesktopUpdateNow(shell);
    expect(explicitRestart).toBe(bulkInstall);
    finishInstall();
    expect(await Promise.all([bulkInstall, explicitRestart])).toEqual([true, true]);
    expect(calls).toEqual(["download", "providers", "servers", "install"]);
    expect(reported).toEqual([]);
  });

  it("reports a failed install to the pass and resolves false", async () => {
    const reported: string[] = [];
    const relaunching = await installDesktopUpdateNow(
      {
        installUpdate: async () => ({
          accepted: true,
          completed: false,
          state: { ...downloadedState, status: "error", message: "Signature mismatch" },
        }),
      },
      (title, description) => {
        reported.push(`${title}: ${description}`);
      },
    );
    expect(relaunching).toBe(false);
    expect(reported).toEqual(["Could not install update: Signature mismatch"]);
  });
  // SCIENT-FORK:END

  it("still updates remote machines when the local download fails", async () => {
    const calls: string[] = [];
    const result = await runUpdateEverything({
      downloadLocal: async () => false,
      updateProviders: async () => {
        calls.push("providers");
      },
      updateServers: async () => {
        calls.push("servers");
      },
    });

    expect(calls).toEqual(["providers", "servers"]);
    expect(result.localReady).toBe(false);
  });
});

describe("describeUpdateEverything", () => {
  it("gives each machine one row with its T3 Code and provider updates", () => {
    const id = EnvironmentId.make;
    const { rows } = describeUpdateEverything({
      localVersion: "1.1.0",
      localMachines: [
        { environmentId: id("local"), label: "Mainbook" },
        { environmentId: id("wsl"), label: "Mainbook WSL" },
      ],
      servers: [
        {
          environmentId: id("npm"),
          serverLabel: "bb-1",
          selfUpdate: "respawn",
          targetVersion: "1.1.0",
        },
      ],
      providerMachines: [
        { environmentId: id("npm"), label: "bb-1", providers: ["Codex", "Claude"] },
        { environmentId: id("local"), label: "Mainbook", providers: ["Codex"] },
        { environmentId: id("manual"), label: "alvin", providers: ["Claude"] },
      ],
      skipped: [
        { environmentId: id("manual"), label: "alvin", reason: "needs a manual update" },
        { environmentId: id("offline"), label: "TheoRoom", reason: "not connected" },
      ],
    });

    expect(
      rows.map(({ label, app, skipped, providers }) => [label, app, skipped, providers]),
    ).toEqual([
      ["Mainbook", "this-app", null, ["Codex"]],
      ["Mainbook WSL", "this-app", null, []],
      ["bb-1", "server", null, ["Codex", "Claude"]],
      ["alvin", null, "needs a manual update", ["Claude"]],
      ["TheoRoom", null, "not connected", []],
    ]);
  });
});
