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
  type UpdateEverythingMachine,
} from "./updateEverything.logic";
import { installDesktopUpdateNow } from "~/scient/desktopUpdate/updateReadyNotice";

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
  it("updates only remote servers that can move to the target on their channel", () => {
    const targets = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("current", "0.0.50", "boot-service"),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
  });
});

describe("Scient bulk update authority", () => {
  it("requires owned exact artifact availability while retaining remote desktop feed authority", () => {
    const candidates = collectServerUpdateTargets(
      [machine("service", "0.6.1", "boot-service"), machine("desktop", "0.6.1", "desktop-managed")],
      "0.6.2",
    );
    expect(candidates.map((target) => target.serverLabel)).toEqual(["service", "desktop"]);
    expect(supportedBulkServerTargets(candidates).map((target) => target.serverLabel)).toEqual([
      "desktop",
    ]);
    expect(
      supportedBulkServerTargets(candidates, false).map((target) => target.serverLabel),
    ).toEqual(["desktop"]);
    expect(supportedBulkServerTargets(candidates, true)).toEqual(candidates);
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
    const servers = collectServerUpdateTargets(machines, "0.0.50").filter((target) =>
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
    const targets = collectServerUpdateTargets([optedIn], "0.6.2");
    expect(targets[0]?.threadContinuation).toBe(false);
    expect(targets[0]?.continueThreadsAfterServerUpdate).toBe(true);
    expect(collectRestartingMachines([optedIn], targets, false)).toEqual([
      { environmentId: "remote", continuesThreads: false },
    ]);
  });
});

describe("runUpdateEverything", () => {
  it("composes bulk and explicit install actions through the one Scient installer", async () => {
    const state: DesktopUpdateState = {
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
        return { accepted: true, completed: true, state };
      },
    };
    const run = runUpdateEverything({
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
      installLocal: () => installDesktopUpdateNow(shell),
    });
    await started;
    const explicitRestart = installDesktopUpdateNow(shell);
    finishInstall();
    await Promise.all([run, explicitRestart]);
    expect(calls).toEqual(["download", "providers", "servers", "install"]);
  });

  it("restarts servers after providers finish and installs this app last", async () => {
    const calls: string[] = [];
    let finishProviders = () => {};
    const run = runUpdateEverything({
      downloadLocal: async () => {
        calls.push("download");
        return true;
      },
      updateProviders: () =>
        new Promise<void>((resolve) => {
          calls.push("providers");
          finishProviders = resolve;
        }),
      updateServers: async () => {
        calls.push("servers");
      },
      installLocal: async () => {
        calls.push("install");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["download", "providers"]);
    finishProviders();
    await run;
    expect(calls).toEqual(["download", "providers", "servers", "install"]);
  });

  it("still updates remote machines when the local download fails", async () => {
    const calls: string[] = [];
    await runUpdateEverything({
      downloadLocal: async () => false,
      updateProviders: async () => {
        calls.push("providers");
      },
      updateServers: async () => {
        calls.push("servers");
      },
      installLocal: async () => {
        calls.push("install");
      },
    });

    expect(calls).toEqual(["providers", "servers"]);
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
