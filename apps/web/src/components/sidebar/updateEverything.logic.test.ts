import {
  EnvironmentId,
  type DesktopUpdateState,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  getUpdateEverythingToastView,
  resolveUpdateRunMachineStatus,
  runUpdateEverything,
  shouldRunUpdateEverything,
  supportedBulkServerTargets,
  unsupportedBulkServerMachines,
  type UpdateEverythingMachine,
  type UpdateRunMachine,
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

  it("keeps Restart direct while preserving bulk download and provider-only entry points", () => {
    expect(shouldRunUpdateEverything(true, false, "install")).toBe(false);
    expect(shouldRunUpdateEverything(true, false, "download")).toBe(true);
    expect(shouldRunUpdateEverything(true, false, "none")).toBe(true);
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
          environment: {
            ...base.serverConfig!.environment,
            capabilities: {
              ...base.serverConfig!.environment.capabilities,
              threadRestartContinuation: true,
              serverUpdateThreadContinuation: true,
            },
          },
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

  it("does not claim remote recovery from preference persistence alone", () => {
    const server = machine("remote", "0.6.1", "boot-service");
    const optedIn = {
      ...server,
      serverConfig: {
        environment: {
          ...server.serverConfig!.environment,
          capabilities: {
            ...server.serverConfig!.environment.capabilities,
            threadRestartContinuation: true,
          },
        },
        settings: { continueThreadsAfterServerUpdate: true },
      },
    };
    const { targets } = collectServerUpdateTargets([optedIn], "0.6.2");
    expect(targets[0]?.threadContinuation).toBe(false);
    expect(targets[0]?.continueThreadsAfterServerUpdate).toBe(true);
    expect(collectRestartingMachines([optedIn], targets, false)).toEqual([
      { environmentId: "remote", continuesThreads: false },
    ]);
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

  it("restarts servers after providers finish and returns every result", async () => {
    const calls: string[] = [];
    let finishProviders = (_value: string) => {};
    const run = runUpdateEverything({
      downloadLocal: async () => {
        calls.push("download");
        return true;
      },
      updateProviders: () =>
        new Promise<string>((resolve) => {
          calls.push("providers");
          finishProviders = resolve;
        }),
      updateServers: async () => {
        calls.push("servers");
        return 2;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["download", "providers"]);
    finishProviders("provider results");
    expect(await run).toEqual({ localReady: true, providers: "provider results", servers: 2 });
    expect(calls).toEqual(["download", "providers", "servers"]);
  });

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

describe("resolveUpdateRunMachineStatus", () => {
  const runMachine = (overrides: Partial<UpdateRunMachine> = {}): UpdateRunMachine => ({
    environmentId: EnvironmentId.make("alvin"),
    label: "alvin",
    updatesProviders: true,
    updatesServer: true,
    result: null,
    ...overrides,
  });
  const running = (stage: "downloading" | "installing" | "resuming") =>
    ({ status: "running", stage, fromVersion: "0.0.40", targetVersion: "0.0.50" }) as const;

  it("follows the run phase, then the server's own update stage", () => {
    const idle = { status: "idle" } as const;
    expect(resolveUpdateRunMachineStatus(runMachine(), "providers", idle)).toBe("providers");
    expect(resolveUpdateRunMachineStatus(runMachine(), "servers", idle)).toBe("waiting");
    expect(resolveUpdateRunMachineStatus(runMachine(), "servers", running("installing"))).toBe(
      "downloading",
    );
    expect(resolveUpdateRunMachineStatus(runMachine(), "servers", running("resuming"))).toBe(
      "restarting",
    );
    expect(
      resolveUpdateRunMachineStatus(
        runMachine({ updatesProviders: false }),
        "providers",
        running("downloading"),
      ),
    ).toBe("downloading");
    expect(resolveUpdateRunMachineStatus(runMachine({ result: "failed" }), "servers", idle)).toBe(
      "failed",
    );
  });
});

describe("update everything summary", () => {
  const result = collectUpdateEverythingResult({
    localVersion: "0.0.50",
    localFailures: ["Could not download update: Network error."],
    servers: [
      { label: "alvin", outcome: { status: "failed", message: "Download failed." } },
      { label: "box", outcome: { status: "updated" } },
      { label: "studio", outcome: { status: "updated" } },
      { label: "busy", outcome: { status: "skipped" } },
    ],
    providers: [
      { status: "updated" },
      { status: "interrupted" },
      { status: "failed", line: "box · Codex: npm exited with code 1." },
    ],
  });

  it("counts updates and names the machine of each failure", () => {
    expect(result).toEqual({
      localVersion: "0.0.50",
      updatedServers: 2,
      updatedProviders: 1,
      failures: [
        "This app: Could not download update: Network error.",
        "alvin: Download failed.",
        "box · Codex: npm exited with code 1.",
      ],
    });
  });

  it("includes this app only when the relaunch landed on its version", () => {
    expect(getUpdateEverythingToastView(result, "0.0.50")).toEqual({
      type: "error",
      title: "Updated this app, 2 servers, and 1 provider",
      description: [
        "This app: Could not download update: Network error.",
        "alvin: Download failed.",
        "box · Codex: npm exited with code 1.",
      ].join("\n"),
    });
    expect(getUpdateEverythingToastView({ ...result, failures: [] }, "0.0.40")).toEqual({
      type: "success",
      title: "Updated 2 servers and 1 provider",
    });
  });

  it("reports a failure when nothing updated, and nothing when nothing finished", () => {
    const empty = { localVersion: null, updatedServers: 0, updatedProviders: 0 };
    expect(
      getUpdateEverythingToastView({ ...empty, failures: ["alvin: offline"] }, "0.0.50"),
    ).toEqual({ type: "error", title: "Update failed", description: "alvin: offline" });
    expect(getUpdateEverythingToastView({ ...empty, failures: [] }, "0.0.50")).toBeNull();
  });
});

describe("describeUpdateEverything", () => {
  it("summarizes the run and lists each machine once", () => {
    const alvin = EnvironmentId.make("alvin");
    expect(
      describeUpdateEverything({
        localVersion: "0.0.50",
        servers: [
          {
            environmentId: alvin,
            serverLabel: "alvin",
            selfUpdate: "boot-service",
            targetVersion: "0.0.50",
          },
          {
            environmentId: EnvironmentId.make("studio"),
            serverLabel: "studio",
            selfUpdate: "desktop-managed",
            targetVersion: "0.0.50",
          },
        ],
        providerMachines: [
          { environmentId: alvin, label: "alvin", providers: ["Codex", "Claude"] },
          { environmentId: EnvironmentId.make("box"), label: "box", providers: ["Cursor"] },
        ],
      }),
    ).toEqual({
      summary: "Update this app, 2 servers, and 3 providers",
      lines: [
        "This app: 0.0.50, restarts last",
        "alvin: server to 0.0.50, Codex, Claude",
        "studio: desktop app update",
        "box: Cursor",
      ],
    });
  });

  it("reads naturally with one kind of update", () => {
    expect(
      describeUpdateEverything({
        localVersion: null,
        servers: [],
        providerMachines: [
          { environmentId: EnvironmentId.make("alvin"), label: "alvin", providers: ["Codex"] },
        ],
      }).summary,
    ).toBe("Update 1 provider");
  });
});
