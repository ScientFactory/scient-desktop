import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type {
  ProviderManagedRuntimeActions,
  ProviderVoiceTranscriptCorrection,
} from "../../provider/ScientProviderInstanceSeams.ts";
import {
  ProviderSessionCloseError,
  ProviderSessionManagerV2,
  type ProviderSessionManagerV2Shape,
} from "../../orchestration-v2/ProviderSessionManager.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  ProviderRegistry,
  ProviderRegistryRefreshError,
  type ProviderRegistryShape,
} from "../../provider/ProviderRegistry.ts";
import { ProviderActivity, type ProviderActivityShape } from "./ProviderActivity.ts";
import {
  make as makeLifecycleCoordinator,
  ProviderLifecycleCoordinator,
} from "./ProviderLifecycleCoordinator.ts";
import {
  layer as ProviderRuntimeManagerLayer,
  make,
  ProviderRuntimeManager,
} from "./ProviderRuntimeManager.ts";

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

const ACTIVE_STATUSES = new Set([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
  "removing",
]);

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
  closeInstance: ProviderSessionManagerV2Shape["closeInstance"] = () => Effect.void,
  actionsAfterReload?: ProviderManagedRuntimeActions,
  reloadBarrier: Effect.Effect<void, ProviderRegistryRefreshError> = Effect.void,
  hooks: {
    readonly beforeSetRuntime?: (runtime: ProviderRuntimeSummary | null) => Effect.Effect<void>;
    readonly afterSetRuntime?: (runtime: ProviderRuntimeSummary | null) => Effect.Effect<void>;
    readonly useProductionLayer?: boolean;
    readonly isBusy?: ProviderActivityShape["isBusy"];
    readonly closeInstance?: ProviderSessionManagerV2Shape["closeInstance"];
  } = {},
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make(initialProviders);
    const actionsRef = yield* Ref.make(actions);
    const reloadCountRef = yield* Ref.make(0);
    const reloadedInstancesRef = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
    const closedInstancesRef = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
    const stopCountRef = yield* Ref.make(0);
    const reloadOperationsRef = yield* Ref.make<ReadonlyArray<string | null>>([]);
    const setRuntime: ProviderRegistryShape["setProviderManagedRuntimeSummary"] = (input) =>
      Effect.gen(function* () {
        yield* hooks.beforeSetRuntime?.(input.runtime) ?? Effect.void;
        const providers = yield* Ref.updateAndGet(providersRef, (providers) =>
          providers.map((candidate) =>
            candidate.instanceId === input.instanceId && candidate.connection && input.runtime
              ? {
                  ...candidate,
                  connection: { ...candidate.connection, runtime: input.runtime },
                }
              : candidate,
          ),
        );
        yield* hooks.afterSetRuntime?.(input.runtime) ?? Effect.void;
        return providers;
      });
    const reloadInstance = Effect.gen(function* () {
      yield* Ref.update(reloadCountRef, (count) => count + 1);
      const providers = yield* Ref.get(providersRef);
      const operationStatus =
        providers.find((candidate) => candidate.instanceId === INSTANCE)?.connection?.runtime
          ?.operation?.status ?? null;
      yield* Ref.update(reloadOperationsRef, (statuses) => [...statuses, operationStatus]);
      if (actionsAfterReload) yield* Ref.set(actionsRef, actionsAfterReload);
      yield* reloadBarrier;
      return providers;
    });
    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      refreshInstanceStrict: () => Ref.get(providersRef),
      refreshInstanceAfterAccountChange: () => Ref.get(providersRef),
      reloadInstance: () => reloadInstance.pipe(Effect.catch(() => Ref.get(providersRef))),
      reloadInstanceStrict: (instanceId) =>
        Ref.update(reloadedInstancesRef, (instances) => [...instances, instanceId]).pipe(
          Effect.andThen(reloadInstance),
        ),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, driver) =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
      getProviderConnectionActionsForInstance: () => Effect.succeed(undefined),
      getProviderManagedRuntimeActionsForInstance: () => Ref.get(actionsRef),
      getProviderSkillActionsForInstance: () => Effect.succeed(undefined),
      getVoiceTranscriptCorrectionForInstance: () =>
        // @effect-diagnostics-next-line effectSucceedWithVoid:off -- Exact optional return requires undefined, not void.
        Effect.succeed<ProviderVoiceTranscriptCorrection | undefined>(undefined),
      setProviderMaintenanceActionState: () => Ref.get(providersRef),
      setProviderConnectionOperation: () => Ref.get(providersRef),
      setProviderAuthenticationFailure: () => Ref.get(providersRef),
      setProviderManagedRuntimeSummary: setRuntime,
      streamChanges: Stream.empty,
    };
    const coordinator = yield* makeLifecycleCoordinator;
    const lifecycleReleaseCountRef = yield* Ref.make(0);
    const trackedCoordinator = ProviderLifecycleCoordinator.of({
      ...coordinator,
      release: (input) =>
        Ref.update(lifecycleReleaseCountRef, (count) => count + 1).pipe(
          Effect.andThen(coordinator.release(input)),
        ),
    });
    const activity = ProviderActivity.of({
      isBusy: hooks.isBusy ?? (() => Effect.succeed(false)),
    });
    const managerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
    const providerSessionsLayer = Layer.mock(ProviderSessionManagerV2)({
      closeInstance: (instanceId) =>
        Ref.update(stopCountRef, (count) => count + 1).pipe(
          Effect.andThen(Ref.update(closedInstancesRef, (instances) => [...instances, instanceId])),
          Effect.andThen((hooks.closeInstance ?? closeInstance)(instanceId)),
        ),
    });
    const manager = hooks.useProductionLayer
      ? yield* Layer.build(
          ProviderRuntimeManagerLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderRegistry, registry),
                Layer.succeed(ProviderLifecycleCoordinator, trackedCoordinator),
                Layer.succeed(ProviderActivity, activity),
                providerSessionsLayer,
                NodeServices.layer,
              ),
            ),
          ),
        ).pipe(
          Scope.provide(managerScope),
          Effect.map((services) => Context.get(services, ProviderRuntimeManager)),
        )
      : yield* make().pipe(
          Effect.provideService(ProviderRegistry, registry),
          Effect.provideService(ProviderLifecycleCoordinator, trackedCoordinator),
          Effect.provideService(ProviderActivity, activity),
          Effect.provide(Layer.mergeAll(providerSessionsLayer, NodeServices.layer)),
          Scope.provide(managerScope),
        );
    return {
      manager,
      providersRef,
      reloadCountRef,
      reloadedInstancesRef,
      closedInstancesRef,
      reloadOperationsRef,
      stopCountRef,
      coordinator: trackedCoordinator,
      lifecycleReleaseCountRef,
      closeManager: Scope.close(managerScope, Exit.void),
    };
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
        run: (_action, _revision, report, awaitActivationWindow = Effect.void) =>
          report({
            status: "downloading",
            message: "Downloading.",
            downloadedBytes: 50,
            totalBytes: 100,
          }).pipe(Effect.andThen(awaitActivationWindow), Effect.andThen(Ref.set(installed, true))),
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
      assert.strictEqual(yield* Ref.get(stopCountRef), 4);
      assert.deepStrictEqual(yield* Ref.get(reloadOperationsRef), ["downloading", "downloading"]);
    }),
  );

  it.effect.each(
    (["install", "update", "repair", "remove"] as const).map((action) => ({
      caseTitle: `closes V2 default-runtime peers before ${action} without touching custom accounts`,
      action,
    })),
  )("$caseTitle", ({ action }) =>
    Effect.gen(function* () {
      const customInstance = ProviderInstanceId.make("codex-custom-executable");
      const unavailableCustom = ProviderInstanceId.make("codex-unavailable-custom");
      const unrelatedInstance = ProviderInstanceId.make("pi-native-instance");
      const closed = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
      const activated = yield* Ref.make(false);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed({ ...systemRuntime, actions: [action] }),
        plan: () => Effect.succeed({ ...installPlan(), action }),
        run: (_action, _revision, _report, activation = Effect.void) =>
          activation.pipe(
            Effect.andThen(
              Effect.gen(function* () {
                assert.deepEqual(yield* Ref.get(closed), [INSTANCE, SECOND_INSTANCE]);
                yield* Ref.set(activated, true);
              }),
            ),
          ),
      };
      const withRuntime = (
        instanceId: ProviderInstanceId,
        source: ProviderRuntimeSummary["source"],
      ): ServerProvider => ({
        ...systemProvider,
        instanceId,
        connection: { ...systemProvider.connection!, runtime: { ...systemRuntime, source } },
      });
      const { manager, providersRef, reloadedInstancesRef, lifecycleReleaseCountRef } =
        yield* makeHarness(
          actions,
          [
            systemProvider,
            withRuntime(SECOND_INSTANCE, "scient_managed"),
            withRuntime(customInstance, "custom"),
            withRuntime(unavailableCustom, "unknown"),
            {
              ...withRuntime(unrelatedInstance, "scient_managed"),
              driver: ProviderDriverKind.make("pi"),
            },
          ],
          undefined,
          undefined,
          undefined,
          {
            useProductionLayer: true,
            closeInstance: (instanceId) =>
              Ref.update(closed, (instances) => [...instances, instanceId]),
          },
        );

      yield* manager.start({ instanceId: INSTANCE, action, catalogRevision: "reviewed:1" });
      yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.equal(yield* Ref.get(activated), true);
      assert.deepEqual(yield* Ref.get(closed), [
        INSTANCE,
        SECOND_INSTANCE,
        INSTANCE,
        SECOND_INSTANCE,
      ]);
      assert.deepEqual(yield* Ref.get(reloadedInstancesRef), [INSTANCE, SECOND_INSTANCE]);
      assert.equal(yield* Ref.get(lifecycleReleaseCountRef), 1);
    }),
  );

  it.effect("does not report success when post-mutation runtime reconciliation fails", () =>
    Effect.gen(function* () {
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed({
          ...missingRuntime,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: "0.147.0",
          message: "Managed Codex is ready.",
        }),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.void,
      };
      const reloadFailure = new ProviderRegistryRefreshError({
        operation: "reload",
        instanceId: INSTANCE,
        message: "Simulated strict reload failure.",
      });
      const { manager, providersRef, lifecycleReleaseCountRef } = yield* makeHarness(
        actions,
        [provider],
        () => Effect.void,
        undefined,
        reloadFailure,
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

      assert.strictEqual(
        completed[0]?.connection?.runtime?.operation?.message,
        "The runtime change finished, but Scient could not verify the resulting provider state.",
      );
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
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

  it.effect("starts a switch to an older managed release without special acceptance", () =>
    Effect.gen(function* () {
      const runCount = yield* Ref.make(0);
      const olderPlan = {
        ...installPlan(),
        catalogRevision: "reviewed:1:older-than-system",
        systemVersion: "0.200.0",
        olderThanSystem: true,
      };
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(olderPlan),
        run: () => Ref.update(runCount, (count) => count + 1),
      };
      const { manager } = yield* makeHarness(actions, [systemProvider]);
      const planned = yield* manager.plan({ instanceId: INSTANCE, action: "install" });
      assert.strictEqual(planned.olderThanSystem, true);
      assert.strictEqual(planned.systemVersion, "0.200.0");

      yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: planned.catalogRevision,
      });
      yield* yieldUntil(Ref.get(runCount), (count) => count === 1);
    }),
  );

  // Install is "Use Scient-managed"; Repair and Update of a copy that was never
  // selected put it in use the same way.
  it.effect.each(
    (["install", "repair", "update"] as const).map((action) => ({
      caseTitle: `starts ${action} over a system runtime of unknown version directly`,
      action,
    })),
  )("$caseTitle", ({ action }) =>
    Effect.gen(function* () {
      const runCount = yield* Ref.make(0);
      const summary = { ...systemRuntime, actions: [action] };
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(summary),
        plan: () =>
          Effect.succeed({
            ...installPlan(),
            action,
            catalogRevision: "reviewed:1:system-version-unknown",
            systemVersion: null,
            olderThanSystem: false,
          }),
        run: () => Ref.update(runCount, (count) => count + 1),
      };
      const { manager } = yield* makeHarness(actions, [
        { ...systemProvider, connection: { ...systemProvider.connection!, runtime: summary } },
      ]);
      yield* manager.start({
        instanceId: INSTANCE,
        action,
        catalogRevision: "reviewed:1:system-version-unknown",
      });
      yield* yieldUntil(Ref.get(runCount), (count) => count === 1);
    }),
  );

  it.effect("stages while turns run and switches only once the provider is idle", () =>
    Effect.gen(function* () {
      const busy = yield* Ref.make(true);
      const installed = yield* Ref.make(false);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: (_action, _revision, report, awaitActivationWindow = Effect.void) =>
          report({ status: "testing", message: "Testing." }).pipe(
            Effect.andThen(awaitActivationWindow),
            Effect.andThen(Ref.set(installed, true)),
          ),
      };
      const { manager, providersRef, stopCountRef } = yield* makeHarness(
        actions,
        [systemProvider],
        undefined,
        undefined,
        undefined,
        { isBusy: () => Ref.get(busy) },
      );
      yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });

      const waiting = yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.waitingForIdle === true,
      );
      assert.strictEqual(waiting[0]?.connection?.runtime?.operation?.status, "activating");
      assert.match(
        waiting[0]?.connection?.runtime?.operation?.message ?? "",
        /finish its running work/u,
      );
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(yield* Ref.get(installed), false);
      assert.strictEqual(yield* Ref.get(stopCountRef), 0);

      yield* Ref.set(busy, false);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.strictEqual(yield* Ref.get(installed), true);
      assert.strictEqual(yield* Ref.get(stopCountRef), 2);
    }),
  );

  it.effect("cancels a staged runtime that is still waiting for idle", () =>
    Effect.gen(function* () {
      const installed = yield* Ref.make(false);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: (_action, _revision, _report, awaitActivationWindow = Effect.void) =>
          awaitActivationWindow.pipe(Effect.andThen(Ref.set(installed, true))),
      };
      const { manager, providersRef, stopCountRef } = yield* makeHarness(
        actions,
        [systemProvider],
        undefined,
        undefined,
        undefined,
        { isBusy: () => Effect.succeed(true) },
      );
      const started = yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });
      const waiting = yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.waitingForIdle === true,
      );
      const operationId = waiting[0]?.connection?.runtime?.operation?.operationId ?? "";
      assert.isDefined(started);
      yield* manager.cancel({ instanceId: INSTANCE, operationId });
      yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "cancelled",
      );
      assert.strictEqual(yield* Ref.get(installed), false);
      assert.strictEqual(yield* Ref.get(stopCountRef), 0);
    }),
  );

  it.effect("switches back to a recovered runtime only once the provider is idle", () =>
    Effect.gen(function* () {
      const busy = yield* Ref.make(true);
      const recovered = yield* Ref.make(true);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
        selectionChanged: Ref.get(recovered),
      };
      const { manager, reloadCountRef } = yield* makeHarness(
        actions,
        [systemProvider],
        undefined,
        undefined,
        undefined,
        { isBusy: () => Ref.get(busy) },
      );
      const reselecting = yield* manager.reselect(INSTANCE).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(yield* Ref.get(reloadCountRef), 0);

      yield* Ref.set(busy, false);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(reselecting), true);
      assert.strictEqual(yield* Ref.get(reloadCountRef), 1);

      yield* Ref.set(recovered, false);
      assert.strictEqual(yield* manager.reselect(INSTANCE), false);
      assert.strictEqual(yield* Ref.get(reloadCountRef), 1);
    }),
  );

  it.effect("reselects a shared runtime once when several accounts ask at once", () =>
    Effect.gen(function* () {
      const busy = yield* Ref.make(true);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
        selectionChanged: Effect.succeed(true),
      };
      const { manager, reloadCountRef } = yield* makeHarness(
        actions,
        [systemProvider],
        undefined,
        undefined,
        undefined,
        { isBusy: () => Ref.get(busy) },
      );
      const first = yield* manager.reselect(INSTANCE).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* manager.reselect(INSTANCE), false);
      yield* Ref.set(busy, false);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(first), true);
      assert.strictEqual(yield* Ref.get(reloadCountRef), 1);
    }),
  );

  it.effect("never interrupts running work across random interleavings", () =>
    Effect.gen(function* () {
      const iterations = Number(process.env.SCIENT_RUNTIME_STRESS_ITERATIONS ?? 40);
      for (let seed = 1; seed <= iterations; seed += 1) {
        // mulberry32: deterministic per seed, so a failure names its seed.
        let state = seed;
        const random = () => {
          state = (state + 0x6d2b79f5) | 0;
          let t = Math.imul(state ^ (state >>> 15), 1 | state);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const busy = yield* Ref.make(random() < 0.5);
        const violations = yield* Ref.make<ReadonlyArray<string>>([]);
        const violate = (what: string) =>
          Ref.get(busy).pipe(
            Effect.flatMap((isBusy) =>
              isBusy
                ? Ref.update(violations, (all) => [...all, `seed ${seed}: ${what}`])
                : Effect.void,
            ),
          );
        const actions: ProviderManagedRuntimeActions = {
          getSummary: Effect.succeed(systemRuntime),
          plan: () => Effect.succeed(installPlan()),
          run: (_action, _revision, report, awaitActivationWindow = Effect.void) =>
            Effect.gen(function* () {
              yield* report({ status: "downloading", message: "Downloading." });
              for (let step = Math.floor(random() * 3); step > 0; step -= 1) yield* Effect.yieldNow;
              yield* awaitActivationWindow;
              yield* violate("activated while busy");
            }),
          selectionChanged: Effect.sync(() => random() < 0.5),
        };
        const { manager, providersRef } = yield* makeHarness(
          actions,
          [systemProvider],
          () => violate("stopped sessions while busy"),
          undefined,
          violate("reloaded while busy"),
          { isBusy: () => Ref.get(busy) },
        );
        const operationId = () =>
          Ref.get(providersRef).pipe(
            Effect.map((providers) => providers[0]?.connection?.runtime?.operation?.operationId),
          );
        for (let step = 0; step < 14; step += 1) {
          const choice = random();
          if (choice < 0.2) {
            yield* manager
              .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
              .pipe(Effect.ignore);
          } else if (choice < 0.3) {
            const id = yield* operationId();
            if (id)
              yield* manager.cancel({ instanceId: INSTANCE, operationId: id }).pipe(Effect.ignore);
          } else if (choice < 0.4) {
            yield* manager.reselect(INSTANCE).pipe(Effect.forkChild);
          } else if (choice < 0.65) {
            yield* Ref.update(busy, (isBusy) => !isBusy);
          } else if (choice < 0.85) {
            yield* TestClock.adjust("1 second");
          } else {
            yield* Effect.yieldNow;
          }
        }
        // Once the provider goes idle, everything settles and releases.
        yield* Ref.set(busy, false);
        for (let step = 0; step < 6; step += 1) yield* TestClock.adjust("1 second");
        const settled = yield* yieldUntil(Ref.get(providersRef), (providers) => {
          const status = providers[0]?.connection?.runtime?.operation?.status;
          return status === undefined || !ACTIVE_STATUSES.has(status);
        });
        assert.deepStrictEqual(yield* Ref.get(violations), [], `seed ${seed}`);
        assert.isDefined(settled);
        const next = yield* manager
          .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
          .pipe(Effect.result);
        assert.strictEqual(next._tag, "Success", `seed ${seed}: lifecycle reservation leaked`);
        yield* TestClock.adjust("1 second");
      }
    }),
  );

  it.effect("closes and reloads only instances using the exact registry installation", () =>
    Effect.gen(function* () {
      const runtime: ProviderRuntimeSummary = {
        ...missingRuntime,
        source: "registry",
        target: "registry:alpha:/owned/alpha",
        actions: ["remove"],
        managedVersion: "1.2.3",
      };
      const registryProvider: ServerProvider = {
        ...provider,
        driver: ProviderDriverKind.make("acpRegistry"),
        installed: true,
        connection: { ...provider.connection!, runtime },
      };
      const shared: ServerProvider = { ...registryProvider, instanceId: SECOND_INSTANCE };
      const other: ServerProvider = {
        ...registryProvider,
        instanceId: ProviderInstanceId.make("other-agent"),
        connection: {
          ...provider.connection!,
          runtime: { ...runtime, target: "registry:beta:/owned/beta" },
        },
      };
      const custom: ServerProvider = {
        ...registryProvider,
        instanceId: ProviderInstanceId.make("external-alpha"),
        connection: { ...provider.connection!, runtime: { ...runtime, source: "custom" } },
      };
      const unverified: ServerProvider = {
        ...registryProvider,
        instanceId: ProviderInstanceId.make("unverified"),
        connection: { methods: [], canDisconnect: false, operation: null },
      };
      const finished = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(runtime),
        plan: () => Effect.succeed({ ...installPlan(), action: "remove", target: runtime.target }),
        run: (_action, _revision, _report, activation = Effect.void) =>
          activation.pipe(Effect.andThen(Deferred.succeed(finished, undefined))),
      };
      const { manager, providersRef, closedInstancesRef, reloadedInstancesRef } =
        yield* makeHarness(actions, [registryProvider, shared, other, custom, unverified]);
      yield* manager.start({
        instanceId: INSTANCE,
        action: "remove",
        catalogRevision: "reviewed:1",
      });
      yield* Deferred.await(finished);
      yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.deepStrictEqual(
        new Set(yield* Ref.get(closedInstancesRef)),
        new Set([INSTANCE, SECOND_INSTANCE]),
      );
      assert.deepStrictEqual(yield* Ref.get(reloadedInstancesRef), [INSTANCE, SECOND_INSTANCE]);
      const providers = yield* Ref.get(providersRef);
      assert.deepStrictEqual(providers.slice(2), [other, custom, unverified]);
    }),
  );

  it.effect("leaves runtimes without a selection check alone", () =>
    Effect.gen(function* () {
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
      };
      const { manager, reloadCountRef } = yield* makeHarness(actions, [systemProvider]);
      assert.strictEqual(yield* manager.reselect(INSTANCE), false);
      assert.strictEqual(yield* Ref.get(reloadCountRef), 0);
    }),
  );

  it.effect("does not mutate a shared runtime when active sessions cannot stop", () =>
    Effect.gen(function* () {
      const runCount = yield* Ref.make(0);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: (_action, _revision, _report, awaitActivationWindow = Effect.void) =>
          awaitActivationWindow.pipe(Effect.andThen(Ref.update(runCount, (count) => count + 1))),
      };
      const { manager, providersRef } = yield* makeHarness(
        actions,
        [systemProvider],
        (instanceId) =>
          Effect.fail(
            new ProviderSessionCloseError({
              providerSessionId: ProviderSessionId.make(`test-session:${instanceId}`),
              cause: new Error("session still running"),
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
        /could not stop idle Codex sessions/u,
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

  it.effect("holds the lifecycle reservation until cancelled runtime state is published", () =>
    Effect.gen(function* () {
      const cancellationPublicationStarted = yield* Deferred.make<void>();
      const releaseCancellationPublication = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.never,
      };
      const { manager, coordinator, lifecycleReleaseCountRef } = yield* makeHarness(
        actions,
        [systemProvider],
        () => Effect.void,
        undefined,
        Effect.void,
        {
          beforeSetRuntime: (runtime) =>
            runtime?.operation?.status === "cancelled"
              ? Deferred.succeed(cancellationPublicationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCancellationPublication)),
                )
              : Effect.void,
        },
      );
      const started = yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });
      const operationId = started.providers[0]?.connection?.runtime?.operation?.operationId;
      assert.ok(operationId);

      const cancelFiber = yield* manager
        .cancel({ instanceId: INSTANCE, operationId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(cancellationPublicationStarted);

      assert.strictEqual((yield* coordinator.current(INSTANCE))?.operationId, operationId);
      const overlappingStart = yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.flip);
      assert.strictEqual(overlappingStart.reason, "runtime_busy");

      yield* Deferred.succeed(releaseCancellationPublication, undefined);
      const cancelled = yield* Fiber.join(cancelFiber);
      assert.strictEqual(
        cancelled.providers[0]?.connection?.runtime?.operation?.status,
        "cancelled",
      );
      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
    }),
  );

  it.effect(
    "shuts down an active runtime operation without leaving work or publishing a false failure",
    () =>
      Effect.gen(function* () {
        const runInterruptions = yield* Ref.make(0);
        const runStarted = yield* Deferred.make<void>();
        const actions: ProviderManagedRuntimeActions = {
          getSummary: Effect.succeed(systemRuntime),
          plan: () => Effect.succeed(installPlan()),
          run: () =>
            Deferred.succeed(runStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Ref.update(runInterruptions, (count) => count + 1)),
            ),
        };
        const { manager, providersRef, coordinator, lifecycleReleaseCountRef, closeManager } =
          yield* makeHarness(actions, [systemProvider], () => Effect.void, undefined, Effect.void, {
            useProductionLayer: true,
          });
        const started = yield* manager.start({
          instanceId: INSTANCE,
          action: "install",
          catalogRevision: "reviewed:1",
        });
        const operationId = started.providers[0]?.connection?.runtime?.operation?.operationId;
        assert.ok(operationId);
        yield* Deferred.await(runStarted);

        yield* closeManager;

        assert.strictEqual(yield* Ref.get(runInterruptions), 1);
        assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
        assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
        assert.strictEqual(
          (yield* Ref.get(providersRef))[0]?.connection?.runtime?.operation?.status,
          "preparing",
        );
        const inactive = yield* manager
          .cancel({ instanceId: INSTANCE, operationId })
          .pipe(Effect.flip);
        assert.strictEqual(inactive.reason, "runtime_operation_not_found");

        yield* closeManager;
        assert.strictEqual(yield* Ref.get(runInterruptions), 1);
        assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
      }),
  );

  it.effect("releases the runtime reservation when initial summary discovery is interrupted", () =>
    Effect.gen(function* () {
      const summaryStarted = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Deferred.succeed(summaryStarted, undefined).pipe(Effect.andThen(Effect.never)),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
      };
      const { manager, coordinator } = yield* makeHarness(actions);

      const startFiber = yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(summaryStarted);
      yield* Fiber.interrupt(startFiber);

      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
    }),
  );

  it.effect("releases the runtime reservation when initial publication is interrupted", () =>
    Effect.gen(function* () {
      const publicationStarted = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
      };
      const { manager, coordinator } = yield* makeHarness(
        actions,
        [systemProvider],
        () => Effect.void,
        undefined,
        Effect.void,
        {
          beforeSetRuntime: (runtime) =>
            runtime?.operation?.status === "preparing"
              ? Deferred.succeed(publicationStarted, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
        },
      );

      const startFiber = yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(publicationStarted);
      yield* Fiber.interrupt(startFiber);

      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
    }),
  );

  it.effect(
    "publishes cancellation when interrupted after initial runtime state becomes visible",
    () =>
      Effect.gen(function* () {
        const publicationCommitted = yield* Deferred.make<void>();
        const actions: ProviderManagedRuntimeActions = {
          getSummary: Effect.succeed(systemRuntime),
          plan: () => Effect.succeed(installPlan()),
          run: () => Effect.die("must not run"),
        };
        const { manager, coordinator, providersRef } = yield* makeHarness(
          actions,
          [systemProvider],
          () => Effect.void,
          undefined,
          Effect.void,
          {
            afterSetRuntime: (runtime) =>
              runtime?.operation?.status === "preparing"
                ? Deferred.succeed(publicationCommitted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  )
                : Effect.void,
          },
        );

        const startFiber = yield* manager
          .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(publicationCommitted);
        yield* Fiber.interrupt(startFiber);

        assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
        assert.strictEqual(
          (yield* Ref.get(providersRef))[0]?.connection?.runtime?.operation?.status,
          "cancelled",
        );
      }),
  );

  it.effect("does not cancel a committed runtime while provider reload is still running", () =>
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
      const { manager, providersRef, reloadCountRef, lifecycleReleaseCountRef } =
        yield* makeHarness(
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

      const cancellationFailure = yield* manager
        .cancel({ instanceId: INSTANCE, operationId })
        .pipe(Effect.flip);

      assert.strictEqual(cancellationFailure.reason, "runtime_operation_not_found");
      assert.strictEqual(
        cancellationFailure.message,
        "The runtime change is already being finalized and can no longer be cancelled.",
      );
      assert.strictEqual(
        (yield* Ref.get(providersRef))[0]?.connection?.runtime?.operation?.status,
        "activating",
      );
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 0);

      yield* Deferred.succeed(reloadGate, undefined);
      const completed = yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.strictEqual(completed[0]?.connection?.runtime?.operation?.status, "succeeded");
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
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
