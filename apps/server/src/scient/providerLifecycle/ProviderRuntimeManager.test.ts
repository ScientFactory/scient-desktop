import { assert, describe, it } from "@effect/vitest";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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
import { ManagedRuntimeFileError } from "@scientfactory/provider-runtime";
import { ProviderActivity, type ProviderActivityShape } from "./ProviderActivity.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import {
  make as makeLifecycleCoordinator,
  ProviderLifecycleCoordinator,
} from "./ProviderLifecycleCoordinator.ts";
import {
  layer as ProviderRuntimeManagerLayer,
  make,
  ProviderRuntimeManager,
} from "./ProviderRuntimeManager.ts";
import { make as makeRequests, ProviderRuntimeRequests } from "./ProviderRuntimeRequests.ts";
import { make as makeRecovery } from "./ProviderRuntimeRecovery.ts";
import * as ServerConfig from "../../config.ts";
import { ProcessRunner } from "../../processRunner.ts";
import { AnalyticsService } from "../../telemetry/AnalyticsService.ts";
import { make as makeAgentBackground } from "./ScientAgentBackgroundRuntime.ts";
import * as AgentPolicy from "./ScientAgentRuntimePolicy.ts";

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

/** The first value of `ref`, current or later, that satisfies `predicate`. */
const awaitState = <A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
  predicate: (value: A) => boolean,
): Effect.Effect<A> =>
  SubscriptionRef.changes(ref).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap((value) =>
      value._tag === "Some"
        ? Effect.succeed(value.value)
        : Effect.die(new Error("The provider runtime state stream ended.")),
    ),
  );

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
    readonly requests?: ProviderRuntimeRequests["Service"];
    readonly agentPolicy?: AgentPolicy.ScientAgentRuntimePolicy["Service"];
    readonly observeRegistryChanges?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const providersRef = yield* SubscriptionRef.make(initialProviders);
    const actionsRef = yield* Ref.make(actions);
    const reloadCountRef = yield* SubscriptionRef.make(0);
    const reloadedInstancesRef = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
    const closedInstancesRef = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
    const stopCountRef = yield* Ref.make(0);
    const reloadOperationsRef = yield* Ref.make<ReadonlyArray<string | null>>([]);
    const setRuntime: ProviderRegistryShape["setProviderManagedRuntimeSummary"] = (input) =>
      Effect.gen(function* () {
        yield* hooks.beforeSetRuntime?.(input.runtime) ?? Effect.void;
        const providers = yield* SubscriptionRef.updateAndGet(providersRef, (providers) =>
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
      yield* SubscriptionRef.update(reloadCountRef, (count) => count + 1);
      const providers = yield* SubscriptionRef.get(providersRef);
      const operationStatus =
        providers.find((candidate) => candidate.instanceId === INSTANCE)?.connection?.runtime
          ?.operation?.status ?? null;
      yield* Ref.update(reloadOperationsRef, (statuses) => [...statuses, operationStatus]);
      if (actionsAfterReload) yield* Ref.set(actionsRef, actionsAfterReload);
      yield* reloadBarrier;
      return providers;
    });
    const registry: ProviderRegistryShape = {
      getProviders: SubscriptionRef.get(providersRef),
      refresh: () => SubscriptionRef.get(providersRef),
      refreshAfterUpdate: () => SubscriptionRef.get(providersRef),
      rebuildMissingAndRefresh: SubscriptionRef.get(providersRef),
      invalidateModelCaches: () => Effect.void,
      refreshModelCatalog: Effect.void,
      refreshInstance: () => SubscriptionRef.get(providersRef),
      refreshWorkspaceSnapshot: () => SubscriptionRef.get(providersRef),
      refreshInstanceStrict: () => SubscriptionRef.get(providersRef),
      refreshInstanceAfterAccountChange: () => SubscriptionRef.get(providersRef),
      readFreshInstance: () => Effect.die("Runtime changes never read fresh account state."),
      reloadInstance: () =>
        reloadInstance.pipe(Effect.catch(() => SubscriptionRef.get(providersRef))),
      reloadInstanceStrict: (instanceId) =>
        Ref.update(reloadedInstancesRef, (instances) => [...instances, instanceId]).pipe(
          Effect.andThen(reloadInstance),
        ),
      reloadSecretsAndRefresh: () => SubscriptionRef.get(providersRef),
      applySecretAndRefresh: () => SubscriptionRef.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, driver) =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
      getProviderConnectionActionsForInstance: () => Effect.undefined,
      getProviderManagedRuntimeActionsForInstance: () => Ref.get(actionsRef),
      getProviderSkillActionsForInstance: () => Effect.undefined,
      getProviderPluginActionsForInstance: () => Effect.undefined,
      recordProviderNativeInventory: () => SubscriptionRef.get(providersRef),
      getVoiceTranscriptCorrectionForInstance: () =>
        Effect.succeed<ProviderVoiceTranscriptCorrection | undefined>(undefined),
      setProviderMaintenanceActionState: () => SubscriptionRef.get(providersRef),
      setProviderConnectionOperation: () => SubscriptionRef.get(providersRef),
      setProviderAuthenticationFailure: () => SubscriptionRef.get(providersRef),
      setProviderManagedRuntimeSummary: setRuntime,
      streamChanges: hooks.observeRegistryChanges
        ? SubscriptionRef.changes(providersRef)
        : Stream.empty,
    };
    const coordinator = yield* makeLifecycleCoordinator;
    const lifecycleReleaseCountRef = yield* SubscriptionRef.make(0);
    const trackedCoordinator = ProviderLifecycleCoordinator.of({
      ...coordinator,
      // Counted once the coordinator has processed the release, so awaiting the count
      // observes the released reservation.
      release: (input) =>
        coordinator
          .release(input)
          .pipe(
            Effect.ensuring(SubscriptionRef.update(lifecycleReleaseCountRef, (count) => count + 1)),
          ),
    });
    const activity = ProviderActivity.of({
      isBusy: hooks.isBusy ?? (() => Effect.succeed(false)),
    });
    const managerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
    const requestLogRef = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
    const requestsLayer = hooks.requests
      ? Layer.succeed(ProviderRuntimeRequests, hooks.requests)
      : Layer.mock(ProviderRuntimeRequests)({
          assertAvailable: Effect.void,
          list: Effect.succeed([]),
          changes: Stream.empty,
          requested: (input) =>
            SubscriptionRef.update(requestLogRef, (log) => [...log, `requested:${input.action}`]),
          settled: (input) =>
            SubscriptionRef.update(requestLogRef, (log) => [...log, `settled:${input.outcome}`]),
        });
    const policyRef = yield* Ref.make<AgentPolicy.BackgroundRecord>({});
    const agentPolicy =
      hooks.agentPolicy ??
      AgentPolicy.ScientAgentRuntimePolicy.of({
        read: Ref.get(policyRef),
        update: (change) => Ref.modify(policyRef, (before) => [before, change(before)]),
      });
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
                requestsLayer,
                NodeServices.layer,
                NodeCrypto.layer,
                ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-manager-layer-" }).pipe(
                  Layer.provide(NodeServices.layer),
                ),
              ),
            ),
          ),
        ).pipe(
          Scope.provide(managerScope),
          Effect.map((services) => Context.get(services, ProviderRuntimeManager)),
        )
      : yield* make().pipe(
          Effect.provideService(AgentPolicy.ScientAgentRuntimePolicy, agentPolicy),
          Effect.provideService(ProviderRegistry, registry),
          Effect.provideService(ProviderLifecycleCoordinator, trackedCoordinator),
          Effect.provideService(ProviderActivity, activity),
          Effect.provide(
            Layer.mergeAll(
              providerSessionsLayer,
              requestsLayer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
          Scope.provide(managerScope),
        );
    return {
      manager,
      registry,
      agentPolicy,
      providersRef,
      reloadCountRef,
      reloadedInstancesRef,
      closedInstancesRef,
      reloadOperationsRef,
      stopCountRef,
      coordinator: trackedCoordinator,
      lifecycleReleaseCountRef,
      requestLogRef,
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

const AGENT = ProviderDriverKind.make("scient");
const agentRuntime: ProviderRuntimeSummary = {
  ...missingRuntime,
  qualifiedVersion: "0.1.6",
  availableManagedVersion: "0.1.6",
  actions: ["install", "update", "repair"],
};
const agentProvider: ServerProvider = {
  ...provider,
  driver: AGENT,
  connection: { ...provider.connection!, runtime: agentRuntime },
};

const agentTestLayer = (prefix: string) =>
  ServerConfig.layerTest(NodeOS.tmpdir(), { prefix }).pipe(
    Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );

const startAgentLoop = Effect.fn("test.startAgentLoop")(function* (
  manager: ProviderRuntimeManager["Service"],
  registry: ProviderRegistry["Service"],
  policy: AgentPolicy.ScientAgentRuntimePolicy["Service"],
) {
  yield* makeAgentBackground().pipe(
    Effect.provideService(ProviderRuntimeManager, manager),
    Effect.provideService(ProviderRegistry, registry),
    Effect.provideService(AgentPolicy.ScientAgentRuntimePolicy, policy),
    Effect.provide(Layer.mergeAll(Layer.mock(ProcessRunner)({}), Layer.mock(AnalyticsService)({}))),
    Effect.provideServiceEffect(
      ServerConfig.ServerConfig,
      ServerConfig.ServerConfig.pipe(
        Effect.map((config) => ({ ...config, mode: "desktop" as const })),
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
});

const loadAgentPolicy = Layer.build(AgentPolicy.layer).pipe(
  Effect.map((services) => Context.get(services, AgentPolicy.ScientAgentRuntimePolicy)),
);

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
      const completed = yield* awaitState(providersRef, (providers) =>
        providers.some(
          (candidate) => candidate.connection?.runtime?.operation?.status === "succeeded",
        ),
      );
      const runtime = completed[0]?.connection?.runtime;
      assert.strictEqual(runtime?.source, "scient_managed");
      assert.strictEqual(runtime?.managedVersion, "0.147.0");
      assert.strictEqual(completed[1]?.connection?.runtime?.source, "scient_managed");
      assert.strictEqual(completed[1]?.connection?.runtime?.managedVersion, "0.147.0");
      assert.strictEqual(yield* SubscriptionRef.get(reloadCountRef), 2);
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
      yield* awaitState(
        providersRef,
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
      yield* awaitState(lifecycleReleaseCountRef, (count) => count === 1);
      assert.equal(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 1);
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
      const completed = yield* awaitState(
        providersRef,
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "failed",
      );

      assert.strictEqual(
        completed[0]?.connection?.runtime?.operation?.message,
        "The runtime change finished, but Scient could not verify the resulting provider state.",
      );
      yield* awaitState(lifecycleReleaseCountRef, (count) => count === 1);
      assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 1);
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

      const completed = yield* awaitState(
        providersRef,
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

      const completed = yield* awaitState(
        providersRef,
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
      const runCount = yield* SubscriptionRef.make(0);
      const olderPlan = {
        ...installPlan(),
        catalogRevision: "reviewed:1:older-than-system",
        systemVersion: "0.200.0",
        olderThanSystem: true,
      };
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(olderPlan),
        run: () => SubscriptionRef.update(runCount, (count) => count + 1),
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
      yield* awaitState(runCount, (count) => count === 1);
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
      const runCount = yield* SubscriptionRef.make(0);
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
        run: () => SubscriptionRef.update(runCount, (count) => count + 1),
      };
      const { manager } = yield* makeHarness(actions, [
        { ...systemProvider, connection: { ...systemProvider.connection!, runtime: summary } },
      ]);
      yield* manager.start({
        instanceId: INSTANCE,
        action,
        catalogRevision: "reviewed:1:system-version-unknown",
      });
      yield* awaitState(runCount, (count) => count === 1);
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

      const waiting = yield* awaitState(
        providersRef,
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
      yield* awaitState(
        providersRef,
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
      const waiting = yield* awaitState(
        providersRef,
        (providers) => providers[0]?.connection?.runtime?.operation?.waitingForIdle === true,
      );
      const operationId = waiting[0]?.connection?.runtime?.operation?.operationId ?? "";
      assert.isDefined(started);
      yield* manager.cancel({ instanceId: INSTANCE, operationId });
      yield* awaitState(
        providersRef,
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
      assert.strictEqual(yield* SubscriptionRef.get(reloadCountRef), 0);

      yield* Ref.set(busy, false);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(reselecting), true);
      assert.strictEqual(yield* SubscriptionRef.get(reloadCountRef), 1);

      yield* Ref.set(recovered, false);
      assert.strictEqual(yield* manager.reselect(INSTANCE), false);
      assert.strictEqual(yield* SubscriptionRef.get(reloadCountRef), 1);
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
      assert.strictEqual(yield* SubscriptionRef.get(reloadCountRef), 1);
    }),
  );

  it.effect("never interrupts running work across random interleavings", () =>
    Effect.gen(function* () {
      const env = yield* HostProcess.Environment;
      const iterations = Number(env.SCIENT_RUNTIME_STRESS_ITERATIONS ?? 40);
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
          SubscriptionRef.get(providersRef).pipe(
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
        const settled = yield* awaitState(providersRef, (providers) => {
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
      yield* awaitState(
        providersRef,
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.deepStrictEqual(
        new Set(yield* Ref.get(closedInstancesRef)),
        new Set([INSTANCE, SECOND_INSTANCE]),
      );
      assert.deepStrictEqual(yield* Ref.get(reloadedInstancesRef), [INSTANCE, SECOND_INSTANCE]);
      const providers = yield* SubscriptionRef.get(providersRef);
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
      assert.strictEqual(yield* SubscriptionRef.get(reloadCountRef), 0);
    }),
  );

  it.effect("classifies a failed install from its error and the stage it reached", () =>
    Effect.gen(function* () {
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: (_action, _revision, report) =>
          report({ status: "installing", message: "Installing." }).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderConnectionActionError({
                  message: "Scient could not install the private Codex runtime.",
                  cause: new ManagedRuntimeFileError("Unsafe archive path: private/../x"),
                }),
              ),
            ),
          ),
      };
      const { manager, providersRef } = yield* makeHarness(actions, [systemProvider]);
      yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });
      const completed = yield* awaitState(
        providersRef,
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "failed",
      );
      assert.strictEqual(completed[0]?.connection?.runtime?.operation?.failureClass, "extract");
    }),
  );

  // A later try fixes a server that stayed busy, not one that does not have the file.
  it.effect.each([
    {
      caseTitle: "keeps the user's request after HTTP 429 on every try",
      cause: new ManagedRuntimeFileError("HTTP 429 on all 5 tries.", {
        failureClass: "http_4xx",
        retryable: true,
      }),
      outcome: "retryable",
    },
    {
      caseTitle: "drops the user's request after HTTP 404",
      cause: new ManagedRuntimeFileError("HTTP 404.", { failureClass: "http_4xx" }),
      outcome: "failed",
    },
  ])("$caseTitle", ({ cause, outcome }) =>
    Effect.gen(function* () {
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () =>
          Effect.fail(new ProviderConnectionActionError({ message: "Install failed.", cause })),
      };
      const { manager, requestLogRef } = yield* makeHarness(actions, [systemProvider]);
      yield* manager.start({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
      });
      assert.deepStrictEqual(yield* awaitState(requestLogRef, (log) => log.length === 2), [
        "requested:install",
        `settled:${outcome}`,
      ]);
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

      const completed = yield* awaitState(
        providersRef,
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
      assert.strictEqual(yield* SubscriptionRef.get(reloadCountRef), 0);
    }),
  );

  it.effect("runs a background install, says how it ended, and records no user request", () =>
    Effect.gen(function* () {
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(missingRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: (_action, _revision, report) =>
          report({
            status: "verifying",
            message: "Verifying.",
            download: { resumedBytes: 40, source: "fallback", compressed: true },
          }),
      };
      const { manager, providersRef, requestLogRef } = yield* makeHarness(actions);
      const outcome = yield* manager.startInBackground({
        instanceId: INSTANCE,
        action: "install",
        catalogRevision: "reviewed:1",
        attempt: 2,
      });
      assert.strictEqual(outcome, "succeeded");
      assert.deepStrictEqual(yield* SubscriptionRef.get(requestLogRef), ["settled:succeeded"]);
      const operation = (yield* SubscriptionRef.get(providersRef))[0]?.connection?.runtime
        ?.operation;
      assert.strictEqual(operation?.status, "succeeded");
      assert.strictEqual(operation?.background, true);
      assert.strictEqual(operation?.attempt, 2);
      assert.deepStrictEqual(operation?.download, {
        resumedBytes: 40,
        source: "fallback",
        compressed: true,
      });
    }),
  );

  it.effect(
    "stops a background download for the user's own change, and tells a user cancel apart",
    () =>
      Effect.gen(function* () {
        const never = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const actions: ProviderManagedRuntimeActions = {
          getSummary: Effect.succeed(missingRuntime),
          plan: () => Effect.succeed(installPlan()),
          // Only the user's change, the second run, finishes; background runs wait.
          run: () =>
            Ref.getAndUpdate(runs, (count) => count + 1).pipe(
              Effect.flatMap((count) => (count === 1 ? Effect.void : Deferred.await(never))),
            ),
        };
        const other: ServerProvider = {
          ...provider,
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
        };
        const { manager, providersRef } = yield* makeHarness(actions, [provider, other]);
        const background = () =>
          manager
            .startInBackground({
              instanceId: INSTANCE,
              action: "install",
              catalogRevision: "reviewed:1",
              attempt: 1,
            })
            .pipe(Effect.forkChild);
        const running = (providers: ReadonlyArray<ServerProvider>) =>
          providers[0]?.connection?.runtime?.operation?.status === "preparing";

        const yielded = yield* background();
        yield* awaitState(providersRef, running);
        yield* manager.start({
          instanceId: other.instanceId,
          action: "install",
          catalogRevision: "reviewed:1",
        });
        assert.strictEqual(yield* Fiber.join(yielded), "yielded");

        const cancelled = yield* background();
        const providers = yield* awaitState(providersRef, running);
        const operationId = providers[0]!.connection!.runtime!.operation!.operationId;
        yield* manager.cancel({ instanceId: INSTANCE, operationId });
        assert.strictEqual(yield* Fiber.join(cancelled), "cancelled");
      }),
  );

  it.effect.each(["same instance", "another provider"] as const)(
    "gives foreground startup priority during background summary discovery: %s",
    (choice) =>
      Effect.gen(function* () {
        const summaryStarted = yield* Deferred.make<void>();
        const summaries = yield* Ref.make(0);
        const runs = yield* SubscriptionRef.make(0);
        const actions: ProviderManagedRuntimeActions = {
          getSummary: Ref.getAndUpdate(summaries, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 0
                ? Deferred.succeed(summaryStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(missingRuntime),
            ),
          ),
          plan: () => Effect.succeed(installPlan()),
          run: () =>
            SubscriptionRef.update(runs, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
        };
        const other: ServerProvider = {
          ...provider,
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
        };
        const { manager, providersRef, coordinator, lifecycleReleaseCountRef } = yield* makeHarness(
          actions,
          [provider, other],
        );
        const background = yield* manager
          .startInBackground({
            instanceId: INSTANCE,
            action: "install",
            catalogRevision: "reviewed:1",
            attempt: 1,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(summaryStarted);
        const reserved = yield* coordinator.current(INSTANCE);
        assert.ok(reserved);
        assert.strictEqual(
          (yield* SubscriptionRef.get(providersRef))[0]?.connection?.runtime?.operation,
          null,
        );
        const foregroundInstance = choice === "same instance" ? INSTANCE : other.instanceId;
        const foreground = yield* manager.start({
          instanceId: foregroundInstance,
          action: "install",
          catalogRevision: "reviewed:1",
        });
        assert.strictEqual(yield* Fiber.join(background), "yielded");
        const operation = foreground.providers.find(
          (candidate) => candidate.instanceId === foregroundInstance,
        )?.connection?.runtime?.operation;
        assert.ok(operation);
        assert.notStrictEqual(operation.operationId, reserved.operationId);
        assert.strictEqual(
          (yield* coordinator.current(foregroundInstance))?.operationId,
          operation.operationId,
        );
        yield* awaitState(runs, (count) => count === 1);
        assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 1);
        if (choice === "another provider")
          assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
        yield* manager.cancel({
          instanceId: foregroundInstance,
          operationId: operation.operationId,
        });
        assert.strictEqual(yield* coordinator.current(foregroundInstance), undefined);
        assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 2);
      }),
  );

  it.effect.each(["waiting", "starting"] as const)(
    "exposes and durably cancels restarted pending recovery while %s",
    (phase) =>
      Effect.gen(function* () {
        const before = yield* makeRequests();
        const request = {
          requestId: "requested-before-restart",
          instanceId: INSTANCE,
          driver: CODEX,
          action: "install" as const,
          catalogRevision: "reviewed:1",
        };
        yield* before.requested(request);
        yield* before.settled({ ...request, outcome: "retryable" });
        const requests = yield* makeRequests();
        const summaryStarted = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const actions: ProviderManagedRuntimeActions = {
          getSummary: Deferred.succeed(summaryStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          plan: () => Effect.succeed(installPlan()),
          run: () => Ref.update(runs, (count) => count + 1),
        };
        const { manager, registry, providersRef, coordinator } = yield* makeHarness(
          actions,
          [provider],
          () => Effect.void,
          undefined,
          Effect.void,
          { requests },
        );
        const pending = (yield* SubscriptionRef.get(providersRef))[0]?.connection?.runtime;
        assert.strictEqual(pending?.operation, null);
        assert.strictEqual(pending?.pendingRecovery?.requestId, request.requestId);
        const background =
          phase === "starting"
            ? yield* manager.startInBackground({ ...request, attempt: 1 }).pipe(Effect.forkChild)
            : undefined;
        if (background) yield* Deferred.await(summaryStarted);
        const cancelled = yield* manager.cancel({
          instanceId: INSTANCE,
          requestId: request.requestId,
        });
        assert.isNull(cancelled.providers[0]?.connection?.runtime?.pendingRecovery);
        assert.strictEqual(cancelled.providers[0]?.connection?.runtime?.operation, null);
        if (background) assert.strictEqual(yield* Fiber.join(background), "cancelled");
        assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
        assert.deepStrictEqual(yield* requests.list, []);
        assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
        yield* makeRecovery().pipe(
          Effect.provideService(ProviderRuntimeRequests, requests),
          Effect.provideService(ProviderRuntimeManager, manager),
          Effect.provideService(ProviderRegistry, registry),
        );
        yield* TestClock.adjust("10 minutes");
        assert.strictEqual(yield* Ref.get(runs), 0);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-restarted-recovery-" }).pipe(
            Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
  );

  it.effect.each(["install", "update", "repair"] as const)(
    "keeps pending Agent %s cancellation across restart and automatic startup",
    (action) =>
      Effect.gen(function* () {
        const requests = yield* makeRequests();
        const request = {
          requestId: "pending-agent",
          instanceId: INSTANCE,
          driver: AGENT,
          action,
          catalogRevision: "reviewed:1",
        };
        yield* requests.requested(request);
        yield* requests.settled({
          ...request,
          outcome: "retryable",
          retryAfterMs: 2 * 60 * 60_000,
        });
        const restarted = yield* makeRequests();
        const policy = yield* loadAgentPolicy;
        const runs = yield* Ref.make(0);
        const summary: ProviderRuntimeSummary = {
          ...agentRuntime,
          source: action === "install" ? "missing" : "scient_managed",
          managedVersion: action === "install" ? null : "0.1.5",
        };
        const { manager, registry } = yield* makeHarness(
          {
            getSummary: Effect.succeed(summary),
            plan: () => Effect.succeed({ ...installPlan(), action, version: "0.1.6" }),
            run: () => Ref.update(runs, (count) => count + 1),
          },
          [{ ...agentProvider, connection: { ...agentProvider.connection!, runtime: summary } }],
          undefined,
          undefined,
          undefined,
          { requests: restarted, agentPolicy: policy, observeRegistryChanges: true },
        );
        yield* startAgentLoop(manager, registry, policy);
        const cancelled = yield* manager.cancel({
          instanceId: INSTANCE,
          requestId: request.requestId,
        });
        assert.isNull(cancelled.providers[0]?.connection?.runtime?.operation);
        assert.isNull(cancelled.providers[0]?.connection?.runtime?.pendingRecovery);
        assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
        const persisted = yield* (yield* loadAgentPolicy).read;
        assert.deepStrictEqual(
          persisted,
          action === "update"
            ? { skippedVersion: "0.1.6" }
            : action === "repair"
              ? { userStopped: true, skippedVersion: "0.1.6" }
              : { userStopped: true },
        );
        yield* TestClock.adjust("61 seconds");
        assert.strictEqual(yield* Ref.get(runs), 0);
      }).pipe(Effect.provide(agentTestLayer("scient-agent-pending-cancel-"))),
  );

  it.effect.each(["reviewed:1", "reviewed:2"])(
    "defers automatic Agent starts, including shared instances, until requested recovery revalidates %s",
    (reviewedPlan) =>
      Effect.gen(function* () {
        const requests = yield* makeRequests();
        const request = {
          requestId: "cooling-agent",
          instanceId: INSTANCE,
          driver: AGENT,
          action: "install" as const,
          catalogRevision: "reviewed:1",
        };
        yield* requests.requested(request);
        yield* requests.settled({
          ...request,
          outcome: "retryable",
          retryAfterMs: 2 * 60 * 60_000,
        });
        const runs = yield* Ref.make(0);
        const revision = yield* Ref.make("reviewed:1");
        const policy = yield* loadAgentPolicy;
        const { manager, registry, providersRef, lifecycleReleaseCountRef } = yield* makeHarness(
          {
            getSummary: Effect.succeed(agentRuntime),
            plan: () =>
              Ref.get(revision).pipe(
                Effect.map((catalogRevision) => ({
                  ...installPlan(),
                  version: "0.1.6",
                  catalogRevision,
                })),
              ),
            run: () => Ref.update(runs, (count) => count + 1),
          },
          [agentProvider, { ...agentProvider, instanceId: SECOND_INSTANCE }],
          undefined,
          undefined,
          undefined,
          { requests, agentPolicy: policy, observeRegistryChanges: true },
        );
        yield* startAgentLoop(manager, registry, policy);
        yield* makeRecovery().pipe(
          Effect.provideService(ProviderRuntimeRequests, requests),
          Effect.provideService(ProviderRuntimeManager, manager),
          Effect.provideService(ProviderRegistry, registry),
        );
        for (const instanceId of [INSTANCE, SECOND_INSTANCE]) {
          const error = yield* manager
            .startInBackground({
              instanceId,
              action: "install",
              catalogRevision: "reviewed:1",
              attempt: 1,
            })
            .pipe(Effect.flip);
          assert.strictEqual(error.reason, "runtime_busy");
        }
        yield* TestClock.adjust("61 seconds");
        assert.strictEqual(yield* Ref.get(runs), 0);
        yield* Ref.set(revision, reviewedPlan);
        yield* TestClock.adjust(2 * 60 * 60_000 - 61_000);
        if (reviewedPlan === "reviewed:1") {
          yield* awaitState(lifecycleReleaseCountRef, (count) => count === 1);
          assert.strictEqual(yield* Ref.get(runs), 1);
          const operation = (yield* registry.getProviders)[0]?.connection?.runtime?.operation;
          assert.strictEqual(operation?.status, "succeeded");
          assert.isTrue(operation?.background);
        } else {
          yield* awaitState(
            providersRef,
            (providers) => providers[0]?.connection?.runtime?.pendingRecovery === null,
          );
          assert.strictEqual(yield* Ref.get(runs), 0);
        }
        assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
      }).pipe(Effect.provide(agentTestLayer("scient-agent-cooldown-"))),
  );

  it.effect(
    "rechecks Agent stop policy after another instance cancels during automatic planning",
    () =>
      Effect.gen(function* () {
        const requests = yield* makeRequests();
        const pending = {
          requestId: "cancel-other-instance",
          instanceId: SECOND_INSTANCE,
          driver: AGENT,
          action: "install" as const,
          catalogRevision: "reviewed:1",
        };
        yield* requests.requested(pending);
        const policy = yield* loadAgentPolicy;
        const planning = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const { manager } = yield* makeHarness(
          {
            getSummary: Effect.succeed(agentRuntime),
            plan: () =>
              Deferred.succeed(planning, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.as({ ...installPlan(), version: "0.1.6" }),
              ),
            run: () => Ref.update(runs, (count) => count + 1),
          },
          [agentProvider, { ...agentProvider, instanceId: SECOND_INSTANCE }],
          undefined,
          undefined,
          undefined,
          { requests, agentPolicy: policy },
        );
        const automatic = yield* manager
          .startInBackground({
            instanceId: INSTANCE,
            action: "install",
            catalogRevision: "reviewed:1",
            attempt: 1,
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(planning);
        yield* manager.cancel({ instanceId: SECOND_INSTANCE, requestId: pending.requestId });
        assert.deepStrictEqual(yield* policy.read, { userStopped: true });
        assert.deepStrictEqual(yield* requests.list, []);
        yield* Deferred.succeed(resume, undefined);
        const result = yield* Fiber.join(automatic);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.strictEqual(result.failure.reason, "runtime_plan_stale");
        assert.strictEqual(yield* Ref.get(runs), 0);
      }).pipe(Effect.provide(agentTestLayer("scient-agent-policy-race-"))),
  );

  it.effect("starts the manager with an unavailable journal but rejects runtime mutations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const guardedFs = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (path, encoding) =>
          path.endsWith("requests.json")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              )
            : fs.readFileString(path, encoding),
      });
      const requests = yield* makeRequests().pipe(
        Effect.provideService(FileSystem.FileSystem, guardedFs),
      );
      const runs = yield* Ref.make(0);
      const { manager, registry } = yield* makeHarness(
        {
          getSummary: Effect.succeed(missingRuntime),
          plan: () => Effect.succeed(installPlan()),
          run: () => Ref.update(runs, (count) => count + 1),
        },
        undefined,
        undefined,
        undefined,
        undefined,
        { requests },
      );
      assert.strictEqual(
        (yield* manager.plan({ instanceId: INSTANCE, action: "install" })).version,
        "0.147.0",
      );
      const input = {
        instanceId: INSTANCE,
        action: "install" as const,
        catalogRevision: "reviewed:1",
      };
      for (const action of [
        manager.start(input).pipe(Effect.asVoid),
        manager.startInBackground({ ...input, attempt: 1 }).pipe(Effect.asVoid),
        manager
          .cancel({ instanceId: INSTANCE, requestId: "unreadable-request" })
          .pipe(Effect.asVoid),
      ]) {
        const failure = yield* action.pipe(Effect.flip);
        assert.strictEqual(failure.reason, "runtime_operation_failed");
      }
      assert.strictEqual(yield* Ref.get(runs), 0);
      assert.strictEqual((yield* registry.getProviders)[0]?.connection?.runtime?.operation, null);
    }).pipe(Effect.provide(agentTestLayer("scient-manager-unavailable-"))),
  );

  it.effect("keeps the server usable and retains intent when initial pruning cannot persist", () =>
    Effect.gen(function* () {
      const before = yield* makeRequests();
      const orphan = {
        requestId: "removed-instance",
        instanceId: ProviderInstanceId.make("removed"),
        driver: CODEX,
        action: "install" as const,
        catalogRevision: "reviewed:1",
      };
      yield* before.requested(orphan);
      const fs = yield* FileSystem.FileSystem;
      const guardedFs = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          to.endsWith("requests.json")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: to,
                }),
              )
            : fs.rename(from, to),
      });
      const requests = yield* makeRequests().pipe(
        Effect.provideService(FileSystem.FileSystem, guardedFs),
      );
      const { manager, registry } = yield* makeHarness(
        {
          getSummary: Effect.succeed(missingRuntime),
          plan: () => Effect.succeed(installPlan()),
          run: () => Effect.die("Unexpected runtime mutation"),
        },
        undefined,
        undefined,
        undefined,
        undefined,
        { requests },
      );
      assert.strictEqual(
        (yield* manager.plan({ instanceId: INSTANCE, action: "install" })).catalogRevision,
        "reviewed:1",
      );
      assert.strictEqual((yield* registry.getProviders)[0]?.instanceId, INSTANCE);
      assert.deepInclude((yield* requests.list)[0], orphan);
      assert.deepInclude((yield* (yield* makeRequests()).list)[0], orphan);
    }).pipe(Effect.provide(agentTestLayer("scient-manager-prune-denied-"))),
  );

  it.effect.each([
    { phase: "pending", file: "requests.json" },
    { phase: "active", file: "requests.json" },
    { phase: "pending", file: "scient-agent.json" },
    { phase: "active", file: "scient-agent.json" },
  ] as const)(
    "does not acknowledge $phase Agent cancellation when $file cannot be written",
    ({ phase, file }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const denied = yield* Ref.make(false);
        const guardedFs = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            Ref.get(denied).pipe(
              Effect.flatMap((fail) =>
                fail && to.endsWith(file)
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                      }),
                    )
                  : fs.rename(from, to),
              ),
            ),
        });
        const requests = yield* makeRequests().pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFs),
        );
        const request = {
          requestId: "cancel-denied",
          instanceId: INSTANCE,
          driver: AGENT,
          action: "install" as const,
          catalogRevision: "reviewed:1",
        };
        yield* requests.requested(request);
        const policy = yield* loadAgentPolicy.pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFs),
        );
        const running = yield* Deferred.make<void>();
        const { manager, coordinator } = yield* makeHarness(
          {
            getSummary: Effect.succeed(agentRuntime),
            plan: () => Effect.succeed({ ...installPlan(), version: "0.1.6" }),
            run: () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)),
          },
          [agentProvider],
          undefined,
          undefined,
          undefined,
          { requests, agentPolicy: policy },
        );
        const background =
          phase === "active"
            ? yield* manager.startInBackground({ ...request, attempt: 1 }).pipe(Effect.forkChild)
            : undefined;
        if (background) yield* Deferred.await(running);
        const before = yield* requests.list;
        yield* Ref.set(denied, true);
        const error = yield* manager
          .cancel({ instanceId: INSTANCE, requestId: request.requestId })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "runtime_operation_failed");
        assert.deepStrictEqual(yield* requests.list, before);
        assert.deepStrictEqual(yield* (yield* makeRequests()).list, before);
        if (background) assert.isDefined(yield* coordinator.current(INSTANCE));
        yield* Ref.set(denied, false);
        yield* manager.cancel({ instanceId: INSTANCE, requestId: request.requestId });
        if (background) assert.strictEqual(yield* Fiber.join(background), "cancelled");
        assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
        assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
        assert.deepStrictEqual(yield* (yield* loadAgentPolicy).read, { userStopped: true });
      }).pipe(Effect.provide(agentTestLayer("scient-agent-cancel-denied-"))),
  );

  it.effect(
    "settles background ownership after a failed persistence write and recovers on a later pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const denied = yield* Ref.make(false);
        const guardedFs = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            Ref.get(denied).pipe(
              Effect.flatMap((fail) =>
                fail && to.endsWith("requests.json")
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                      }),
                    )
                  : fs.rename(from, to),
              ),
            ),
        });
        const requests = yield* makeRequests().pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFs),
        );
        const request = {
          requestId: "settlement-denied",
          instanceId: INSTANCE,
          driver: CODEX,
          action: "install" as const,
          catalogRevision: "reviewed:1",
        };
        yield* requests.requested(request);
        const runs = yield* Ref.make(0);
        const { manager, registry, coordinator, lifecycleReleaseCountRef } = yield* makeHarness(
          {
            getSummary: Effect.succeed(missingRuntime),
            plan: () => Effect.succeed(installPlan()),
            run: () =>
              Ref.update(runs, (count) => count + 1).pipe(Effect.andThen(Ref.set(denied, true))),
          },
          [provider],
          undefined,
          undefined,
          undefined,
          { requests },
        );
        assert.strictEqual(
          yield* manager.startInBackground({ ...request, attempt: 1 }),
          "succeeded",
        );
        yield* awaitState(lifecycleReleaseCountRef, (count) => count === 1);
        assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
        assert.lengthOf(yield* requests.list, 1);
        assert.lengthOf(yield* (yield* makeRequests()).list, 1);
        yield* makeRecovery().pipe(
          Effect.provideService(ProviderRuntimeRequests, requests),
          Effect.provideService(ProviderRuntimeManager, manager),
          Effect.provideService(ProviderRegistry, registry),
        );
        // A failed lease write must not terminate recovery or start an unleased operation.
        yield* TestClock.adjust("7 minutes");
        assert.strictEqual(yield* Ref.get(runs), 1);
        yield* Ref.set(denied, false);
        yield* TestClock.adjust("1 minute");
        yield* awaitState(lifecycleReleaseCountRef, (count) => count === 2);
        assert.strictEqual(yield* Ref.get(runs), 2);
        assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
      }).pipe(Effect.provide(agentTestLayer("scient-settlement-denied-"))),
  );

  it.effect("cancels a requested foreground startup before its operation is published", () =>
    Effect.gen(function* () {
      const requests = yield* makeRequests();
      const summaryStarted = yield* Deferred.make<void>();
      const runs = yield* Ref.make(0);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Deferred.succeed(summaryStarted, undefined).pipe(Effect.andThen(Effect.never)),
        plan: () => Effect.succeed(installPlan()),
        run: () => Ref.update(runs, (count) => count + 1),
      };
      const { manager, providersRef, coordinator } = yield* makeHarness(
        actions,
        [provider],
        () => Effect.void,
        undefined,
        Effect.void,
        { requests },
      );
      const caller = yield* manager
        .start({
          instanceId: INSTANCE,
          action: "install",
          catalogRevision: "reviewed:1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(summaryStarted);
      const pending = (yield* awaitState(
        providersRef,
        (providers) => providers[0]?.connection?.runtime?.pendingRecovery != null,
      ))[0]!.connection!.runtime!;
      assert.strictEqual(pending.operation, null);
      const cancelled = yield* manager.cancel({
        instanceId: INSTANCE,
        requestId: pending.pendingRecovery!.requestId,
      });
      assert.isTrue(Exit.isFailure(yield* Fiber.await(caller)));
      assert.isNull(cancelled.providers[0]?.connection?.runtime?.pendingRecovery);
      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
      assert.strictEqual(yield* Ref.get(runs), 0);
      assert.deepStrictEqual(yield* (yield* makeRequests()).list, []);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "scient-cancel-startup-" }).pipe(
          Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
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
      assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 1);
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
        assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 1);
        assert.strictEqual(
          (yield* SubscriptionRef.get(providersRef))[0]?.connection?.runtime?.operation?.status,
          "preparing",
        );
        const inactive = yield* manager
          .cancel({ instanceId: INSTANCE, operationId })
          .pipe(Effect.flip);
        assert.strictEqual(inactive.reason, "runtime_operation_not_found");

        yield* closeManager;
        assert.strictEqual(yield* Ref.get(runInterruptions), 1);
        assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 1);
      }),
  );

  it.effect("keeps a runtime change going when its caller disconnects during planning", () =>
    Effect.gen(function* () {
      const planStarted = yield* Deferred.make<void>();
      const planGate = yield* Deferred.make<void>();
      const runCount = yield* Ref.make(0);
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () =>
          Deferred.succeed(planStarted, undefined).pipe(
            Effect.andThen(Deferred.await(planGate)),
            Effect.as(installPlan()),
          ),
        run: () => Ref.update(runCount, (count) => count + 1),
      };
      const { manager, providersRef, coordinator, lifecycleReleaseCountRef } = yield* makeHarness(
        actions,
        [systemProvider],
      );

      const caller = yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(planStarted);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(planGate, undefined);

      yield* awaitState(
        providersRef,
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.strictEqual(yield* Ref.get(runCount), 1);
      yield* awaitState(lifecycleReleaseCountRef, (count) => count === 1);
      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
    }),
  );

  it.effect("releases the runtime reservation when shutdown interrupts summary discovery", () =>
    Effect.gen(function* () {
      const summaryStarted = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Deferred.succeed(summaryStarted, undefined).pipe(Effect.andThen(Effect.never)),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
      };
      const { manager, coordinator, closeManager } = yield* makeHarness(actions);

      yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(summaryStarted);
      yield* closeManager;

      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
    }),
  );

  it.effect("releases the runtime reservation when initial summary discovery stalls", () =>
    Effect.gen(function* () {
      const summaryStarted = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Deferred.succeed(summaryStarted, undefined).pipe(Effect.andThen(Effect.never)),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
      };
      const { manager, coordinator, lifecycleReleaseCountRef } = yield* makeHarness(actions);

      const caller = yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(summaryStarted);
      yield* Fiber.interrupt(caller);
      assert.notStrictEqual(yield* coordinator.current(INSTANCE), undefined);
      yield* TestClock.adjust("2 minutes");

      yield* awaitState(lifecycleReleaseCountRef, (count) => count === 1);
      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
    }),
  );

  it.effect("releases the runtime reservation when initial publication is interrupted", () =>
    Effect.gen(function* () {
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
            runtime?.operation?.status === "preparing" ? Effect.interrupt : Effect.void,
        },
      );

      const exit = yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.exit);

      // The manager stays open, so only the startup's own cleanup can release it.
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
    }),
  );

  it.effect("releases the runtime reservation when shutdown interrupts initial publication", () =>
    Effect.gen(function* () {
      const publicationStarted = yield* Deferred.make<void>();
      const actions: ProviderManagedRuntimeActions = {
        getSummary: Effect.succeed(systemRuntime),
        plan: () => Effect.succeed(installPlan()),
        run: () => Effect.die("must not run"),
      };
      const { manager, coordinator, closeManager } = yield* makeHarness(
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

      yield* manager
        .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(publicationStarted);
      yield* closeManager;

      assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
    }),
  );

  it.effect(
    "publishes cancellation when shutdown interrupts a startup whose runtime state is visible",
    () =>
      Effect.gen(function* () {
        const publicationCommitted = yield* Deferred.make<void>();
        const actions: ProviderManagedRuntimeActions = {
          getSummary: Effect.succeed(systemRuntime),
          plan: () => Effect.succeed(installPlan()),
          run: () => Effect.die("must not run"),
        };
        const { manager, coordinator, providersRef, closeManager } = yield* makeHarness(
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

        yield* manager
          .start({ instanceId: INSTANCE, action: "install", catalogRevision: "reviewed:1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(publicationCommitted);
        yield* closeManager;

        assert.strictEqual(yield* coordinator.current(INSTANCE), undefined);
        assert.strictEqual(
          (yield* SubscriptionRef.get(providersRef))[0]?.connection?.runtime?.operation?.status,
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
      yield* awaitState(reloadCountRef, (count) => count === 1);

      const cancellationFailure = yield* manager
        .cancel({ instanceId: INSTANCE, operationId })
        .pipe(Effect.flip);

      assert.strictEqual(cancellationFailure.reason, "runtime_operation_not_found");
      assert.strictEqual(
        cancellationFailure.message,
        "The runtime change is already being finalized and can no longer be cancelled.",
      );
      assert.strictEqual(
        (yield* SubscriptionRef.get(providersRef))[0]?.connection?.runtime?.operation?.status,
        "activating",
      );
      assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 0);

      yield* Deferred.succeed(reloadGate, undefined);
      const completed = yield* awaitState(
        providersRef,
        (providers) => providers[0]?.connection?.runtime?.operation?.status === "succeeded",
      );
      assert.strictEqual(completed[0]?.connection?.runtime?.operation?.status, "succeeded");
      yield* awaitState(lifecycleReleaseCountRef, (count) => count === 1);
      assert.strictEqual(yield* SubscriptionRef.get(lifecycleReleaseCountRef), 1);
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
