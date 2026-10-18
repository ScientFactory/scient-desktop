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
  collectProviderUpdateItems,
  deriveOtherUpdateRowState,
  isSelfUpdatingSshRemote,
  isUpdateRunActive,
  managedUpdateLive,
  otherUpdateProgressLabel,
  otherUpdatesCircleState,
  otherUpdateVersionLabel,
  providerUpdateLive,
  serverUpdateItem,
  serverUpdateLive,
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

describe("items", () => {
  it("lists provider CLIs and managed runtimes, naming the machine only when remote", () => {
    const items = collectProviderUpdateItems([
      { environmentId: local, label: "This Mac", isLocal: true, providers: [behindCli(true)] },
      {
        environmentId: lab,
        label: "lab-gpu",
        isLocal: false,
        providers: [behindCli(false), managed()],
      },
    ]);
    expect(
      items.map(({ kind, name, machine, fromVersion, toVersion, manual }) => ({
        kind,
        name,
        machine,
        fromVersion,
        toVersion,
        manual,
      })),
    ).toEqual([
      {
        kind: "provider",
        name: "Codex",
        machine: null,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        manual: false,
      },
      {
        kind: "provider",
        name: "Codex",
        machine: "lab-gpu",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        manual: true,
      },
      {
        kind: "managed",
        name: expect.any(String),
        machine: "lab-gpu",
        fromVersion: "2.0.0",
        toVersion: "2.1.0",
        manual: false,
      },
    ]);
    expect(otherUpdateVersionLabel(items[0]!)).toBe("1.0.0 → 1.1.0");
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

  it("lists qualified servers with an action and owner-only servers as manual", () => {
    const updates = collectOtherServerUpdates({
      machines: [
        machine(lab, { selfUpdate: "boot-service" }),
        machine(EnvironmentId.make("bare"), { selfUpdate: null }),
        machine(EnvironmentId.make("old-app"), { selfUpdate: "desktop-managed" }),
        machine(EnvironmentId.make("ssh"), { selfUpdate: null }),
        machine(EnvironmentId.make("nightly"), {
          selfUpdate: null,
          serverVersion: "0.6.20-nightly.20261001.1",
        }),
        machine(EnvironmentId.make("current"), { selfUpdate: null, serverVersion: "0.6.21" }),
      ],
      behind: [
        serverTarget,
        {
          ...serverTarget,
          environmentId: EnvironmentId.make("respawn"),
          serverLabel: "respawn",
          selfUpdate: "respawn",
        },
      ],
      qualified: [serverTarget],
      targetVersion: "0.6.21",
      selfUpdating: new Set([EnvironmentId.make("ssh")]),
    });
    expect(updates.map(({ label, app, target }) => [label, app, target !== null])).toEqual([
      ["lab-gpu", false, true],
      ["respawn", false, false],
      ["bare", false, false],
      ["old-app", true, false],
    ]);
    expect(serverUpdateItem(updates[0]!)).toMatchObject({
      name: "lab-gpu server",
      machine: null,
      fromVersion: "0.6.20",
      toVersion: "0.6.21",
      manual: false,
    });
    expect(serverUpdateItem(updates[3]!)).toMatchObject({ name: "old-app app", manual: true });
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
    const downloading = managedUpdateLive(
      managed({ status: "downloading", downloadedBytes: 42, totalBytes: 100 }),
      undefined,
    );
    expect(downloading).toEqual({ status: "active", progress: { percent: 42 } });
    expect(otherUpdateProgressLabel({ percent: 42 })).toBe("42%");
    expect(managedUpdateLive(managed({ status: "verifying" }), undefined)).toEqual({
      status: "active",
      progress: { phase: "installing" },
    });
    expect(
      managedUpdateLive(managed({ status: "activating", waitingForIdle: true }), undefined),
    ).toEqual({
      status: "waiting",
    });
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
    ).toEqual({
      status: "active",
      progress: { phase: "installing" },
    });
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
  const base = {
    listed: true,
    live: { status: "idle" } as const,
    tracked: undefined,
    runProgress: null,
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
    expect(
      deriveOtherUpdateRowState({ ...base, item: server, runProgress: { phase: "queued" } }),
    ).toEqual({ status: "updating", progress: { phase: "queued" } });
    expect(deriveOtherUpdateRowState({ ...base, item: cli!, live: { status: "waiting" } })).toEqual(
      {
        status: "waiting",
      },
    );
    // Seen updating and now gone from the list: finished.
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: cli!,
        listed: false,
        tracked: { item: cli!, action: null },
      }),
    ).toEqual({ status: "done" });
    // Gone without being seen updating: nothing to report.
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
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: server,
        live: failed,
        qualifiedServers: [{ ...serverTarget, selfUpdate: "desktop-managed" }],
      }),
    ).toMatchObject({ status: "failed", retry: false });
    // A failure for an older version than the one now offered is history.
    expect(
      deriveOtherUpdateRowState({
        ...base,
        item: server,
        live: { ...failed, targetVersion: "0.6.19" },
      }),
    ).toEqual({ status: "idle" });
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
    });
    expect(rows.map(({ item, state }) => [item.key, state.status])).toEqual([
      [cli!.key, "updating"],
      [server.key, "done"],
    ]);
    const tracked = trackUpdatingRows(new Map(), rows, new Set([cli!.key]));
    expect([...tracked!.keys()]).toEqual([cli!.key]);
    expect(trackUpdatingRows(tracked!, rows, new Set([cli!.key]))).toBeNull();
    // A tracked item that no longer has a row is forgotten.
    expect([...trackUpdatingRows(tracked!, [], new Set())!.keys()]).toEqual([]);
  });

  it("summarizes the circle", () => {
    expect(otherUpdatesCircleState([])).toBeNull();
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
    const run = (patch: Partial<UpdateEverythingRun["machines"][number]>): UpdateEverythingRun => ({
      localVersion: null,
      phase: "providers",
      restartAt: null,
      machines: [
        {
          environmentId: lab,
          label: "lab-gpu",
          updatesProviders: true,
          server: serverTarget,
          handedOffVersion: null,
          startedAt: 0,
          result: null,
          failure: null,
          providerFailure: null,
          ...patch,
        },
      ],
    });
    const states = (value: UpdateEverythingRun) =>
      buildOtherUpdateRows({
        items: [cli!, server],
        tracked: new Map(),
        liveOf: () => ({ status: "idle" }),
        run: value,
        qualifiedServers: [serverTarget],
      }).map(({ state }) => state);
    expect(states(run({}))).toEqual([
      { status: "updating", progress: { phase: "queued" } },
      { status: "updating", progress: { phase: "queued" } },
    ]);
    expect(
      states(run({ server: null, handedOffVersion: "0.6.21", updatesProviders: false }))[1],
    ).toEqual({ status: "updating", progress: { phase: "restarting" } });
  });
});

describe("isUpdateRunActive", () => {
  const settled: UpdateEverythingRun = {
    localVersion: null,
    phase: "servers",
    restartAt: null,
    machines: [
      {
        environmentId: lab,
        label: "lab",
        updatesProviders: false,
        server: serverTarget,
        handedOffVersion: null,
        startedAt: 0,
        result: "failed",
        failure: "x",
        providerFailure: null,
      },
    ],
  };
  it("treats a finished pass that kept its failures as idle", () => {
    expect(isUpdateRunActive(null)).toBe(false);
    expect(isUpdateRunActive(settled)).toBe(false);
    expect(isUpdateRunActive({ ...settled, phase: "providers" })).toBe(true);
    expect(isUpdateRunActive({ ...settled, localVersion: "0.6.21" })).toBe(true);
  });
});
