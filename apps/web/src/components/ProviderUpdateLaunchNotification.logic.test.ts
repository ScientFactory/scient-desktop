import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  canOneClickUpdateProviderCandidate,
  getProviderUpdateRunToastView,
  getProviderUpdateSidebarPillView,
  hasOneClickUpdateProviderCandidate,
  isProviderSettingsUpdateCandidate,
  isProviderUpdateCandidate,
  type ProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";
import {
  collectManagedRuntimeUpdateCandidates,
  getManagedRuntimeUpdateResultToastView,
  getManagedRuntimeUpdateRunningToastView,
  getManagedRuntimeUpdateWaitingToastView,
  isManagedRuntimeUpdateCandidate,
  managedRuntimeUpdateTargetKey,
  managedRuntimeUpdateTargets,
  resolveManagedRuntimeUpdateOutcome,
  settleManagedRuntimeUpdateRuns,
  type ManagedRuntimeUpdateRun,
  type ManagedRuntimeUpdateTarget,
} from "../scient/providerConnection/ManagedRuntimeUpdateNotification.logic";

const checkedAt = "2026-04-23T10:00:00.000Z";
const sessionStartedAt = "2026-04-23T09:59:00.000Z";
const laterCheckedAt = "2026-04-23T10:01:00.000Z";

const driver = (value: string) => ProviderDriverKind.make(value);
const instanceId = (value: string) => ProviderInstanceId.make(value);

function provider(input: {
  readonly driver: ReturnType<typeof ProviderDriverKind.make>;
  readonly instanceId?: ReturnType<typeof ProviderInstanceId.make>;
  readonly enabled?: boolean;
  readonly version?: string | null;
  readonly latestVersion?: string | null;
  readonly canUpdate?: boolean;
  readonly updateCommand?: string | null;
  readonly updateState?: ServerProvider["updateState"];
  readonly advisoryStatus?: NonNullable<ServerProvider["versionAdvisory"]>["status"];
  readonly runtimeSource?: "scient_managed" | "system";
  readonly runtimeActions?: ReadonlyArray<"install" | "update" | "repair" | "remove">;
  readonly managedVersion?: string | null;
  readonly availableManagedVersion?: string | null;
}): ServerProvider {
  const result: ServerProvider = {
    instanceId: input.instanceId ?? instanceId(String(input.driver)),
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: input.version ?? "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.runtimeSource
      ? {
          connection: {
            methods: [],
            canDisconnect: false,
            operation: null,
            runtime: {
              source: input.runtimeSource,
              supportTier: "fully_assisted",
              target: "darwin-arm64",
              actions: input.runtimeActions ?? [],
              managedVersion:
                input.runtimeSource === "scient_managed"
                  ? (input.managedVersion ?? "1.0.0")
                  : (input.managedVersion ?? null),
              availableManagedVersion:
                input.availableManagedVersion ??
                (input.runtimeActions?.includes("update") ? "1.1.0" : null),
              previousManagedVersion: null,
              operation: null,
              message: "Runtime ready.",
            },
          },
        }
      : {}),
    versionAdvisory: {
      status: input.advisoryStatus ?? "behind_latest",
      currentVersion: input.version ?? "1.0.0",
      latestVersion: "latestVersion" in input ? input.latestVersion : "1.1.0",
      updateCommand: "updateCommand" in input ? input.updateCommand : "npm install -g provider",
      canUpdate: input.canUpdate ?? true,
      checkedAt,
      message: "Update available.",
    },
  };

  if (input.updateState) {
    return { ...result, updateState: input.updateState };
  }

  return result;
}

function updateCandidate(input: Parameters<typeof provider>[0]): ProviderUpdateCandidate {
  return provider(input) as ProviderUpdateCandidate;
}

describe("provider update launch notification logic", () => {
  it("detects enabled providers with a latest-version advisory", () => {
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex") }))).toBe(true);
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex"), enabled: false }))).toBe(
      false,
    );
    expect(
      isProviderUpdateCandidate(
        provider({ driver: driver("codex"), advisoryStatus: "current", latestVersion: null }),
      ),
    ).toBe(false);
    expect(
      isProviderUpdateCandidate(provider({ driver: driver("codex"), latestVersion: null })),
    ).toBe(false);
    expect(
      isProviderUpdateCandidate(
        provider({ driver: driver("codex"), runtimeSource: "scient_managed" }),
      ),
    ).toBe(false);
    expect(
      isProviderUpdateCandidate(provider({ driver: driver("codex"), runtimeSource: "system" })),
    ).toBe(true);
  });

  it("detects managed updates only from active Scient lifecycle capabilities", () => {
    const managed = provider({
      driver: driver("codex"),
      runtimeSource: "scient_managed",
      runtimeActions: ["update", "repair", "remove"],
      managedVersion: "0.155.1",
      availableManagedVersion: "0.156.1",
    });
    expect(isManagedRuntimeUpdateCandidate(managed)).toBe(true);
    expect(
      isManagedRuntimeUpdateCandidate({
        ...managed,
        enabled: false,
      }),
    ).toBe(false);
    expect(
      isManagedRuntimeUpdateCandidate({
        ...managed,
        connection: {
          ...managed.connection!,
          runtime: { ...managed.connection!.runtime!, actions: ["repair", "remove"] },
        },
      }),
    ).toBe(false);
    expect(
      isManagedRuntimeUpdateCandidate({
        ...managed,
        connection: {
          ...managed.connection!,
          runtime: {
            ...managed.connection!.runtime!,
            operation: {
              operationId: "op-update",
              action: "update",
              status: "downloading",
              startedAt: checkedAt,
              finishedAt: null,
              message: "Downloading update.",
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("captures managed versions while the live update key identifies the machine and runtime", () => {
    const managed = provider({
      driver: driver("codex"),
      runtimeSource: "scient_managed",
      runtimeActions: ["update"],
      managedVersion: "0.155.1",
      availableManagedVersion: "0.156.1",
    });
    const groups = [
      {
        environmentId: "local:windows" as EnvironmentId,
        label: "Windows",
        providers: [managed, provider({ driver: driver("cursor"), runtimeSource: "system" })],
      },
    ];
    const candidates = collectManagedRuntimeUpdateCandidates(groups);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      environmentLabel: "Windows",
      installedVersion: "0.155.1",
      availableVersion: "0.156.1",
      provider: { driver: "codex" },
    });
    const [target] = managedRuntimeUpdateTargets(candidates);
    expect(target).toBeDefined();
    const key = managedRuntimeUpdateTargetKey(target!);
    const updatedTarget = { ...target!, availableVersion: "0.157.0" };
    expect(managedRuntimeUpdateTargetKey(updatedTarget)).toBe(key);
    expect(
      managedRuntimeUpdateTargetKey({
        ...target!,
        environmentId: EnvironmentId.make("local:other"),
      }),
    ).not.toBe(key);
  });

  it("disables one-click updates when provider instances disagree on the update command", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
    });

    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          latestVersion: "2.1.123",
          canUpdate: true,
          updateCommand: "bun add -g @anthropic-ai/claude-code@latest",
        }),
      ]),
    ).toBe(false);
  });

  it("keeps one-click updates enabled when sibling instances are already current", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
      updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
    });

    expect(
      hasOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
  });

  it("keeps the inline update action available while a provider update is already running", () => {
    const candidate = updateCandidate({
      driver: driver("codex"),
      updateState: {
        status: "running",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Updating provider.",
        output: null,
      },
    });

    expect(hasOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(true);
    expect(canOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(false);
  });

  it("shows the active sidebar pill for an update on a non-default instance", () => {
    const view = getProviderUpdateSidebarPillView([
      provider({ driver: driver("claudeAgent") }),
      provider({
        driver: driver("claudeAgent"),
        instanceId: instanceId("claude_work"),
        updateState: {
          status: "running",
          startedAt: checkedAt,
          finishedAt: null,
          message: "Updating provider.",
          output: null,
        },
      }),
    ]);

    expect(view).toMatchObject({
      key: "loading:claudeAgent:running",
      tone: "loading",
      title: "Updating Claude",
      description: "Claude update in progress.",
    });
  });

  it("shows the latest terminal sidebar pill across instances of a driver", () => {
    const view = getProviderUpdateSidebarPillView(
      [
        provider({
          driver: driver("claudeAgent"),
          updateState: {
            status: "failed",
            startedAt: checkedAt,
            finishedAt: checkedAt,
            message: "Update command exited with code 1.",
            output: null,
          },
        }),
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "1.1.0",
          latestVersion: "1.1.0",
          advisoryStatus: "current",
          updateState: {
            status: "succeeded",
            startedAt: laterCheckedAt,
            finishedAt: laterCheckedAt,
            message: "Provider updated.",
            output: null,
          },
        }),
      ],
      { visibleAfterIso: sessionStartedAt },
    );

    expect(view).toMatchObject({
      key: "succeeded:claudeAgent:2026-04-23T10:01:00.000Z:Provider updated.",
      tone: "success",
      title: "Claude updated: v1.1.0",
    });
  });

  it("does not show sidebar terminal states from before the current app session", () => {
    expect(
      getProviderUpdateSidebarPillView(
        [
          provider({
            driver: driver("codex"),
            updateState: {
              status: "failed",
              startedAt: checkedAt,
              finishedAt: checkedAt,
              message: "command failed",
              output: "stderr",
            },
          }),
        ],
        { visibleAfterIso: "2026-04-23T10:00:01.000Z" },
      ),
    ).toBeNull();
  });

  it("shows a newer success before falling back to an older failure", () => {
    const providers = [
      provider({
        driver: driver("claudeAgent"),
        updateState: {
          status: "failed",
          startedAt: checkedAt,
          finishedAt: checkedAt,
          message: "Update command exited with code 1.",
          output: null,
        },
      }),
      provider({
        driver: driver("codex"),
        version: "1.2.0",
        latestVersion: "1.2.0",
        advisoryStatus: "current",
        updateState: {
          status: "succeeded",
          startedAt: laterCheckedAt,
          finishedAt: laterCheckedAt,
          message: "Provider updated.",
          output: null,
        },
      }),
    ] satisfies ReadonlyArray<ServerProvider>;

    const successView = getProviderUpdateSidebarPillView(providers, {
      visibleAfterIso: sessionStartedAt,
    });
    expect(successView).toMatchObject({
      key: "succeeded:codex:2026-04-23T10:01:00.000Z:Provider updated.",
      tone: "success",
      title: "Codex updated: v1.2.0",
    });

    const failureView = getProviderUpdateSidebarPillView(providers, {
      visibleAfterIso: sessionStartedAt,
      dismissedKeys: new Set(["succeeded:codex:2026-04-23T10:01:00.000Z:Provider updated."]),
    });
    expect(failureView).toMatchObject({
      key: "failed:claudeAgent:2026-04-23T10:00:00.000Z:Update command exited with code 1.",
      tone: "error",
      title: "Claude v1.1.0 update failed",
    });
  });
});

it("does not offer incompatible latest versions and restores suggestions after policy relaxation", () => {
  const installed = provider({ driver: driver("codex") });
  for (const latestVersionStatus of ["broken", "unsupported", "supported", "unknown"] as const) {
    const snapshot: ServerProvider = {
      ...installed,
      compatibilityAdvisory: {
        status: "supported",
        latestVersionStatus,
        message: null,
        recommendedRange: null,
        recommendedVersion: null,
      },
    };
    const expected = latestVersionStatus === "supported" || latestVersionStatus === "unknown";
    expect(isProviderUpdateCandidate(snapshot)).toBe(expected);
    expect(isProviderSettingsUpdateCandidate(snapshot)).toBe(expected);
  }
});

describe("managed runtime one-click updates", () => {
  const macos = "local:macos" as EnvironmentId;
  const wsl = "local:wsl" as EnvironmentId;
  const managedCodex = (patch: { readonly instanceId?: string; readonly source?: "system" } = {}) =>
    provider({
      driver: driver("codex"),
      instanceId: instanceId(patch.instanceId ?? "codex"),
      runtimeSource: patch.source ?? "scient_managed",
      runtimeActions: ["update", "repair", "remove"],
      managedVersion: "0.157.0",
      availableManagedVersion: "0.157.1",
    });
  const withOperation = (
    snapshot: ServerProvider,
    operation: Partial<
      NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>["operation"]
    >,
    managedVersion = "0.157.0",
  ): ServerProvider => ({
    ...snapshot,
    connection: {
      ...snapshot.connection!,
      runtime: {
        ...snapshot.connection!.runtime!,
        managedVersion,
        operation: {
          operationId: "op-1",
          action: "update",
          status: "downloading",
          startedAt: checkedAt,
          finishedAt: null,
          message: "Downloading.",
          ...operation,
        },
      },
    },
  });
  const target: ManagedRuntimeUpdateTarget = {
    environmentId: macos,
    environmentLabel: "macOS",
    instanceId: instanceId("codex"),
    driver: driver("codex"),
    availableVersion: "0.157.1",
  };

  it("offers the update while system Codex stands in for a failed private copy", () => {
    expect(isManagedRuntimeUpdateCandidate(managedCodex({ source: "system" }))).toBe(true);
  });

  it("updates one shared runtime per environment and driver", () => {
    const groups = [
      {
        environmentId: macos,
        label: "macOS",
        providers: [managedCodex(), managedCodex({ instanceId: "codex_work" })],
      },
      {
        environmentId: wsl,
        label: "WSL",
        providers: [managedCodex()],
      },
    ];
    const targets = managedRuntimeUpdateTargets(collectManagedRuntimeUpdateCandidates(groups));
    expect(targets.map(({ environmentId, instanceId }) => [environmentId, instanceId])).toEqual([
      [macos, "codex"],
      [wsl, "codex"],
    ]);
  });

  it("reads the started operation's terminal state", () => {
    const base = managedCodex();
    const resolve = (snapshot: ServerProvider | undefined, observed = true) =>
      resolveManagedRuntimeUpdateOutcome({
        provider: snapshot,
        operationId: "op-1",
        observed,
        expectedVersion: "0.157.1",
      });
    expect(resolve(withOperation(base, {}))).toEqual({ status: "pending" });
    expect(resolve(withOperation(base, { status: "succeeded" }, "0.157.1"))).toEqual({
      status: "succeeded",
      version: "0.157.1",
    });
    expect(
      resolve(withOperation(base, { status: "failed", message: "Checksum mismatch." })),
    ).toEqual({ status: "failed", message: "Checksum mismatch." });
  });

  it("waits for a lagging snapshot, then settles a vanished operation by version", () => {
    const base = managedCodex();
    const resolve = (snapshot: ServerProvider, observed: boolean) =>
      resolveManagedRuntimeUpdateOutcome({
        provider: snapshot,
        operationId: "op-1",
        observed,
        expectedVersion: "0.157.1",
      });
    expect(resolve(base, false)).toEqual({ status: "pending" });
    expect(resolve(withOperation(base, { operationId: "other" }, "0.157.1"), true)).toEqual({
      status: "succeeded",
      version: "0.157.1",
    });
    expect(resolve(base, true)).toMatchObject({ status: "failed" });
  });

  it("marks runs observed from the environment's snapshot before settling them", () => {
    const run: ManagedRuntimeUpdateRun = {
      target,
      operationId: "op-1",
      observed: false,
      outcome: { status: "pending" },
      waitingMessage: null,
    };
    const [inFlight] = settleManagedRuntimeUpdateRuns(
      [run],
      [{ environmentId: macos, providers: [withOperation(managedCodex(), {})] }],
    );
    expect(inFlight).toMatchObject({ observed: true, outcome: { status: "pending" } });
    const [lagging] = settleManagedRuntimeUpdateRuns(
      [run],
      [{ environmentId: macos, providers: [managedCodex()] }],
    );
    expect(lagging).toMatchObject({ observed: false, outcome: { status: "pending" } });
    const failedStart: ManagedRuntimeUpdateRun = {
      ...run,
      operationId: null,
      outcome: { status: "failed", message: "x" },
    };
    expect(settleManagedRuntimeUpdateRuns([failedStart], [])).toEqual([failedStart]);
  });

  it("carries the server's waiting message while a staged update waits for idle", () => {
    const run: ManagedRuntimeUpdateRun = {
      target,
      operationId: "op-1",
      observed: false,
      outcome: { status: "pending" },
      waitingMessage: null,
    };
    const [waiting] = settleManagedRuntimeUpdateRuns(
      [run],
      [
        {
          environmentId: macos,
          providers: [
            withOperation(managedCodex(), {
              status: "activating",
              waitingForIdle: true,
              message: "Waiting for running Codex turns.",
            }),
          ],
        },
      ],
    );
    expect(waiting).toMatchObject({
      waitingMessage: "Waiting for running Codex turns.",
      outcome: { status: "pending" },
    });
  });

  it("does not call an update successful while the system runtime is still in use", () => {
    const standingIn = managedCodex({ source: "system" });
    expect(
      resolveManagedRuntimeUpdateOutcome({
        provider: withOperation(standingIn, { status: "succeeded" }, "0.157.1"),
        operationId: "op-1",
        observed: true,
        expectedVersion: "0.157.1",
      }),
    ).toMatchObject({ status: "failed" });
  });

  it("reports a lost environment instead of waiting forever", () => {
    expect(
      resolveManagedRuntimeUpdateOutcome({
        provider: undefined,
        operationId: "op-1",
        observed: false,
        expectedVersion: "0.157.1",
      }),
    ).toMatchObject({ status: "failed", message: expect.stringContaining("lost contact") });
  });

  it("stays quiet when the user cancels every update", () => {
    const cancelled = resolveManagedRuntimeUpdateOutcome({
      provider: withOperation(managedCodex(), { status: "cancelled" }),
      operationId: "op-1",
      observed: true,
      expectedVersion: "0.157.1",
    });
    expect(cancelled).toEqual({ status: "cancelled" });
    expect(
      getManagedRuntimeUpdateResultToastView([{ target, outcome: { status: "cancelled" } }]),
    ).toBeNull();
  });

  it("names the provider and version in waiting, running, and result notices", () => {
    expect(getManagedRuntimeUpdateWaitingToastView([target], "Waiting for turns.")).toMatchObject({
      title: "Codex will update when idle",
      description: "Waiting for turns.",
    });
    expect(getManagedRuntimeUpdateRunningToastView([target]).title).toBe("Updating Codex v0.157.1");
    expect(
      getManagedRuntimeUpdateResultToastView([
        { target, outcome: { status: "succeeded", version: "0.157.1" } },
      ]),
    ).toMatchObject({ type: "success", title: "Codex updated to v0.157.1" });
    expect(
      getManagedRuntimeUpdateResultToastView([
        { target, outcome: { status: "failed", message: "Checksum mismatch." } },
      ]),
    ).toMatchObject({
      type: "error",
      title: "Codex update failed",
      description: "Checksum mismatch.",
    });
  });
});

describe("getProviderUpdateRunToastView", () => {
  const updateState = (
    status: "succeeded" | "failed",
    message: string,
  ): ServerProvider["updateState"] => ({
    status,
    startedAt: checkedAt,
    finishedAt: laterCheckedAt,
    message,
    output: null,
  });
  const run = (
    machineLabel: string,
    providerDriver: string,
    result: Parameters<typeof getProviderUpdateRunToastView>[0][number]["result"],
  ) => ({
    environmentId: EnvironmentId.make(machineLabel),
    machineLabel,
    driver: driver(providerDriver),
    instanceId: instanceId(providerDriver),
    result,
  });

  it("lists every failed update and ignores interrupted ones", () => {
    const view = getProviderUpdateRunToastView([
      run(
        "Mac Studio",
        "codex",
        AsyncResult.success({
          providers: [
            provider({
              driver: driver("codex"),
              updateState: updateState("succeeded", "Provider updated."),
            }),
          ],
        }),
      ),
      run(
        "Mac Studio",
        "claudeAgent",
        AsyncResult.success({
          providers: [
            provider({
              driver: driver("claudeAgent"),
              updateState: updateState("failed", "npm exited with code 1."),
            }),
          ],
        }),
      ),
      run("Laptop", "codex", AsyncResult.failure(Cause.die(new Error("WebSocket closed")))),
      run("Server", "codex", AsyncResult.failure(Cause.interrupt())),
    ]);

    expect(view).toEqual({
      type: "error",
      title: "2 of 3 provider updates failed",
      description: "Mac Studio · Claude: npm exited with code 1.\nLaptop · Codex: WebSocket closed",
    });
  });
});
