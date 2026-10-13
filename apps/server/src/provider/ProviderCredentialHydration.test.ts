import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { makeNativeSessionAdapterV2 } from "../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { SettingsDirectoryWatch, SettingsFileMetadata } from "../settingsDirectoryWatch.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import {
  deriveProviderInstanceConfigMap,
  layerSettingsWatcher,
} from "./ProviderInstanceRegistryHydration.ts";
import * as Mutator from "./ProviderInstanceRegistryMutator.ts";

const driverKind = ProviderDriverKind.make("antigravity");
const first = ProviderInstanceId.make("credential-first");
const second = ProviderInstanceId.make("credential-second");
const bystander = ProviderInstanceId.make("credential-bystander");
const unrelatedSecret = "usage-limit-source-dW5yZWxhdGVk";
const unused = () => Effect.die("Unrelated provider operation must not execute");
const sessionInput = (instanceId: ProviderInstanceId) => ({
  threadId: ThreadId.make(`thread:${instanceId}`),
  providerSessionId: ProviderSessionId.make(`session:${instanceId}`),
  modelSelection: { instanceId, model: "synthetic-model" },
  runtimePolicy: {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: null,
  },
});

it.effect.each(["remove", "disable"] as const)(
  "reconciles provider %s during an unrelated secret-read failure and restores current credentials",
  (revocation) =>
    Effect.scoped(
      Effect.gen(function* () {
        let failSecretRead = false;
        const hints = yield* PubSub.unbounded<string>();
        yield* Effect.addFinalizer(() => PubSub.shutdown(hints));
        const secretLayer = Layer.effect(
          SecretStore.ServerSecretStore,
          Effect.gen(function* () {
            const store = yield* SecretStore.ServerSecretStore;
            return {
              ...store,
              get: (name: string) =>
                failSecretRead && name === unrelatedSecret
                  ? Effect.fail(
                      new SecretStore.SecretStoreReadError({
                        resource: "synthetic key",
                        cause: "injected",
                      }),
                    )
                  : store.get(name),
            };
          }),
        ).pipe(Layer.provide(SecretStore.layer));
        const base = Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "credential-hydration-" }),
          Sqlite.layerMemory,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const settingsLayer = Settings.layer.pipe(
          Layer.provideMerge(secretLayer),
          Layer.provideMerge(base),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(SettingsDirectoryWatch, {
                acquire: () => PubSub.subscribe(hints).pipe(Effect.map(Stream.fromSubscription)),
              }),
              Layer.succeed(SettingsFileMetadata, {
                readFingerprint: () => Effect.succeed("controlled-watch-hints"),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* SecretStore.ServerSecretStore;
          const settings = yield* Settings.ServerSettingsService;
          const allocator = yield* IdAllocator.IdAllocatorV2;
          yield* store.set(unrelatedSecret, new TextEncoder().encode("unrelated-key"));
          yield* fs.writeFileString(
            config.settingsPath,
            JSON.stringify({
              providerInstances: {
                [first]: { driver: driverKind, config: { apiKey: "first-key" } },
                [second]: { driver: driverKind, config: { apiKey: "second-key" } },
                [bystander]: { driver: driverKind, config: { apiKey: "" } },
              },
              usageLimitSources: {
                unrelated: {
                  kind: "cliproxy",
                  url: "https://unused.invalid",
                  managementKey: SECRET_REDACTED,
                },
              },
            }),
          );
          yield* settings.start;
          yield* settings.ready;
          const changes = yield* settings.subscribeChanges;
          const created: Array<{ instanceId: ProviderInstanceId; key: string; enabled: boolean }> =
            [];
          const closed: ProviderInstanceId[] = [];
          const reached: ProviderInstanceId[] = [];
          const driver: ProviderDriver<AntigravitySettings> = {
            driverKind,
            metadata: { displayName: "Synthetic credential provider" },
            configSchema: AntigravitySettings,
            defaultConfig: () => Schema.decodeSync(AntigravitySettings)({}),
            create: ({ instanceId, config: providerConfig, enabled }) =>
              Effect.sync(() => {
                created.push({ instanceId, key: providerConfig.apiKey, enabled });
                return {
                  instanceId,
                  driverKind,
                  enabled,
                  displayName: undefined,
                  continuationIdentity: defaultProviderContinuationIdentity({
                    driverKind,
                    instanceId,
                  }),
                  snapshot: {} as ProviderInstance["snapshot"],
                  textGeneration: {} as ProviderInstance["textGeneration"],
                  orchestrationAdapter: makeNativeSessionAdapterV2({
                    instanceId,
                    driver: driverKind,
                    idAllocator: allocator,
                    defaultCwd: "/synthetic",
                    capabilities: AcpProviderCapabilitiesV2,
                    continuations: { offer: () => Effect.void },
                    open: () =>
                      Effect.gen(function* () {
                        yield* Effect.addFinalizer(() =>
                          Effect.sync(() => {
                            closed.push(instanceId);
                          }),
                        );
                        return {
                          nativeId: `synthetic:${instanceId}`,
                          nativeThreadKnown: false,
                          send: unused,
                          resume: unused,
                          interrupt: Effect.void,
                          respond: () =>
                            Effect.sync(() => {
                              reached.push(instanceId);
                            }),
                        };
                      }),
                  }),
                } satisfies ProviderInstance;
              }),
          };
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: deriveProviderInstanceConfigMap(yield* settings.getSettings),
          });
          yield* Layer.build(
            layerSettingsWatcher(changes).pipe(
              Layer.provide(Layer.succeed(Mutator.ProviderInstanceRegistryMutator, mutator)),
            ),
          );
          const instance = yield* registry.getInstance(first);
          assert.isDefined(instance);
          const runtime = yield* instance!.orchestrationAdapter.openSession(sessionInput(first));
          const untouched = yield* registry.getInstance(bystander);
          const observed = yield* registry.subscribeChanges;
          const persisted = yield* fs.readFileString(config.settingsPath);
          assert.notInclude(persisted, "first-key");
          assert.notInclude(persisted, "second-key");
          const next = JSON.parse(persisted);
          if (revocation === "remove") delete next.providerInstances[first];
          else next.providerInstances[first].enabled = false;
          failSecretRead = true;
          yield* writeFileStringAtomically({
            filePath: config.settingsPath,
            contents: JSON.stringify(next),
          });
          yield* PubSub.publish(hints, path.basename(config.settingsPath));
          yield* PubSub.take(observed).pipe(Effect.timeout("5 seconds"));
          assert.isUndefined(yield* registry.getInstance(first));
          assert.isUndefined(yield* registry.getInstance(second));
          const unavailable = yield* registry.listUnavailable;
          assert.isTrue(
            unavailable.some(
              (entry) => entry.instanceId === second && entry.availability === "unavailable",
            ),
          );
          assert.equal(
            unavailable.some((entry) => entry.instanceId === first),
            revocation === "disable",
          );
          assert.strictEqual(yield* registry.getInstance(bystander), untouched);
          assert.deepEqual(closed, [first]);
          assert.equal(runtime.providerSession.status, "stopped");
          assert.equal(
            (yield* Effect.result(
              runtime.respondToRuntimeRequest({ requestId: RuntimeRequestId.make("stale") }),
            ))._tag,
            "Failure",
          );
          assert.equal(
            (yield* Effect.result(instance!.orchestrationAdapter.openSession(sessionInput(first))))
              ._tag,
            "Failure",
          );
          assert.deepEqual(reached, []);
          assert.deepEqual(
            created
              .filter(({ instanceId }) => [first, second, bystander].includes(instanceId))
              .map(({ key }) => key),
            ["first-key", "second-key", ""],
          );

          failSecretRead = false;
          yield* writeFileStringAtomically({
            filePath: config.settingsPath,
            contents: JSON.stringify({ ...next, composerCollapseOnScroll: true }),
          });
          yield* PubSub.publish(hints, path.basename(config.settingsPath));
          yield* PubSub.take(observed).pipe(Effect.timeout("5 seconds"));
          assert.isDefined(yield* registry.getInstance(second));
          assert.isFalse(
            (yield* registry.listUnavailable).some(
              (entry) => entry.instanceId === first || entry.instanceId === second,
            ),
          );
          if (revocation === "disable")
            assert.isFalse((yield* registry.getInstance(first))!.enabled);
          else assert.isUndefined(yield* registry.getInstance(first));
          assert.strictEqual(yield* registry.getInstance(bystander), untouched);
          assert.isFalse(created.some(({ key }) => key === SECRET_REDACTED));
          assert.deepEqual(
            created.filter(({ instanceId }) => instanceId === second).map(({ key }) => key),
            ["second-key", "second-key"],
          );
        }).pipe(Effect.provide(settingsLayer));
      }),
    ).pipe(TestClock.withLive),
);
