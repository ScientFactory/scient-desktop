import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderManagedRuntimeActions } from "../../provider/ProviderDriver.ts";
import { ProviderAdapterProcessError } from "../../provider/Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../../provider/providerMaintenance.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../../provider/Services/ProviderRegistry.ts";
import {
  make as makeLifecycleCoordinator,
  ProviderLifecycleCoordinator,
} from "./ProviderLifecycleCoordinator.ts";
import { make } from "./ProviderRuntimeManager.ts";

const CODEX = ProviderDriverKind.make("codex");
const INSTANCE = ProviderInstanceId.make("codex");
const SECOND_INSTANCE = ProviderInstanceId.make("codex-work");

const missingRuntime: ProviderRuntimeSummary = {
  source: "missing",
  supportTier: "fully_assisted",
  target: "darwin-arm64",
  actions: ["install"],
  managedVersion: null,
  previousManagedVersion: null,
  operation: null,
  message: "Codex setup is available.",
};

const provider: ServerProvider = {
  instanceId: INSTANCE,
  driver: CODEX,
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown", required: true },
  checkedAt: "2026-08-09T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser", "codex_device_code"],
    canDisconnect: false,
    operation: null,
    runtime: missingRuntime,
  },
};

const systemRuntime: ProviderRuntimeSummary = {
  ...missingRuntime,
  source: "system",
  actions: ["install"],
  message: "Using the Codex installation on this computer.",
};

const systemProvider: ServerProvider = {
  ...provider,
  installed: true,
  connection: { ...provider.connection!, runtime: systemRuntime },
};

const yieldUntil = <A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const value = yield* effect;
      if (predicate(value)) return value;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Timed out waiting for provider runtime state."));
  });

function makeHarness(
  actions: ProviderManagedRuntimeActions,
  initialProviders: ReadonlyArray<ServerProvider> = [provider],
  stopProviderSessions: ProviderRegistryShape["stopProviderSessions"] = () => Effect.void,
  actionsAfterReload?: ProviderManagedRuntimeActions,
  reloadBarrier: Effect.Effect<void> = Effect.void,
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make(initialProviders);
    const actionsRef = yield* Ref.make(actions);
    const reloadCountRef = yield* Ref.make(0);
    const stopCountRef = yield* Ref.make(0);
    const reloadOperationsRef = yield* Ref.make<ReadonlyArray<string | null>>([]);
    const setRuntime: ProviderRegistryShape["setProviderManagedRuntimeSummary"] = (input) =>
      Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) =>
          candidate.instanceId === input.instanceId && candidate.connection && input.runtime
            ? {
                ...candidate,
                connection: { ...candidate.connection, runtime: input.runtime },
              }
            : candidate,
        ),
      );
    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      reloadInstance: () =>
        Effect.gen(function* () {
          yield* Ref.update(reloadCountRef, (count) => count + 1);
          const providers = yield* Ref.get(providersRef);
          const operationStatus =
            providers.find((candidate) => candidate.instanceId === INSTANCE)?.connection?.runtime
              ?.operation?.status ?? null;
          yield* Ref.update(reloadOperationsRef, (statuses) => [...statuses, operationStatus]);
          if (actionsAfterReload) yield* Ref.set(actionsRef, actionsAfterReload);
          yield* reloadBarrier;
          return providers;
        }),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, driver) =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
      getProviderConnectionActionsForInstance: () => Effect.succeed(undefined),
      getProviderManagedRuntimeActionsForInstance: () => Ref.get(actionsRef),
      stopProviderSessions: (provider) =>
        Ref.update(stopCountRef, (count) => count + 1).pipe(
          Effect.andThen(stopProviderSessions(provider)),
        ),
      setProviderMaintenanceActionState: () => Ref.get(providersRef),
      setProviderConnectionOperation: () => Ref.get(providersRef),
      setProviderManagedRuntimeSummary: setRuntime,
      streamChanges: Stream.empty,
    };
    const coordinator = yield* makeLifecycleCoordinator;
    const manager = yield* make().pipe(
      Effect.provideService(ProviderRegistry, registry),
      Effect.provideService(ProviderLifecycleCoordinator, coordinator),
      Effect.provide(NodeServices.layer),
    );
    return { manager, providersRef, reloadCountRef, reloadOperationsRef, stopCountRef };
  });
}

function installPlan() {
  return {
    action: "install" as const,
    target: "darwin-arm64",
    version: "0.147.0",
    downloadBytes: 100,
    sourceLabel: "Official OpenAI release",
    catalogRevision: "reviewed:1",
    message: "Install reviewed Codex.",
  };
}

describe("ProviderRuntimeManager", () => {
  it.effect("publishes one managed install and reloads every instance of the driver", () =>
    Effect.gen(function* () {
      const installed = yield* Ref.make(false);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Ref.get(installed).pipe(
          Effect.map((ready) =>
            ready
              ? {
                  ...missingRuntime,
                  source: "scient_managed" as const,
                  actions: ["repair" as const, "remove" as const],
                  managedVersion: "0.147.0",
                  message: "Managed Codex is ready.",
                }
              : missingRuntime,
          ),
        ),
        plan: () => Effect.succeed(installPlan()),
        run: (_action, _revision, report) =>
          report({
            status: "downloading",
            message: "Downloading.",
            downloadedBytes: 50,
            totalBytes: 100,
          }).pipe(Effect.andThen(Ref.set(installed, true))),
      };
      const secondProvider: ServerProvider = {
        ...provider,
        instanceId: SECOND_INSTANCE,
      };
      const { manager, providersRef, reloadCountRef, reloadOperationsRef, stopCountRef } =
        yield* makeHarness(actions, [provider, secondProvider]);
      const planned = yield* manager.plan({ instanceId: INSTANCE, action: "install" });
      assert.strictEqual(planned.catalogRevision, "reviewed:1");
      yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: planned.catalogRevision,
      });
      const completed = yield* yieldUntil(Ref.get(providersRef), (providers) =>
        providers.some(
          (candidate) => candidate.connection?.runtime?.operation?.status === "succeeded",
        ),
      );
      const runtime = completed[0]?.connection?.runtime;
      assert.strictEqual(runtime?.source, "scient_managed");
      assert.strictEqual(runtime?.managedVersion, "0.147.0");
      assert.strictEqual(completed[1]?.connection?.runtime?.source, "scient_managed");
      assert.strictEqual(completed[1]?.connection?.runtime?.managedVersion, "0.147.0");
      assert.strictEqual(yield* Ref.get(reloadCountRef), 2);
      assert.strictEqual(yield* Ref.get(stopCountRef), 1);
      assert.deepStrictEqual(yield* Ref.get(reloadOperationsRef), ["downloading", "downloading"]);
    }),
  );

  it.effect("reports a successful repair explicitly", () =>
    Effect.gen(function* () {
      const readyRuntime: ProviderRuntimeSummary = {
        ...missingRuntime,
        source: "scient_managed",
        actions: ["repair", "remove"],
        managedVersion: "0.147.0",
        message: "Managed Codex is ready.",
      };
      const readyProvider: ServerProvider = {
        ...provider,
        installed: true,
        connection: { ...provider.connection!, runtime: readyRuntime },
      };
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(readyRuntime),
        plan: () =>
          Effect.succeed({
            ...installPlan(),
            action: "repair" as const,
            message: "Repair reviewed Codex.",
          }),
        run: () => Effect.void,
      };
      const { manager, providersRef } = yield* makeHarness(actions, [readyProvider]);
      yield* manager.start({
        instanceId: INSTANCE,
        action: "repair",
        catalogRevision: "reviewed:1",
      });

      const completed = yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.strictEqual(
        completed[0]?.connection?.runtime?.operation?.message,
        "The provider runtime was repaired and verified successfully.",
      );
    }),
  );

  it.effect("publishes the freshly resolved system fallback after managed removal", () =>
    Effect.gen(function* () {
      const managedRuntime: ProviderRuntimeSummary = {
        ...missingRuntime,
        source: "scient_managed",
        actions: ["repair", "remove"],
        managedVersion: "0.202.0",
        message: "Managed Droid is ready.",
      };
      const staleManagedActions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(missingRuntime),
        plan: () =>
          Effect.succeed({
            action: "remove" as const,
            target: "darwin-arm64",
            version: "0.202.0",
            downloadBytes: null,
            sourceLabel: "Official Factory Droid release",
            catalogRevision: "managed-droid:remove:0.202.0",
            message: "Remove managed Droid.",
          }),
        run: () => Effect.void,
      };
      const fallbackRuntime: ProviderRuntimeSummary = {
        ...missingRuntime,
        source: "system",
        actions: [],
        message: "Using the system Droid runtime.",
      };
      const reloadedSystemActions: ProviderManagedRuntimeActions = {
        ...staleManagedActions,
        getSummary: Effect.succeed(fallbackRuntime),
      };
      const managedProvider: ServerProvider = {
        ...provider,
        installed: true,
        connection: { ...provider.connection!, runtime: managedRuntime },
      };
      const { manager, providersRef } = yield* makeHarness(
        staleManagedActions,
        [managedProvider],
        () => Effect.void,
        reloadedSystemActions,
      );

      yield* manager.start({
        instanceId: INSTANCE,
        action: "remove",
        catalogRevision: "managed-droid:remove:0.202.0",
      });

      const completed = yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.strictEqual(completed[0]?.connection?.runtime?.source, "system");
      assert.deepStrictEqual(completed[0]?.connection?.runtime?.actions, []);
    }),
  );

  it.effect("rejects stale consent before starting the runtime action", () =>
    Effect.gen(function* () {
      const runCount = yield* Ref.make(0);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(missingRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Ref.update(runCount, (count) => count + 1),
      };
      const { manager } = yield* makeHarness(actions);
      const result = yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "stale" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(result.failure.reason, "runtime_plan_stale");
      assert.strictEqual(yield* Ref.get(runCount), 0);
    }),
  );

  it.effect("does not mutate a shared runtime when active sessions cannot stop", () =>
    Effect.gen(function* () {
      const runCount = yield* Ref.make(0);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Ref.update(runCount, (count) => count + 1),
      };
      const { manager, providersRef } = yield* makeHarness(actions, [systemProvider], () =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: "codex",
            threadId: "active-thread",
            detail: "session still running",
          }),
        ),
      );
      yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });

      const completed = yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "failed",
      );
      assert.strictEqual(yield* Ref.get(runCount), 0);
      assert.strictEqual(completed[0]?.connection?.runtime?.source, "system");
      assert.match(
        completed[0]?.connection?.runtime?.operation?.message ?? "",
        /could not stop active codex sessions/u,
      );
    }),
  );

  it.effect("cancels the active download without claiming installation", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Deferred.await(never),
      };
      const { manager, reloadCountRef } = yield* makeHarness(actions, [systemProvider]);
      const started = yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });
      const operationId = started.providers[0]?.connection?.runtime?.operation?.operationId;
      assert.ok(operationId);
      const cancelled = yield* manager.cancel({ instanceId: INSTANCE, operationId });
      assert.strictEqual(
        cancelled.providers[0]?.connection?.runtime?.operation?.status,
        "cancelled",
      );
      assert.strictEqual(cancelled.providers[0]?.connection?.runtime?.source, "system");
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(reloadCountRef), 0);
    }),
  );

  it.effect("keeps an installed runtime cancellable while provider reload is still running", () =>
    Effect.gen(function* () {
      const reloadGate = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed({
          ...missingRuntime,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: "0.147.0",
          message: "Managed Codex is ready.",
        }),
        plan: () => Effect.succeed(installPlan()),
        run: (_action, _revision, report) =>
          report({
            status: "activating",
            message: "Activating the verified provider runtime.",
          }),
      };
      const { manager, providersRef, reloadCountRef } = yield* makeHarness(
        actions,
        [provider],
        () => Effect.void,
        undefined,
        Deferred.await(reloadGate),
      );
      const started = yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });
      const operationId = started.providers[0]?.connection?.runtime?.operation?.operationId;
      assert.ok(operationId);
      yield* yieldUntil(Ref.get(reloadCountRef), (count) => count === 1);

      const cancelled = yield* manager.cancel({ instanceId: INSTANCE, operationId });

      assert.strictEqual(
        cancelled.providers[0]?.connection?.runtime?.operation?.status,
        "cancelled",
      );
      assert.strictEqual(
        (yield* Ref.get(providersRef))[0]?.connection?.runtime?.operation?.status,
        "cancelled",
      );
    }),
  );

  it.effect("serializes one shared provider runtime across separate accounts", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(missingRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Deferred.await(never),
      };
      const secondProvider: ServerProvider = {
        ...provider,
        instanceId: SECOND_INSTANCE,
      };
      const { manager } = yield* makeHarness(actions, [provider, secondProvider]);
      const started = yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });
      const second = yield* manager
        .start({
          instanceId: SECOND_INSTANCE,
          action: "install",
          catalogRevision: "reviewed:1",
        })
        .pipe(Effect.result);
      assert.strictEqual(second._tag, "Failure");
      if (second._tag === "Failure") assert.strictEqual(second.failure.reason, "runtime_busy");

      const operationId = started.providers[0]?.connection?.runtime?.operation?.operationId;
      assert.ok(operationId);
      yield* manager.cancel({ instanceId: INSTANCE, operationId });
    }),
  );
});
