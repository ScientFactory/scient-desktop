import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";

import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { mergeProviderSnapshot, layer as ProviderRegistryLive } from "./ProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});

process.env.T3CODE_CURSOR_ENABLED = "1";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const withBundledCompatibility = (snapshot: ServerProvider) =>
  applyProviderCompatibility(
    snapshot,
    undefined,
    ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
  );

const TestHttpClientLive = Layer.merge(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
    ),
  ),
  Layer.succeed(
    PtyAdapter.PtyAdapter,
    PtyAdapter.PtyAdapter.of({
      spawn: () => Effect.die("PTY must not start in provider registry tests"),
    }),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ModelManifest.layerTest,
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
    ),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

const noClaudeCapabilities = () =>
  Effect.sync(() => undefined as TestClaudeCapabilities | undefined);

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

const TestNodeServices = Layer.mergeAll(
  NodeServices.layer,
  Layer.mock(CodexInstallation.CodexInstallation)({
    managedDirectory: "unused-managed-installation",
  }),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
);

it.layer(Layer.mergeAll(TestNodeServices, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("replaces cached Claude aliases with its authoritative curated and custom catalog", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-08-09T00:00:00.000Z",
          version: "2.1.170",
          models: [
            {
              slug: "default",
              name: "Default (recommended)",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-08-09T00:01:00.000Z",
          models: [
            {
              slug: "claude-sonnet-4-6",
              name: "Sonnet 4.6",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "laboratory-preview",
              name: "laboratory-preview",
              isCustom: true,
              capabilities: null,
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).models,
          refreshedProvider.models,
        );
      });

      it("drops stale Droid models missing from a successful refresh", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("droid"),
          driver: ProviderDriverKind.make("droid"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-08-21T00:00:00.000Z",
          version: "0.200.0",
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "retired-model",
              name: "Retired Model",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-08-21T00:01:00.000Z",
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...refreshedProvider.models,
        ]);
      });

      it("treats successful Pi discovery as authoritative while retaining failed-probe metadata", () => {
        const previous: ServerProvider = {
          driver: ProviderDriverKind.make("pi"),
          instanceId: ProviderInstanceId.make("pi"),
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "unknown" },
          version: null,
          checkedAt: "2026-08-31T00:00:00.000Z",
          models: [
            {
              slug: "local/test",
              name: "Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "thinkingLevel",
                    type: "select",
                    label: "Thinking",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
          slashCommands: [{ name: "skill:test" }],
          skills: [],
        };
        const empty: ServerProvider = {
          ...previous,
          status: "warning",
          auth: { status: "unauthenticated", type: "pi" },
          models: [],
          slashCommands: [],
        };
        assert.deepStrictEqual(mergeProviderSnapshot(previous, empty).models, []);
        assert.deepStrictEqual(mergeProviderSnapshot(previous, empty).slashCommands, []);
        const failed: ServerProvider = {
          ...empty,
          status: "error",
          auth: { status: "unknown" },
        };
        assert.deepStrictEqual(mergeProviderSnapshot(previous, failed).models, previous.models);
        assert.deepStrictEqual(
          mergeProviderSnapshot(previous, failed).slashCommands,
          previous.slashCommands,
        );
        assert.strictEqual(
          mergeProviderSnapshot(previous, {
            ...previous,
            models: [{ ...previous.models[0]!, capabilities: null }],
          }).models[0]?.capabilities,
          null,
        );
      });

      it("replaces Scient Agent's models on a successful discovery and keeps them when the check fails", () => {
        const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
        const previous: ServerProvider = {
          driver: ProviderDriverKind.make("scient"),
          instanceId: ProviderInstanceId.make("scient"),
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "unknown" },
          version: "0.1.0",
          checkedAt: "2026-10-02T00:00:00.000Z",
          models: [model("scient_one/model-a"), model("scient_two/model-b")],
          slashCommands: [],
          skills: [],
        };
        // A connection was detached: its model must leave the picker.
        const refreshed: ServerProvider = { ...previous, models: [model("scient_one/model-a")] };
        assert.deepStrictEqual(mergeProviderSnapshot(previous, refreshed).models, refreshed.models);
        // The agent has no model left at all.
        const empty: ServerProvider = { ...previous, status: "warning", models: [] };
        assert.deepStrictEqual(mergeProviderSnapshot(previous, empty).models, []);
        const failed: ServerProvider = { ...empty, status: "error" };
        assert.deepStrictEqual(mergeProviderSnapshot(previous, failed).models, previous.models);
        // A model that lost its reasoning levels must not keep the old selector.
        const withReasoning: ServerProvider = {
          ...previous,
          models: [
            {
              ...model("scient_one/model-a"),
              capabilities: {
                optionDescriptors: [
                  {
                    id: "thinkingLevel",
                    type: "select",
                    label: "Thinking",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        };
        assert.strictEqual(
          mergeProviderSnapshot(withReasoning, refreshed).models[0]?.capabilities,
          null,
        );
      });

      it("retains stale Droid models when the installed CLI probe fails", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("droid"),
          driver: ProviderDriverKind.make("droid"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-08-21T00:00:00.000Z",
          version: "0.200.0",
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const failedRefreshProvider = {
          ...previousProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-08-21T00:01:00.000Z",
          models: [],
          message: "Droid ACP startup failed.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, failedRefreshProvider).models,
          [...previousProvider.models],
        );
      });

      it("distinguishes unknown from authoritative-empty Droid capabilities", () => {
        const knownCapabilities = createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "high", label: "High", isDefault: true },
            ]),
          ],
        });
        const previousProvider = {
          instanceId: ProviderInstanceId.make("droid"),
          driver: ProviderDriverKind.make("droid"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-08-21T00:00:00.000Z",
          version: "0.200.0",
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: knownCapabilities,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const unknownRefresh = {
          ...previousProvider,
          checkedAt: "2026-08-21T00:01:00.000Z",
          models: [{ ...previousProvider.models[0]!, capabilities: null }],
        } satisfies ServerProvider;
        const knownEmptyRefresh = {
          ...previousProvider,
          checkedAt: "2026-08-21T00:02:00.000Z",
          models: [
            {
              ...previousProvider.models[0]!,
              capabilities: createModelCapabilities({ optionDescriptors: [] }),
            },
          ],
        } satisfies ServerProvider;

        assert.strictEqual(
          mergeProviderSnapshot(previousProvider, unknownRefresh).models[0]?.capabilities,
          knownCapabilities,
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, knownEmptyRefresh).models[0]?.capabilities
            ?.optionDescriptors,
          [],
        );
      });

      it.effect("does not publish an older provider snapshot after terminal runtime state", () =>
        Effect.gen(function* () {
          const cursorDriver = ProviderDriverKind.make("cursor");
          const cursorInstanceId = ProviderInstanceId.make("cursor");
          const activeRuntime = {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["repair", "remove"],
            managedVersion: "2026.08.11-e8db854",
            previousManagedVersion: null,
            operation: {
              operationId: "runtime-cursor-install",
              action: "install",
              status: "activating",
              startedAt: "2026-08-23T00:00:00.000Z",
              finishedAt: null,
              message: "Activating the verified Cursor runtime.",
            },
            message: "Scient manages this Cursor runtime.",
          } as const;
          const terminalRuntime = {
            ...activeRuntime,
            operation: {
              ...activeRuntime.operation,
              status: "succeeded",
              finishedAt: "2026-08-23T00:00:01.000Z",
              message: "The provider runtime was installed and verified.",
            },
          } as const;
          const initialProvider = {
            instanceId: cursorInstanceId,
            driver: cursorDriver,
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unauthenticated" },
            checkedAt: "2026-08-23T00:00:00.000Z",
            version: "2026.08.11-e8db854",
            models: [],
            slashCommands: [],
            skills: [],
            connection: {
              methods: ["cursor_browser"],
              canDisconnect: false,
              operation: null,
              runtime: { ...activeRuntime, operation: null },
            },
          } as const satisfies ServerProvider;
          const refreshedProvider = {
            ...initialProvider,
            checkedAt: "2026-08-23T00:00:00.500Z",
          } satisfies ServerProvider;
          const sourceChanges = yield* PubSub.unbounded<ServerProvider>();
          const cacheWriteStarted = yield* Deferred.make<void>();
          const releaseCacheWrite = yield* Deferred.make<void>();
          const threeEventsObserved = yield* Deferred.make<void>();
          const fileSystem = yield* FileSystem.FileSystem;
          const delayedFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            writeFileString: (path, contents, options) =>
              contents.includes(refreshedProvider.checkedAt)
                ? Deferred.succeed(cacheWriteStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCacheWrite)),
                    Effect.andThen(fileSystem.writeFileString(path, contents, options)),
                  )
                : fileSystem.writeFileString(path, contents, options),
          });
          const instance = {
            instanceId: cursorInstanceId,
            driverKind: cursorDriver,
            continuationIdentity: {
              driverKind: cursorDriver,
              continuationKey: "cursor:instance:cursor",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: cursorDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(initialProvider),
              applyUsageLimits: () => Effect.void,
              refresh: Effect.never,
              streamChanges: Stream.fromPubSub(sourceChanges),
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
              rebuildInstance: () => Effect.void,
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-publish-order-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, delayedFileSystem)),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const observedStatuses = yield* Ref.make<ReadonlyArray<string | null>>([]);
            yield* registry.streamChanges.pipe(
              Stream.runForEach((providers) =>
                Ref.updateAndGet(observedStatuses, (statuses) => [
                  ...statuses,
                  providers.find((provider) => provider.instanceId === cursorInstanceId)?.connection
                    ?.runtime?.operation?.status ?? null,
                ]).pipe(
                  Effect.flatMap((statuses) =>
                    statuses.length >= 3
                      ? Deferred.succeed(threeEventsObserved, undefined)
                      : Effect.void,
                  ),
                ),
              ),
              Effect.forkScoped,
            );
            yield* Effect.yieldNow;

            yield* registry.setProviderManagedRuntimeSummary({
              instanceId: cursorInstanceId,
              runtime: activeRuntime,
            });
            yield* PubSub.publish(sourceChanges, refreshedProvider);
            yield* Deferred.await(cacheWriteStarted).pipe(
              Effect.timeout("5 seconds"),
              TestClock.withLive,
            );
            yield* registry.setProviderManagedRuntimeSummary({
              instanceId: cursorInstanceId,
              runtime: terminalRuntime,
            });
            yield* Deferred.succeed(releaseCacheWrite, undefined);
            yield* Deferred.await(threeEventsObserved).pipe(
              Effect.timeout("5 seconds"),
              TestClock.withLive,
            );

            assert.deepStrictEqual(yield* Ref.get(observedStatuses), [
              "activating",
              "activating",
              "succeeded",
            ]);
            assert.strictEqual(
              (yield* registry.getProviders)[0]?.connection?.runtime?.operation?.status,
              "succeeded",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        // Upstream's same-named case lives in ProviderRegistry.test.ts; this one also covers
        // Scient's strict refresh and reload (ScientProviderReload).
        "returns the cached list on a failed manual refresh while strict refresh and reload report it",
        () =>
          Effect.gen(function* () {
            const codexDriver = ProviderDriverKind.make("codex");
            const codexInstanceId = ProviderInstanceId.make("codex");
            const cachedProvider = {
              instanceId: codexInstanceId,
              driver: codexDriver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt: "2026-04-29T10:00:00.000Z",
              version: "1.0.0",
              models: [],
              slashCommands: [],
              skills: [],
            } as const satisfies ServerProvider;
            const instance = {
              instanceId: codexInstanceId,
              driverKind: codexDriver,
              continuationIdentity: {
                driverKind: codexDriver,
                continuationKey: "codex:instance:codex",
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                resolveMaintenance: () =>
                  Effect.succeed(
                    makeManualOnlyProviderMaintenanceCapabilities({
                      provider: codexDriver,
                      packageName: null,
                    }),
                  ),
                getSnapshot: Effect.succeed(cachedProvider),
                refresh: Effect.die(new Error("simulated refresh failure")),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
            const instanceRegistryLayer = Layer.succeed(
              ProviderInstanceRegistry.ProviderInstanceRegistry,
              {
                getInstance: (instanceId) =>
                  Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
                rebuildInstance: () => Effect.void,
                listInstances: Effect.succeed([instance]),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                  PubSub.subscribe(pubsub),
                ),
              },
            );
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const runtimeServices = yield* Layer.build(
              ProviderRegistryLive.pipe(
                Layer.provideMerge(instanceRegistryLayer),
                Layer.provideMerge(
                  ServerConfig.layerTest(process.cwd(), {
                    prefix: "t3-provider-registry-refresh-failure-",
                  }),
                ),
                Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
                Layer.provideMerge(NodeServices.layer),
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;

              assert.deepStrictEqual(yield* registry.getProviders, [
                withBundledCompatibility(cachedProvider),
              ]);
              assert.deepStrictEqual(yield* registry.refresh(codexDriver), [
                withBundledCompatibility(cachedProvider),
              ]);
              assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
                withBundledCompatibility(cachedProvider),
              ]);
              const strictRefreshError = yield* registry
                .refreshInstanceStrict(codexInstanceId)
                .pipe(Effect.flip);
              assert.strictEqual(strictRefreshError.operation, "refresh");
              assert.strictEqual(strictRefreshError.instanceId, codexInstanceId);
              assert.deepStrictEqual(yield* registry.reloadInstance(codexInstanceId), [
                withBundledCompatibility(cachedProvider),
              ]);
              const strictReloadError = yield* registry
                .reloadInstanceStrict(codexInstanceId)
                .pipe(Effect.flip);
              assert.strictEqual(strictReloadError.operation, "reload");
              assert.strictEqual(strictReloadError.instanceId, codexInstanceId);

              const missingInstanceId = ProviderInstanceId.make("missing");
              const missingRefreshError = yield* registry
                .refreshInstanceStrict(missingInstanceId)
                .pipe(Effect.flip);
              assert.strictEqual(missingRefreshError.operation, "refresh");
              assert.strictEqual(missingRefreshError.instanceId, missingInstanceId);
              const missingReloadError = yield* registry
                .reloadInstanceStrict(missingInstanceId)
                .pipe(Effect.flip);
              assert.strictEqual(missingReloadError.operation, "reload");
              assert.strictEqual(missingReloadError.instanceId, missingInstanceId);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );
    });

    // ── checkClaudeProviderStatus tests ──────────────────────────

    describe("checkClaudeProviderStatus", () => {
      it.effect("ignores SDK model aliases and preserves the curated versioned catalog", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(defaultClaudeSettings, () =>
            Effect.succeed({
              email: undefined,
              subscriptionType: undefined,
              tokenSource: undefined,
              apiKeySource: undefined,
              apiProvider: undefined,
              slashCommands: [],
              models: [
                {
                  value: "default",
                  displayName: "Default (recommended)",
                  description: "Moving provider alias",
                },
              ],
            }),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(
            status.models.some(
              (model) => model.slug === "default" || model.name === "Default (recommended)",
            ),
            false,
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-5"),
            true,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.219\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("keeps a confirmed account distinct when initialization is unavailable", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(
            status.message,
            "Claude is signed in, but Scient could not complete its readiness check.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return {
                  stdout: '{"loggedIn":true}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
