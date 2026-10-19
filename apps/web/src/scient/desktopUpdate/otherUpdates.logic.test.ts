import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ServerUpdateTarget } from "~/components/ServerUpdateAction";
import type {
  UpdateEverythingMachine,
  UpdateEverythingRun,
} from "~/components/sidebar/updateEverything.logic";
import {
  buildOtherUpdateRows,
  collectOtherServerUpdates,
  failedUpdateRunServer,
  collectProviderUpdateItems,
  deriveOtherUpdateRowState,
  isSelfUpdatingSshRemote,
  isThreadRunning,
  machineHasUpdatesRunning,
  isUpdateRunActive,
  managedUpdateLive,
  otherUpdateProgressLabel,
  otherUpdatesCircleState,
  otherUpdateVersionLabel,
  providerUpdateLive,
  serverUpdateItem,
  serverUpdateLive,
  stopsThreadsLabel,
  trackUpdatingRows,
  type OtherUpdateItem,
  type OtherUpdateRow,
} from "./otherUpdates.logic";

const local = EnvironmentId.make("local");
const lab = EnvironmentId.make("lab");

function provider(
  patch: Omit<Partial<ServerProvider>, "driver"> & { readonly driver?: string } = {},
): ServerProvider {
  const { driver = "codex", ...rest } = patch;
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-10-18T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...rest,
  };
}

function behindCli(oneClick: boolean, patch: Partial<ServerProvider> = {}): ServerProvider {
  return provider({
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: oneClick ? "npm i -g codex" : null,
      canUpdate: oneClick,
      checkedAt: null,
      message: null,
    },
    ...patch,
  });
}

function managed(operation: Partial<ProviderRuntimeOperation> | null = null): ServerProvider {
  return provider({
    driver: "omp",
    connection: {
      methods: [],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "linux-x64",
        actions: ["update"],
        managedVersion: "2.0.0",
        availableManagedVersion: "2.1.0",
        previousManagedVersion: null,
        message: "Managed.",
        operation: operation && {
          operationId: "op-1",
          action: "update",
          status: "downloading",
          startedAt: "2026-10-18T10:00:00.000Z",
          finishedAt: null,
          message: "Downloading.",
          ...operation,
        },
      },
    },
  });
}

const serverTarget: ServerUpdateTarget = {
  environmentId: lab,
  serverLabel: "lab-gpu",
  selfUpdate: "boot-service",
  targetVersion: "0.6.21",
};

function machine(
  id: EnvironmentId,
  patch: {
    readonly selfUpdate?: "boot-service" | "respawn" | "desktop-managed" | null;
    readonly desktopAppUpdate?: boolean;
    readonly serverVersion?: string;
  } = {},
): UpdateEverythingMachine {
  return {
    environmentId: id,
    label: id,
    serverConfig: {
      environment: {
        environmentId: id,
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion: patch.serverVersion ?? "0.6.20",
        capabilities: {
          repositoryIdentity: true,
          ...(patch.selfUpdate ? { serverSelfUpdate: patch.selfUpdate } : {}),
          ...(patch.desktopAppUpdate ? { desktopAppUpdate: true } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    } as UpdateEverythingMachine["serverConfig"],
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
  };
}

function row(item: OtherUpdateItem, state: OtherUpdateRow["state"]): OtherUpdateRow {
  return { item, state };
}

function passRun(
  patch: Partial<UpdateEverythingRun["machines"][number]> = {},
  phase: UpdateEverythingRun["phase"] = "servers",
): UpdateEverythingRun {
  return {
    localVersion: null,
    phase,
    restartAt: null,
    machines: [
      {
        environmentId: lab,
        label: "lab-gpu",
        updatesProviders: false,
        server: serverTarget,
        handedOffVersion: null,
        startedAt: 0,
        result: null,
        failure: null,
        providerFailure: null,
        ...patch,
      },
    ],
  };
}

describe("items", () => {
  it("lists one-click provider CLIs and managed runtimes, naming the machine only when remote", () => {
    const items = collectProviderUpdateItems([
      { environmentId: local, label: "This Mac", isLocal: true, providers: [behindCli(true)] },
      {
        environmentId: lab,
        label: "lab-gpu",
        isLocal: false,
        providers: [behindCli(true), managed()],
      },
    ]);
    expect(
      items.map(({ kind, name, machine, fromVersion, toVersion }) => ({
        kind,
        name,
        machine,
        fromVersion,
        toVersion,
      })),
    ).toEqual([
      { kind: "provider", name: "Codex", machine: null, fromVersion: "1.0.0", toVersion: "1.1.0" },
      {
        kind: "provider",
        name: "Codex",
        machine: "lab-gpu",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      },
      {
        kind: "managed",
        name: expect.any(String),
        machine: "lab-gpu",
        fromVersion: "2.0.0",
        toVersion: "2.1.0",
      },
    ]);
    expect(otherUpdateVersionLabel(items[0]!)).toBe("1.0.0 → 1.1.0");
  });

  it("leaves updates Scient cannot run itself to Settings", () => {
    expect(
      collectProviderUpdateItems([
        { environmentId: lab, label: "lab", isLocal: false, providers: [behindCli(false)] },
      ]),
    ).toEqual([]);
    expect(otherUpdatesCircleState([])).toBeNull();
  });

  it("keeps a managed runtime listed while its update runs", () => {
    expect(
      collectProviderUpdateItems([
        {
          environmentId: lab,
          label: "lab",
          isLocal: false,
          providers: [managed({ status: "installing" })],
        },
      ]).map(({ kind }) => kind),
    ).toEqual(["managed"]);
  });

  it("lists the servers a pass may update with the version each runs", () => {
    const [update] = collectOtherServerUpdates(
      [machine(lab, { selfUpdate: "boot-service" })],
      [serverTarget],
    );
    expect(serverUpdateItem(update!)).toMatchObject({
      name: "lab-gpu server",
      machine: null,
      fromVersion: "0.6.20",
      toVersion: "0.6.21",
      target: serverTarget,
    });
    const [app] = collectOtherServerUpdates(
      [],
      [{ ...serverTarget, selfUpdate: "desktop-managed" }],
    );
    expect(serverUpdateItem(app!)).toMatchObject({ name: "lab-gpu app", fromVersion: null });
  });

  it("recognizes an SSH remote launched from this app's package", () => {
    const config = (selfUpdate: "boot-service" | null) =>
      machine(lab, { selfUpdate }).serverConfig as never;
    expect(
      isSelfUpdatingSshRemote({
        entry: { target: { _tag: "SshConnectionTarget" } },
        serverConfig: config(null),
      }),
    ).toBe(true);
    expect(
      isSelfUpdatingSshRemote({
        entry: { target: { _tag: "SshConnectionTarget" } },
        serverConfig: config("boot-service"),
      }),
    ).toBe(false);
    expect(
      isSelfUpdatingSshRemote({
        entry: { target: { _tag: "BearerConnectionTarget" } },
        serverConfig: config(null),
      }),
    ).toBe(false);
  });
});

describe("live state", () => {
  it("reports a real percentage for managed downloads, otherwise the phase", () => {
    expect(
      managedUpdateLive(
        managed({ status: "downloading", downloadedBytes: 42, totalBytes: 100 }),
        undefined,
      ),
    ).toEqual({ status: "active", progress: { percent: 42 } });
    expect(otherUpdateProgressLabel({ percent: 42 })).toBe("42%");
    expect(managedUpdateLive(managed({ status: "verifying" }), undefined)).toEqual({
      status: "active",
      progress: { phase: "installing" },
    });
    expect(
      managedUpdateLive(managed({ status: "activating", waitingForIdle: true }), undefined),
    ).toEqual({ status: "waiting" });
    expect(
      providerUpdateLive(
        behindCli(true, {
          updateState: {
            status: "running",
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ),
    ).toEqual({ status: "active", progress: { phase: "installing" } });
    expect(
      serverUpdateLive({
        status: "running",
        stage: "resuming",
        fromVersion: "1",
        targetVersion: "2",
      }),
    ).toEqual({ status: "active", progress: { phase: "restarting" } });
  });

  it("prefers a later operation started elsewhere over this client's finished run", () => {
    const run = {
      target: {
        environmentId: lab,
        environmentLabel: "lab",
        instanceId: ProviderInstanceId.make("omp"),
        driver: ProviderDriverKind.make("omp"),
        availableVersion: "2.1.0",
      },
      operationId: "op-0",
      observed: true,
      outcome: { status: "failed" as const, message: "Old failure." },
      waitingMessage: null,
    };
    expect(managedUpdateLive(managed({ status: "succeeded" }), run)).toEqual({
      status: "succeeded",
    });
    expect(managedUpdateLive(managed(null), run)).toEqual({
      status: "failed",
      reason: "Old failure.",
    });
  });
});

describe("rows", () => {
  const [cli] = collectProviderUpdateItems([
    { environmentId: lab, label: "lab", isLocal: false, providers: [behindCli(true)] },
  ]);
  const server = serverUpdateItem({
    environmentId: lab,
    label: "lab-gpu",
    app: false,
    fromVersion: "0.6.20",
    toVersion: "0.6.21",
    target: serverTarget,
  });
  const newerServer = serverUpdateItem({
    environmentId: lab,
    label: "lab-gpu",
    app: false,
    fromVersion: "0.6.20",
    toVersion: "0.6.22",
    target: { ...serverTarget, targetVersion: "0.6.22" },
  });
  const base = {
    listed: true,
    live: { status: "idle" } as const,
    tracked: undefined,
    runProgress: null,
    runFailure: null,
    qualifiedServers: [serverTarget],
  };

  it("derives idle, updating, waiting, done and failed rows", () => {
    expect(deriveOtherUpdateRowState({ ...base, item: cli! })).toEqual({ status: "idle" });
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: cli!,
        tracked: { item: cli!, action: { status: "pending" } },
      }),
    ).toEqual({ status: "updating", progress: { phase: "installing" } });
    // A server waits for its machine's provider updates before it restarts.
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: server,
        tracked: { item: server, action: { status: "pending" } },
      }),
    ).toEqual({ status: "updating", progress: { phase: "queued" } });
    expect(deriveOtherUpdateRowState({ ...base, item: cli!, live: { status: "waiting" } })).toEqual(
      { status: "waiting" },
    );
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: cli!,
        listed: false,
        tracked: { item: cli!, action: null },
      }),
    ).toEqual({ status: "done" });
    expect(deriveOtherUpdateRowState({ ...base, item: cli!, listed: false })).toBeNull();
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: cli!,
        live: { status: "failed", reason: "npm exited 1" },
      }),
    ).toEqual({ status: "failed", reason: "npm exited 1", retry: true });
  });

  it("retries a failed server only while its attempted version and mechanism are qualified", () => {
    const failed = {
      status: "failed",
      reason: "Did not resume.",
      targetVersion: "0.6.21",
    } as const;
    expect(deriveOtherUpdateRowState({ ...base, item: server, live: failed })).toEqual({
      status: "failed",
      reason: "Did not resume.",
      retry: true,
    });
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: server,
        live: failed,
        listed: false,
        qualifiedServers: [],
      }),
    ).toEqual({ status: "failed", reason: "Did not resume.", retry: false });
  });

  it("offers a newer server update after a failure for an older one", () => {
    // The card's own failure is bound to the target it attempted.
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: newerServer,
        tracked: { item: server, action: { status: "failed", reason: "Did not resume." } },
        qualifiedServers: [newerServer.kind === "server" ? newerServer.target : serverTarget],
      }),
    ).toEqual({ status: "idle" });
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: server,
        live: { status: "failed", reason: "Old.", targetVersion: "0.6.19" },
      }),
    ).toEqual({ status: "idle" });
    // Another mechanism is a new update too.
    const appServer = serverUpdateItem({
      environmentId: lab,
      label: "lab-gpu",
      app: true,
      fromVersion: "0.6.20",
      toVersion: "0.6.21",
      target: { ...serverTarget, selfUpdate: "desktop-managed" },
    });
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: appServer,
        tracked: { item: server, action: { status: "failed", reason: "x" } },
      }),
    ).toEqual({ status: "idle" });
  });

  it("reports a pass's withdrawn server as failed, never done, with eligible Retry", () => {
    const withdrawn = passRun({
      result: "failed",
      failure: "Not updated; it was no longer eligible when servers updated.",
    });
    expect(failedUpdateRunServer(withdrawn, lab)).toEqual({
      reason: "Not updated; it was no longer eligible when servers updated.",
      target: serverTarget,
    });
    const states = (qualified: ServerUpdateTarget[]) =>
      buildOtherUpdateRows({
        items: [],
        tracked: new Map([[server.key, { item: server, action: null }]]),
        liveOf: () => ({ status: "idle" }),
        run: withdrawn,
        qualifiedServers: qualified,
        environments: new Set([lab]),
      }).map(({ state }) => state);
    expect(states([])).toEqual([
      {
        status: "failed",
        reason: "Not updated; it was no longer eligible when servers updated.",
        retry: false,
      },
    ]);
    expect(states([serverTarget])).toMatchObject([{ status: "failed", retry: true }]);
    // A server the pass updated keeps no record of its server failure.
    expect(failedUpdateRunServer(passRun({ result: "failed", server: null }), lab)).toBeNull();
  });

  it("drops rows of a removed machine but keeps a disconnected one's failure", () => {
    const tracked = new Map([
      [server.key, { item: server, action: { status: "failed" as const, reason: "x" } }],
    ]);
    const rows = (environments: ReadonlySet<EnvironmentId>) =>
      buildOtherUpdateRows({
        items: [],
        tracked,
        liveOf: () => ({ status: "idle" }),
        run: null,
        qualifiedServers: [],
        environments,
      });
    expect(rows(new Set([lab]))).toMatchObject([{ state: { status: "failed", retry: false } }]);
    expect(rows(new Set())).toEqual([]);
    // Its tracking is then forgotten.
    expect([...trackUpdatingRows(tracked, rows(new Set()), new Set())!.keys()]).toEqual([]);
  });

  it("keeps finished rows until forgotten and tracks rows seen updating", () => {
    const rows = buildOtherUpdateRows({
      items: [cli!],
      tracked: new Map([[server.key, { item: server, action: null }]]),
      liveOf: (item) =>
        item.kind === "provider"
          ? { status: "active", progress: { phase: "installing" } }
          : { status: "idle" },
      run: null,
      qualifiedServers: [],
      environments: new Set([lab]),
    });
    expect(rows.map(({ item, state }) => [item.key, state.status])).toEqual([
      [cli!.key, "updating"],
      [server.key, "done"],
    ]);
    const tracked = trackUpdatingRows(new Map(), rows, new Set([cli!.key]));
    expect([...tracked!.keys()]).toEqual([cli!.key]);
    expect(trackUpdatingRows(tracked!, rows, new Set([cli!.key]))).toBeNull();
  });

  it("summarizes the circle", () => {
    expect(otherUpdatesCircleState([row(cli!, { status: "done" })])).toBe("done");
    expect(
      otherUpdatesCircleState([row(cli!, { status: "done" }), row(server, { status: "waiting" })]),
    ).toBe("idle");
    expect(
      otherUpdatesCircleState([
        row(cli!, { status: "failed", reason: "x", retry: true }),
        row(server, { status: "idle" }),
      ]),
    ).toBe("failed");
    expect(
      otherUpdatesCircleState([
        row(cli!, { status: "failed", reason: "x", retry: true }),
        row(server, { status: "updating", progress: { phase: "downloading" } }),
      ]),
    ).toBe("updating");
  });

  it("queues a pass's servers until they start and follows them after a relaunch", () => {
    const states = (value: UpdateEverythingRun) =>
      buildOtherUpdateRows({
        items: [cli!, server],
        tracked: new Map(),
        liveOf: () => ({ status: "idle" }),
        run: value,
        qualifiedServers: [serverTarget],
        environments: new Set([lab]),
      }).map(({ state }) => state);
    expect(states(passRun({ updatesProviders: true }, "providers"))).toEqual([
      { status: "updating", progress: { phase: "queued" } },
      { status: "updating", progress: { phase: "queued" } },
    ]);
    expect(states(passRun({ server: null, handedOffVersion: "0.6.21" }))[1]).toEqual({
      status: "updating",
      progress: { phase: "restarting" },
    });
  });

  it("names the running threads a server update would stop", () => {
    expect(stopsThreadsLabel(1)).toBe("Stops 1 running thread");
    expect(stopsThreadsLabel(2)).toBe("Stops 2 running threads");
  });
});

describe("isUpdateRunActive", () => {
  const settled = passRun({ result: "failed", failure: "x" });
  it("treats a finished pass that kept its failures as idle", () => {
    expect(isUpdateRunActive(null)).toBe(false);
    expect(isUpdateRunActive(settled)).toBe(false);
    expect(isUpdateRunActive({ ...settled, phase: "providers" })).toBe(true);
    expect(isUpdateRunActive({ ...settled, localVersion: "0.6.21" })).toBe(true);
  });
});

describe("machineHasUpdatesRunning", () => {
  const updating = (status: "queued" | "running" | "succeeded" | "failed") =>
    behindCli(true, {
      updateState: { status, startedAt: null, finishedAt: null, message: null, output: null },
    });
  const managedRun = (patch: { operationId?: string | null; waitingMessage?: string | null }) => ({
    target: {
      environmentId: lab,
      environmentLabel: "lab",
      instanceId: ProviderInstanceId.make("omp"),
      driver: ProviderDriverKind.make("omp"),
      availableVersion: "2.1.0",
    },
    operationId: patch.operationId === undefined ? "op-1" : patch.operationId,
    observed: true,
    outcome: { status: "pending" as const },
    waitingMessage: patch.waitingMessage ?? null,
  });
  const busy = (input: Partial<Parameters<typeof machineHasUpdatesRunning>[0]>) =>
    machineHasUpdatesRunning({ providers: [], managedRuns: [], startsPending: false, ...input });

  it("holds a server while a provider CLI update is queued or running", () => {
    expect(busy({ providers: [updating("queued")] })).toBe(true);
    expect(busy({ providers: [updating("running")] })).toBe(true);
    expect(busy({ providers: [updating("succeeded"), updating("failed")] })).toBe(false);
  });

  it("holds a server while a managed runtime update starts or runs, not once staged", () => {
    expect(busy({ providers: [managed({ status: "preparing" })] })).toBe(true);
    expect(busy({ providers: [managed({ status: "downloading" })] })).toBe(true);
    expect(busy({ providers: [managed({ status: "activating", waitingForIdle: true })] })).toBe(
      false,
    );
    expect(busy({ providers: [managed({ status: "succeeded" })] })).toBe(false);
    expect(busy({ managedRuns: [managedRun({ operationId: null })] })).toBe(true);
    expect(busy({ managedRuns: [managedRun({})] })).toBe(true);
    expect(busy({ managedRuns: [managedRun({ waitingMessage: "Waiting for a turn." })] })).toBe(
      false,
    );
  });

  it("holds a server while this card is starting a provider update there", () => {
    expect(busy({ startsPending: true })).toBe(true);
    expect(busy({})).toBe(false);
  });
});

describe("isThreadRunning", () => {
  it("counts a running turn even while a follow-up is queued behind it", () => {
    expect(
      isThreadRunning({ activeRunId: "run-1", activityRunStatus: "running", status: "queued" }),
    ).toBe(true);
    expect(isThreadRunning({ activeRunId: null, activityRunStatus: null, status: "queued" })).toBe(
      false,
    );
    expect(
      isThreadRunning({ activeRunId: "run-1", activityRunStatus: "waiting", status: "waiting" }),
    ).toBe(false);
  });

  it("falls back to the latest run on servers without activity runs", () => {
    expect(isThreadRunning({ activeRunId: null, status: "running" })).toBe(true);
    expect(isThreadRunning({ activeRunId: null, status: "idle" })).toBe(false);
  });
});
