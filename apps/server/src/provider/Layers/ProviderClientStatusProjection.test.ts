import type {
  ProviderKind,
  ServerProviderRuntimeState,
  ServerProviderStatus,
} from "@synara/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeProviderClientStatusProjection,
  projectProviderClientStatus,
} from "./ProviderClientStatusProjection";

const PROVIDERS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
];

const MISSING_RUNTIME: ServerProviderRuntimeState = {
  source: "missing",
  managedVersion: null,
  canInstall: true,
  canRepair: false,
  canRollback: false,
  canRemove: false,
  message: "No usable provider runtime was found.",
};

function healthStatus(provider: ProviderKind): ServerProviderStatus {
  return {
    provider,
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt: "2026-07-20T16:00:00.000Z",
  };
}

describe("ProviderClientStatusProjection", () => {
  it("enriches both cached and refreshed health snapshots through the same projection", async () => {
    const statuses = PROVIDERS.map(healthStatus);
    let refreshCount = 0;
    const projection = makeProviderClientStatusProjection({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      getHealthStatuses: Effect.succeed(statuses),
      refreshHealthStatuses: Effect.sync(() => {
        refreshCount += 1;
        return statuses;
      }),
      healthChanges: Stream.empty,
      resolveRuntime: (provider) =>
        Effect.succeed({
          source: provider === "pi" ? "bundled" : "missing",
          executable: null,
          managedVersion: null,
          canInstall: provider !== "pi",
          canRepair: false,
          canRollback: false,
          canRemove: false,
          message:
            provider === "pi" ? "Built into Scient." : "No usable provider runtime was found.",
        }),
      getRuntimeSnapshot: (provider) =>
        Effect.succeed({
          provider,
          managedExecutablePath: null,
          managedVersion: null,
          previousReleaseAvailable: false,
          bundled: provider === "pi",
          canInstall: provider !== "pi",
          installationState: null,
        }),
      runtimeChanges: Stream.empty,
    });

    const [cached, refreshed] = await Promise.all([
      Effect.runPromise(projection.getStatuses),
      Effect.runPromise(projection.refreshStatuses),
    ]);

    expect(refreshCount).toBe(1);
    expect(cached).toHaveLength(PROVIDERS.length);
    expect(refreshed).toHaveLength(PROVIDERS.length);
    expect(refreshed.every((status) => status.runtime !== undefined)).toBe(true);
    expect(refreshed.find((status) => status.provider === "antigravity")?.runtime.canInstall).toBe(
      true,
    );
  });

  it.each(["health", "runtime"] as const)(
    "projects complete statuses for %s change streams",
    async (changeSource) => {
      const statuses = [healthStatus("antigravity")];
      const projection = makeProviderClientStatusProjection({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        getHealthStatuses: Effect.succeed(statuses),
        refreshHealthStatuses: Effect.succeed(statuses),
        healthChanges: changeSource === "health" ? Stream.make(statuses) : Stream.empty,
        resolveRuntime: () =>
          Effect.succeed({
            ...MISSING_RUNTIME,
            executable: null,
          }),
        getRuntimeSnapshot: () =>
          Effect.succeed({
            provider: "antigravity",
            managedExecutablePath: null,
            managedVersion: null,
            previousReleaseAvailable: false,
            bundled: false,
            canInstall: true,
            installationState: null,
          }),
        runtimeChanges: changeSource === "runtime" ? Stream.make(null) : Stream.empty,
      });

      const events = await Effect.runPromise(
        projection.streamChanges.pipe(Stream.take(1), Stream.runCollect),
      );
      const event = Array.from(events)[0];

      expect(event).toHaveLength(1);
      expect(event?.[0]?.runtime.canInstall).toBe(true);
    },
  );

  it.each(PROVIDERS)("always projects required runtime state for %s", (provider) => {
    const projected = projectProviderClientStatus({
      status: healthStatus(provider),
      runtime:
        provider === "pi"
          ? {
              ...MISSING_RUNTIME,
              source: "bundled",
              canInstall: false,
              message: "Built into Scient.",
            }
          : MISSING_RUNTIME,
      installationState: null,
    });

    expect(projected.provider).toBe(provider);
    expect(projected.runtime).toBeDefined();
    expect(projected.runtime.canInstall).toBe(provider !== "pi");
  });

  it("replaces legacy runtime fields and clears stale installation state", () => {
    const projected = projectProviderClientStatus({
      status: {
        ...healthStatus("antigravity"),
        runtime: { ...MISSING_RUNTIME, canInstall: false },
        installationState: {
          operationId: "stale-install",
          operation: "install",
          status: "failed",
          startedAt: "2026-07-20T15:00:00.000Z",
          finishedAt: "2026-07-20T15:01:00.000Z",
          message: "Stale failure.",
        },
      },
      runtime: MISSING_RUNTIME,
      installationState: null,
    });

    expect(projected.runtime.canInstall).toBe(true);
    expect(projected.installationState).toBeUndefined();
  });

  it("suppresses external updater actions for Scient-managed runtimes", () => {
    const projected = projectProviderClientStatus({
      status: {
        ...healthStatus("antigravity"),
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.1.4",
          latestVersion: "1.1.5",
          updateCommand: "agy update",
          canUpdate: true,
          checkedAt: "2026-07-20T16:00:00.000Z",
          message: "Update available.",
        },
      },
      runtime: {
        ...MISSING_RUNTIME,
        source: "managed",
        managedVersion: "1.1.4",
        canInstall: false,
        canRemove: true,
        message: null,
      },
      installationState: null,
    });

    expect(projected.versionAdvisory).toMatchObject({
      canUpdate: false,
      updateCommand: null,
      message: "Updates for this runtime are managed by Scient.",
    });
  });
});
