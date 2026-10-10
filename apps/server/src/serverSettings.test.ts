import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ANTIGRAVITY_DEFAULT_MODEL,
  DROID_DEFAULT_MODEL,
  DroidSettings,
  SCIENT_DEFAULT_TEXT_GENERATION_MODEL,
  type CustomModel,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  UsageAccountingSourceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Logger from "effect/Logger";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { customModelSecretName } from "./customModels.ts";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerSettingsModule from "./serverSettings.ts";
import {
  SettingsDirectoryWatch,
  SettingsFileMetadata,
  acquireSettingsMetadataChanges,
} from "./settingsDirectoryWatch.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));
const encodeSettingsJson = Schema.encodeEffect(Schema.fromJsonString(ServerSettings));

const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const makeServerSettingsLayer = (
  secretLayer = ServerSecretStore.layer,
  configLayer = Layer.fresh(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-server-settings-test-" }),
  ),
) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(secretLayer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(configLayer),
  );

/** Like `layerServerSettings`, but also exposes the secret store for assertions. */
const layerServerSettingsWithSecrets = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const layerFailingSecretStore = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

it("redacts OpenRouter accounting management keys from client settings", () => {
  const sourceId = UsageAccountingSourceId.make("openrouter");
  const redacted = ServerSettingsModule.redactServerSettingsForClient({
    ...DEFAULT_SERVER_SETTINGS,
    usageAccountingSources: {
      [sourceId]: {
        kind: "openrouter",
        label: "Billing",
        managementKey: "never-return-this-key",
        enabled: true,
      },
    },
  });
  assert.equal(redacted.usageAccountingSources[sourceId]?.managementKey, "••••••");
  assert.equal(JSON.stringify(redacted).includes("never-return-this-key"), false);
});

const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });

const fallbackProviderDrivers = [
  "codex",
  "claudeAgent",
  "cursor",
  "muse",
  "grok",
  "opencode",
  "droid",
  "pi",
  "omp",
  "antigravity",
  "scient",
] as const;

const providerInstance = (driver: string, enabled: boolean, config: unknown = {}) => ({
  driver: ProviderDriverKind.make(driver),
  enabled,
  config,
});

const providerInstancesForDrivers = (
  drivers: ReadonlyArray<string>,
  enabledDrivers: ReadonlyArray<string> = [],
) =>
  Object.fromEntries(
    drivers.map((driver) => [
      ProviderInstanceId.make(driver),
      providerInstance(driver, enabledDrivers.includes(driver)),
    ]),
  );

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("rejects subscription-sharing activation without persisting settings or secrets", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const before = yield* service.getSettings;
      const id = ProviderInstanceId.make("deferred-personal");
      const instanceResult = yield* Effect.exit(
        service.updateSettings({
          providerInstances: {
            [id]: { driver: ProviderDriverKind.make("codex"), config: { setupMode: "managed" } },
          },
        }),
      );
      assert.equal(instanceResult._tag, "Failure");
      assert.deepEqual(yield* service.getSettings, before);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  const modelConnection = {
    id: "metadata",
    name: "OpenRouter",
    protocol: "openai-completions" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      {
        id: "model",
        modelId: "vendor/test",
        name: "Test",
        configurationMode: "automatic" as const,
        images: false,
        reasoning: false,
        instanceIds: [ProviderInstanceId.make("pi")],
      },
    ],
  };
  const modelResponse = (images = false) =>
    Response.json({
      data: [
        {
          id: "vendor/test",
          context_length: 200000,
          top_provider: { max_completion_tokens: 32000 },
          architecture: { input_modalities: images ? ["text", "image"] : ["text"] },
          reasoning: { supported_efforts: ["high"] },
        },
      ],
    });

  it.effect(
    "persists, preserves, and removes OpenRouter accounting keys through the secret store",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const sourceId = UsageAccountingSourceId.make("openrouter-primary");

        yield* service.updateSettings({
          usageAccountingSources: {
            [sourceId]: {
              kind: "openrouter",
              label: "Primary",
              managementKey: "management-secret",
              enabled: true,
            },
          },
        });
        assert.equal(
          (yield* service.getSettings).usageAccountingSources[sourceId]?.managementKey,
          "management-secret",
        );
        const persisted = yield* fs.readFileString(config.settingsPath);
        assert.notInclude(persisted, "management-secret");
        assert.include(persisted, "••••••");

        yield* service.updateSettings({
          usageAccountingSources: {
            [sourceId]: {
              kind: "openrouter",
              label: "Renamed",
              managementKey: "••••••",
              enabled: true,
            },
          },
        });
        const preserved = (yield* service.getSettings).usageAccountingSources[sourceId];
        assert.equal(preserved?.managementKey, "management-secret");
        assert.equal(preserved?.label, "Renamed");

        const secretFiles = (yield* fs.readDirectory(config.secretsDir)).filter((name) =>
          name.startsWith("usage-accounting-source-"),
        );
        assert.lengthOf(secretFiles, 1);
        yield* service.updateSettings({ usageAccountingSources: { [sourceId]: null } });
        assert.isUndefined((yield* service.getSettings).usageAccountingSources[sourceId]);
        assert.isFalse(yield* fs.exists(`${config.secretsDir}/${secretFiles[0]}`));
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists setup evidence once; settings and runtime reads never fetch metadata", () =>
    Effect.gen(function* () {
      const fetch = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(globalThis, "fetch").mockImplementation(async () => modelResponse()),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const saved = yield* service.saveCustomModel({
          revision: 0,
          connection: modelConnection,
          apiKey: Redacted.make("fixture-key"),
        });
        assert.equal(fetch.mock.calls.length, 1);
        assert.equal(saved.connections[0]?.models[0]?.reasoningMetadata?.contextWindow, 200000);
        assert.equal(saved.connections[0]?.models[0]?.contextWindow, undefined);
        fetch.mockImplementation(async () => {
          throw new Error("Unexpected hot-path lookup");
        });
        for (let n = 0; n < 3; n++) {
          assert.deepEqual((yield* service.getSettings).customModels, saved);
          const resolved = yield* service.resolveCustomModels(ProviderInstanceId.make("pi"));
          assert.deepEqual(resolved[0]?.models, saved.connections[0]?.models);
        }
        const persisted = yield* decodeSettingsJson(yield* fs.readFileString(config.settingsPath));
        assert.deepEqual(persisted.customModels, saved);
        assert.equal(fetch.mock.calls.length, 1);
      }).pipe(Effect.provide(makeServerSettingsLayer()));
    }).pipe(Effect.scoped),
  );

  it.effect.each(
    (["automatic", "overrides", "legacy"] as const).map((scenario) => ({
      caseTitle: `restores ${scenario} model capabilities after a settings-service restart`,
      scenario,
    })),
  )("$caseTitle", ({ scenario }) =>
    Effect.gen(function* () {
      const fetch = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(globalThis, "fetch").mockImplementation(async () => modelResponse(true)),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const model: CustomModel = {
        ...modelConnection.models[0]!,
        ...(scenario === "automatic"
          ? { imageInput: "automatic" as const }
          : {
              configurationMode: "manual" as const,
              contextWindow: 64000,
              maxOutputTokens: 8000,
              images: true,
              reasoning: true,
              ...(scenario === "overrides"
                ? {
                    imageInput: "enabled" as const,
                    reasoningOverride: { supported: true, levels: ["high" as const] },
                    defaultReasoningLevel: "high" as const,
                  }
                : {}),
            }),
      };
      // Keep only the synthetic filesystem alive across two independent service scopes.
      yield* Effect.gen(function* () {
        const settingsLayer = () =>
          Layer.fresh(ServerSettingsModule.layer).pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
          );
        let saved = yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          return yield* service.saveCustomModel({
            revision: 0,
            connection: {
              ...modelConnection,
              ...(scenario === "legacy" ? { baseUrl: "http://127.0.0.1:12345/v1" } : {}),
              models: [model],
            },
            apiKey: Redacted.make("restart-fixture-key"),
          });
        }).pipe(Effect.provide(settingsLayer()), Effect.scoped);
        const lookupCount = fetch.mock.calls.length;
        assert.equal(lookupCount, scenario === "automatic" ? 1 : 0);
        if (scenario === "legacy") {
          // Emulate a pre-metadata settings file, not today's save-time enrichment.
          saved = {
            ...saved,
            connections: saved.connections.map((connection) => ({
              ...connection,
              models: connection.models.map(
                ({ configurationMode: _mode, reasoningMetadata: _metadata, ...legacy }) => legacy,
              ),
            })),
          };
          const fs = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const settings = yield* decodeSettingsJson(yield* fs.readFileString(config.settingsPath));
          yield* fs.writeFileString(
            config.settingsPath,
            yield* encodeSettingsJson({
              ...settings,
              customModels: saved,
            }),
          );
        }
        const savedModel = saved.connections[0]!.models[0]!;
        if (scenario === "automatic") {
          assert.equal(savedModel.reasoningMetadata?.contextWindow, 200000);
          assert.deepEqual(savedModel.reasoningMetadata?.levels, ["high"]);
          assert.equal(savedModel.reasoningMetadata?.images, true);
        } else if (scenario === "overrides") {
          assert.equal(savedModel.imageInput, "enabled");
          assert.deepEqual(savedModel.reasoningOverride, model.reasoningOverride);
          assert.equal(savedModel.defaultReasoningLevel, "high");
        } else {
          assert.equal(savedModel.reasoningMetadata, undefined);
          assert.equal(savedModel.configurationMode, undefined);
          assert.equal(savedModel.imageInput, undefined);
        }
        fetch.mockImplementation(async () => {
          throw new Error("Restart must not fetch metadata");
        });
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          assert.deepEqual((yield* service.getSettings).customModels, saved);
          const resolved = yield* service.resolveCustomModels(ProviderInstanceId.make("pi"));
          assert.equal(resolved.length, 1);
          assert.deepEqual(resolved[0]!.models, saved.connections[0]!.models);
          assert.equal(fetch.mock.calls.length, lookupCount);
        }).pipe(Effect.provide(settingsLayer()), Effect.scoped);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-settings-restart-test-" }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "explicit model recheck bypasses cached evidence without rotating keys or manual intent",
    () =>
      Effect.gen(function* () {
        const fetch = yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(globalThis, "fetch").mockImplementation(async () => modelResponse()),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const saved = yield* service.saveCustomModel({
            revision: 0,
            connection: {
              ...modelConnection,
              models: [
                {
                  ...modelConnection.models[0]!,
                  configurationMode: "manual",
                  contextWindow: 100000,
                  maxOutputTokens: 8192,
                  defaultReasoningLevel: "high",
                },
              ],
            },
            apiKey: Redacted.make("fixture-recheck-key"),
          });
          const original = saved.connections[0]!;
          const rechecked = yield* service.saveCustomModel({
            revision: saved.revision,
            connection: original,
            refreshModelId: "model",
          });
          assert.equal(fetch.mock.calls.length, 2);
          assert.equal(rechecked.connections[0]!.credentialId, original.credentialId);
          assert.equal(rechecked.connections[0]!.id, original.id);
          const { reasoningMetadata: refreshedEvidence, ...refreshedModel } =
            rechecked.connections[0]!.models[0]!;
          const { reasoningMetadata: originalEvidence, ...originalModel } = original.models[0]!;
          assert.deepEqual(refreshedModel, originalModel);
          assert.equal(refreshedEvidence?.contextWindow, originalEvidence?.contextWindow);
          assert.equal(
            Redacted.value(
              (yield* service.resolveCustomModels(ProviderInstanceId.make("pi")))[0]!.apiKey!,
            ),
            "fixture-recheck-key",
          );
          fetch.mockImplementation(async () => {
            throw new Error("Synthetic unavailable endpoint");
          });
          const retained = yield* service.saveCustomModel({
            revision: rechecked.revision,
            connection: rechecked.connections[0]!,
            refreshModelId: "model",
          });
          assert.equal(retained.connections[0]!.models[0]!.contextWindow, 100000);
          assert.equal(
            retained.connections[0]!.models[0]!.reasoningMetadata?.contextWindow,
            200000,
          );
          assert.equal(retained.connections[0]!.models[0]!.reasoningMetadata?.stale, true);
          assert.equal(retained.connections[0]!.credentialId, original.credentialId);
        }).pipe(Effect.provide(makeServerSettingsLayer()));
      }).pipe(Effect.scoped),
  );

  it.effect.each(
    (["rotate", "remove"] as const).map((action) => ({
      caseTitle: `keeps an in-progress credential read coherent during ${action}`,
      action,
    })),
  )("$caseTitle", ({ action }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writeStarted = yield* Deferred.make<void>();
      let blockNextRead = false;
      const secretLayer = Layer.effect(
        ServerSecretStore.ServerSecretStore,
        Effect.gen(function* () {
          const store = yield* ServerSecretStore.ServerSecretStore;
          return {
            ...store,
            get: (name: string) =>
              Effect.gen(function* () {
                if (blockNextRead && name.startsWith("custom-model-")) {
                  blockNextRead = false;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                return yield* store.get(name);
              }),
          };
        }),
      ).pipe(Layer.provide(ServerSecretStore.layer));
      yield* Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const connection = { ...modelConnection, baseUrl: "https://example.test/v1" };
        const saved = yield* service.saveCustomModel({
          revision: 0,
          connection,
          apiKey: Redacted.make("first-synthetic-key"),
        });
        blockNextRead = true;
        const reading = yield* service
          .resolveCustomModels(ProviderInstanceId.make("pi"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const writing = yield* Deferred.succeed(writeStarted, undefined).pipe(
          Effect.andThen(
            action === "rotate"
              ? service.saveCustomModel({
                  revision: saved.revision,
                  connection,
                  apiKey: Redacted.make("second-synthetic-key"),
                })
              : service.removeCustomModel({
                  revision: saved.revision,
                  connectionId: connection.id,
                }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(writeStarted);
        yield* Deferred.succeed(release, undefined);
        const original = (yield* Fiber.join(reading))[0]!;
        assert.equal(original.credentialError, undefined);
        assert.equal(Redacted.value(original.apiKey!), "first-synthetic-key");
        yield* Fiber.join(writing);
        const next = yield* service.resolveCustomModels(ProviderInstanceId.make("pi"));
        if (action === "remove") assert.isEmpty(next);
        else assert.equal(Redacted.value(next[0]!.apiKey!), "second-synthetic-key");
      }).pipe(Effect.provide(makeServerSettingsLayer(secretLayer)));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not hold the write lock during lookup and rejects a stale result without storing its key",
    () =>
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>();
        const response = Promise.withResolvers<Response>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(globalThis, "fetch").mockImplementation(() => {
              requested.resolve();
              return response.promise;
            }),
          ),
          (spy) =>
            Effect.sync(() => {
              response.resolve(modelResponse());
              spy.mockRestore();
            }),
        );
        yield* Effect.gen(function* () {
          const service = yield* ServerSettingsModule.ServerSettingsService;
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const saving = yield* service
            .saveCustomModel({
              revision: 0,
              connection: modelConnection,
              apiKey: Redacted.make("never-stored"),
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => requested.promise);
          assert.equal((yield* service.getSettings).customModels.revision, 0);
          yield* service.saveCustomModel({
            revision: 0,
            connection: { ...modelConnection, id: "other", models: [] },
          });
          response.resolve(modelResponse());
          const result = yield* Fiber.join(saving);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.include(result.failure.message, "changed");
          const saved = (yield* service.getSettings).customModels;
          assert.deepEqual(
            saved.connections.map((connection) => connection.id),
            ["other"],
          );
          const names = yield* fs
            .readDirectory(config.secretsDir)
            .pipe(Effect.catch(() => Effect.succeed([])));
          assert.isEmpty(names.filter((name) => name.startsWith("custom-model-")));
        }).pipe(Effect.provide(makeServerSettingsLayer()));
      }).pipe(Effect.scoped),
  );
  it.effect("serializes concurrent custom-model edits and persists credentials separately", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const connection = {
        id: "fixture",
        name: "Test",
        protocol: "openai-completions" as const,
        baseUrl: "https://example.test/v1",
        models: [],
      };
      const outcomes = yield* Effect.all(
        [
          service
            .saveCustomModel({ revision: 0, connection, apiKey: Redacted.make("first-secret") })
            .pipe(Effect.exit),
          service
            .saveCustomModel({ revision: 0, connection, apiKey: Redacted.make("second-secret") })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter((outcome) => outcome._tag === "Success").length, 1);
      const saved = (yield* service.getSettings).customModels;
      assert.equal(saved.revision, 1);
      const raw = yield* fs.readFileString(config.settingsPath);
      assert.notInclude(raw, "first-secret");
      assert.notInclude(raw, "second-secret");
      const keyFile =
        config.secretsDir +
        "/" +
        customModelSecretName(saved.connections[0]!.credentialId!) +
        ".bin";
      const stat = yield* fs.stat(keyFile);
      if ((yield* HostProcess.Platform) !== "win32") assert.equal(stat.mode & 0o777, 0o600);
      yield* service.updateSettings({ enableProviderUpdateChecks: false });
      assert.deepEqual((yield* service.getSettings).customModels, saved);
      yield* service.removeCustomModel({ revision: 1, connectionId: "fixture" });
      assert.equal(yield* fs.exists(keyFile), false);
      assert.deepEqual((yield* service.getSettings).customModels, { revision: 2, connections: [] });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("migrates saved token delivery to paragraph buffering without resetting settings", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        `{
          "responseStreamingMode": "token",
          "enableAgentBrowserAccess": false,
          "projectSettingsOverrides": {
            "legacy": { "responseStreamingMode": "token", "defaultAutoPull": true },
            "buffered": { "responseStreamingMode": "turn" },
            "inherited": { "defaultAutoPull": false }
          }
        }`,
      );

      const settings = yield* service.getSettings;
      assert.equal(settings.responseStreamingMode, "paragraph");
      assert.isFalse(settings.enableAgentBrowserAccess);
      assert.deepEqual(settings.projectSettingsOverrides, {
        [ProjectId.make("legacy")]: { responseStreamingMode: "paragraph", defaultAutoPull: true },
        [ProjectId.make("buffered")]: { responseStreamingMode: "turn" },
        [ProjectId.make("inherited")]: { defaultAutoPull: false },
      });

      yield* service.updateSettings({ responseStreamingMode: "turn" });
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(config.settingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "turn");
      assert.deepEqual(persisted.projectSettingsOverrides, settings.projectSettingsOverrides);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("saves through a symlinked settings file without replacing the link", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
      const linkedSettingsPath = path.join(dotfiles, "settings.json");
      yield* fs.writeFileString(linkedSettingsPath, `{ "responseStreamingMode": "turn" }`);
      yield* fs.remove(config.settingsPath, { force: true });
      yield* fs.symlink(linkedSettingsPath, config.settingsPath);

      yield* service.updateSettings({ responseStreamingMode: "paragraph" });

      assert.equal(yield* fs.readLink(config.settingsPath), linkedSettingsPath);
      const persisted = yield* decodeServerSettingsJson(
        yield* fs.readFileString(linkedSettingsPath),
      );
      assert.equal(persisted.responseStreamingMode, "paragraph");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("reloads when the destination of a symlinked settings file changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const linkedSettingsPath = path.join(dotfiles, "settings.json");
        yield* fs.writeFileString(linkedSettingsPath, `{ "responseStreamingMode": "turn" }`);
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(linkedSettingsPath, config.settingsPath);
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* writeFileStringAtomically({
          filePath: linkedSettingsPath,
          contents: `{ "responseStreamingMode": "paragraph" }`,
        });

        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("follows a settings link that is repointed to another directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const firstSettingsPath = path.join(dotfiles, "first", "settings.json");
        const secondSettingsPath = path.join(dotfiles, "second", "settings.json");
        yield* fs.makeDirectory(path.dirname(firstSettingsPath), { recursive: true });
        yield* fs.makeDirectory(path.dirname(secondSettingsPath), { recursive: true });
        yield* fs.writeFileString(firstSettingsPath, `{ "responseStreamingMode": "turn" }`);
        yield* fs.writeFileString(secondSettingsPath, `{ "responseStreamingMode": "paragraph" }`);
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(firstSettingsPath, config.settingsPath);
        yield* service.start;

        const repointChanges = yield* service.subscribeChanges;
        yield* fs.remove(config.settingsPath);
        yield* fs.symlink(secondSettingsPath, config.settingsPath);
        const repointed = yield* repointChanges.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(repointed)?.responseStreamingMode, "paragraph");

        const editChanges = yield* service.subscribeChanges;
        yield* writeFileStringAtomically({
          filePath: secondSettingsPath,
          contents: `{ "responseStreamingMode": "turn" }`,
        });
        const edited = yield* editChanges.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(edited)?.responseStreamingMode, "turn");
      }),
    ).pipe(TestClock.withLive, Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("reloads when a dangling settings link gets its destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-dotfiles-" });
        const linkedSettingsPath = path.join(dotfiles, "not-yet", "settings.json");
        yield* fs.remove(config.settingsPath, { force: true });
        yield* fs.symlink(linkedSettingsPath, config.settingsPath);
        yield* service.start;
        const changes = yield* service.subscribeChanges;

        yield* writeFileStringAtomically({
          filePath: linkedSettingsPath,
          contents: `{ "responseStreamingMode": "paragraph" }`,
        });

        const change = yield* changes.pipe(Stream.runHead, Effect.timeout("2 seconds"));
        assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
      }),
    ).pipe(TestClock.withLive, Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "registers a dangling destination before ready and re-reads writes during acquisition",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* SettingsDirectoryWatch;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const closed = vi.fn();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-ready-" });
              const destination = path.join(dotfiles, "held", "settings.json");
              yield* fs.remove(config.settingsPath, { force: true });
              yield* fs.symlink(destination, config.settingsPath);
              const watch = {
                acquire: Effect.fnUntraced(function* (directory: string) {
                  if (directory === path.dirname(destination)) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  const events = yield* native.acquire(directory);
                  yield* Effect.addFinalizer(() => Effect.sync(() => closed(directory)));
                  return events;
                }),
              };
              yield* Effect.gen(function* () {
                const service = yield* ServerSettingsModule.ServerSettingsService;
                const startup = yield* service.start.pipe(Effect.forkChild);
                yield* Deferred.await(entered);
                // No native target watch exists yet; no creation event can be buffered.
                yield* writeFileStringAtomically({
                  filePath: destination,
                  contents: `{ "responseStreamingMode": "paragraph" }`,
                });
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(startup);
                yield* service.ready;
                assert.equal((yield* service.getSettings).responseStreamingMode, "paragraph");
                const changes = yield* service.subscribeChanges;
                yield* writeFileStringAtomically({
                  filePath: destination,
                  contents: `{ "responseStreamingMode": "turn" }`,
                });
                const change = yield* changes.pipe(
                  Stream.filter((settings) => settings.responseStreamingMode === "turn"),
                  Stream.runHead,
                  Effect.timeout("2 seconds"),
                );
                assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "turn");
              }).pipe(
                Effect.provide(
                  makeServerSettingsLayer(
                    ServerSecretStore.layer,
                    Layer.succeed(ServerConfig.ServerConfig, config),
                  ),
                ),
                Effect.provideService(SettingsDirectoryWatch, watch),
              );
            }),
          );
          assert.equal(closed.mock.calls.length, 3);
        }),
      ).pipe(
        TestClock.withLive,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-server-settings-ready-test-" }),
        ),
      ),
  );

  it.effect(
    "resolves the initial link after delayed parent registration and watches its current destination",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* SettingsDirectoryWatch;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const closed = vi.fn();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const dotfiles = yield* fs.makeTempDirectoryScoped({
                prefix: "t3-settings-parent-ready-",
              });
              const first = path.join(dotfiles, "first", "settings.json");
              const second = path.join(dotfiles, "second", "settings.json");
              yield* writeFileStringAtomically({
                filePath: first,
                contents: `{ "responseStreamingMode": "turn" }`,
              });
              yield* writeFileStringAtomically({
                filePath: second,
                contents: `{ "responseStreamingMode": "turn" }`,
              });
              yield* fs.remove(config.settingsPath, { force: true });
              yield* fs.symlink(first, config.settingsPath);
              let held = false;
              const watch = {
                acquire: Effect.fnUntraced(function* (directory: string) {
                  if (directory === path.dirname(config.settingsPath) && !held) {
                    held = true;
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  const events = yield* native.acquire(directory);
                  yield* Effect.addFinalizer(() => Effect.sync(() => closed(directory)));
                  return events;
                }),
              };
              yield* Effect.gen(function* () {
                const service = yield* ServerSettingsModule.ServerSettingsService;
                const startup = yield* service.start.pipe(Effect.forkChild);
                yield* Deferred.await(entered);
                yield* fs.remove(config.settingsPath);
                yield* fs.symlink(second, config.settingsPath);
                yield* writeFileStringAtomically({
                  filePath: second,
                  contents: `{ "responseStreamingMode": "paragraph" }`,
                });
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(startup);
                assert.equal((yield* service.getSettings).responseStreamingMode, "paragraph");
                const changes = yield* service.subscribeChanges;
                yield* writeFileStringAtomically({
                  filePath: second,
                  contents: `{ "responseStreamingMode": "turn" }`,
                });
                const change = yield* changes.pipe(
                  Stream.filter((settings) => settings.responseStreamingMode === "turn"),
                  Stream.runHead,
                  Effect.timeout("2 seconds"),
                );
                assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "turn");
                assert.equal(
                  closed.mock.calls.filter(([directory]) => directory === path.dirname(first))
                    .length,
                  0,
                );
              }).pipe(
                Effect.provide(
                  makeServerSettingsLayer(
                    ServerSecretStore.layer,
                    Layer.succeed(ServerConfig.ServerConfig, config),
                  ),
                ),
                Effect.provideService(SettingsDirectoryWatch, watch),
              );
            }),
          );
          assert.equal(closed.mock.calls.length, 3);
        }),
      ).pipe(
        TestClock.withLive,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-server-settings-ready-test-" }),
        ),
      ),
  );

  it.effect("re-reads a repointed settings destination after delayed native registration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* SettingsDirectoryWatch;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const closed = vi.fn();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dotfiles = yield* fs.makeTempDirectoryScoped({
              prefix: "t3-settings-repoint-ready-",
            });
            const first = path.join(dotfiles, "first", "settings.json");
            const second = path.join(dotfiles, "second", "settings.json");
            yield* writeFileStringAtomically({
              filePath: first,
              contents: `{ "responseStreamingMode": "turn" }`,
            });
            yield* writeFileStringAtomically({
              filePath: second,
              contents: `{ "responseStreamingMode": "turn" }`,
            });
            yield* fs.remove(config.settingsPath, { force: true });
            yield* fs.symlink(first, config.settingsPath);
            const watch = {
              acquire: Effect.fnUntraced(function* (directory: string) {
                if (directory === path.dirname(second)) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                const events = yield* native.acquire(directory);
                yield* Effect.addFinalizer(() => Effect.sync(() => closed(directory)));
                return events;
              }),
            };
            yield* Effect.gen(function* () {
              const service = yield* ServerSettingsModule.ServerSettingsService;
              yield* service.start;
              const changes = yield* service.subscribeChanges;
              yield* fs.remove(config.settingsPath);
              yield* fs.symlink(second, config.settingsPath);
              yield* Deferred.await(entered);
              yield* writeFileStringAtomically({
                filePath: second,
                contents: `{ "responseStreamingMode": "paragraph" }`,
              });
              yield* Deferred.succeed(release, undefined);
              const change = yield* changes.pipe(
                Stream.filter((settings) => settings.responseStreamingMode === "paragraph"),
                Stream.runHead,
                Effect.timeout("2 seconds"),
              );
              assert.equal(Option.getOrUndefined(change)?.responseStreamingMode, "paragraph");
              assert.equal(
                closed.mock.calls.filter(([directory]) => directory === path.dirname(first)).length,
                1,
              );
            }).pipe(
              Effect.provide(
                makeServerSettingsLayer(
                  ServerSecretStore.layer,
                  Layer.succeed(ServerConfig.ServerConfig, config),
                ),
              ),
              Effect.provideService(SettingsDirectoryWatch, watch),
            );
          }),
        );
        assert.equal(closed.mock.calls.length, 4);
      }),
    ).pipe(
      TestClock.withLive,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-server-settings-ready-test-" }),
      ),
    ),
  );

  it.effect.each(["atomic replacement", "dangling creation", "same-target link repoint"] as const)(
    "detects %s with no native events and stops metadata sampling on disposal",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const metadata = yield* SettingsFileMetadata;
          const clock = yield* Clock.Clock;
          const sampleSleeps = yield* Queue.make<Deferred.Deferred<void>>();
          const debounceSleeps = yield* Queue.make<Deferred.Deferred<void>>();
          let cancelledSamples = 0;
          const controlledClock: Clock.Clock = {
            ...clock,
            sleep: (duration) => {
              const millis = Duration.toMillis(duration);
              if (millis !== 250 && millis !== 100) return clock.sleep(duration);
              return Effect.gen(function* () {
                const release = yield* Deferred.make<void>();
                yield* Queue.offer(millis === 250 ? sampleSleeps : debounceSleeps, release);
                yield* Deferred.await(release);
                yield* TestClock.adjust(duration);
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    if (millis === 250) cancelledSamples += 1;
                  }),
                ),
              );
            },
          };
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baselineCaptured = yield* Deferred.make<void>();
          const releaseBaseline = yield* Deferred.make<void>();
          const reads = yield* Queue.make<string>();
          const observed = yield* Queue.make<string>();
          yield* Effect.addFinalizer(() => Queue.shutdown(reads));
          yield* Effect.addFinalizer(() => Queue.shutdown(observed));
          let metadataReads = 0;
          const dotfiles = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-metadata-" });
          const destination =
            scenario === "atomic replacement"
              ? config.settingsPath
              : path.join(dotfiles, "settings.json");
          if (scenario !== "dangling creation") {
            yield* writeFileStringAtomically({
              filePath: destination,
              contents: `{ "responseStreamingMode": "turn", "projectSettingsFolded": true }`,
            });
          }
          if (scenario !== "atomic replacement") {
            yield* fs.remove(config.settingsPath, { force: true });
            yield* fs.symlink(destination, config.settingsPath);
          }
          const metadataReader = {
            readFingerprint: Effect.fnUntraced(function* (filePath: string) {
              const fingerprint = yield* metadata.readFingerprint(filePath);
              metadataReads += 1;
              if (metadataReads === 1) {
                yield* Deferred.succeed(baselineCaptured, undefined);
                yield* Deferred.await(releaseBaseline);
              }
              yield* Queue.offer(reads, fingerprint);
              return fingerprint;
            }),
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              const service = yield* ServerSettingsModule.ServerSettingsService;
              const startup = yield* service.start.pipe(Effect.forkChild);
              yield* Deferred.await(baselineCaptured);
              if (scenario === "atomic replacement") {
                // This update is after the captured baseline but before startup revalidation.
                yield* writeFileStringAtomically({
                  filePath: destination,
                  contents: `{ "responseStreamingMode": "paragraph", "projectSettingsFolded": true }`,
                });
              }
              yield* Deferred.succeed(releaseBaseline, undefined);
              yield* Fiber.join(startup);
              yield* Queue.take(reads);
              assert.equal(metadataReads, 1);
              const expectedInitial =
                scenario === "same-target link repoint" ? "turn" : "paragraph";
              assert.equal((yield* service.getSettings).responseStreamingMode, expectedInitial);
              const changes = yield* service.subscribeChanges;
              yield* changes.pipe(
                Stream.runForEach((settings) =>
                  Queue.offer(observed, settings.responseStreamingMode),
                ),
                Effect.forkChild,
              );
              if (scenario === "same-target link repoint") {
                const targetBefore = yield* fs.stat(destination);
                yield* fs.remove(config.settingsPath);
                yield* fs.symlink(
                  path.relative(path.dirname(config.settingsPath), destination),
                  config.settingsPath,
                );
                assert.deepEqual(yield* fs.stat(destination), targetBefore);
              } else {
                yield* writeFileStringAtomically({
                  filePath: destination,
                  contents: `{ "responseStreamingMode": "turn", "projectSettingsFolded": true }`,
                });
              }
              yield* Deferred.succeed(yield* Queue.take(sampleSleeps), undefined);
              yield* Queue.take(reads);
              // Release the actual debounce sleep only after the changed hint has reached it.
              yield* Deferred.succeed(yield* Queue.take(debounceSleeps), undefined);
              assert.equal(yield* Queue.take(observed), "turn");
              yield* Deferred.succeed(yield* Queue.take(sampleSleeps), undefined);
              yield* Queue.take(reads);
              // The next sampler sleep is a processing receipt for the unchanged fingerprint.
              yield* Queue.take(sampleSleeps);
              assert.isTrue(Option.isNone(yield* Queue.poll(debounceSleeps)));
              assert.isTrue(Option.isNone(yield* Queue.poll(observed)));
            }).pipe(
              Effect.provide(
                makeServerSettingsLayer(
                  ServerSecretStore.layer,
                  Layer.succeed(ServerConfig.ServerConfig, config),
                ),
              ),
              Effect.provideService(SettingsDirectoryWatch, {
                acquire: () =>
                  Effect.succeed<Stream.Stream<string, PlatformError.PlatformError>>(Stream.empty),
              }),
              Effect.provideService(SettingsFileMetadata, metadataReader),
              Effect.provideService(Clock.Clock, controlledClock),
            ),
          );
          const readsAfterDisposal = metadataReads;
          assert.equal(cancelledSamples, 1);
          assert.equal(metadataReads, readsAfterDisposal);
          assert.equal(metadataReads, 3);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-server-settings-metadata-test-",
          }),
        ),
      ),
  );

  it.effect(
    "retains the last metadata baseline across denial and logs only denial transitions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* Clock.Clock;
          const sleeps = yield* Queue.make<Deferred.Deferred<void>>();
          const events = yield* Queue.make<string>();
          let fingerprint = "initial";
          let denied = false;
          let readCount = 0;
          let cancelledSamples = 0;
          const messages: unknown[] = [];
          const logger = Logger.make(({ message }) => messages.push(message));
          const controlledClock: Clock.Clock = {
            ...clock,
            sleep: (duration) => {
              assert.equal(Duration.toMillis(duration), 250);
              return Effect.gen(function* () {
                const release = yield* Deferred.make<void>();
                yield* Queue.offer(sleeps, release);
                yield* Deferred.await(release);
                yield* TestClock.adjust(duration);
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => (cancelledSamples += 1))));
            },
          };
          const read = () =>
            Effect.suspend(() => {
              readCount += 1;
              return denied
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "stat",
                      description: "controlled metadata denial",
                    }),
                  )
                : Effect.succeed(fingerprint);
            });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const changes = yield* acquireSettingsMetadataChanges("settings.json", read);
              assert.equal(readCount, 1);
              yield* changes.pipe(
                Stream.runForEach((event) => Queue.offer(events, event)),
                Effect.forkScoped,
              );
              let nextSample = yield* Queue.take(sleeps);
              const sample = Effect.fnUntraced(function* () {
                yield* Deferred.succeed(nextSample, undefined);
                // A new sleep proves the preceding sample has passed through the stream mapper.
                nextSample = yield* Queue.take(sleeps);
              });
              denied = true;
              yield* sample();
              assert.equal(messages.length, 1);
              yield* sample();
              assert.equal(messages.length, 1);
              denied = false;
              yield* sample();
              assert.isTrue(Option.isNone(yield* Queue.poll(events)));
              assert.equal(messages.length, 1);
              denied = true;
              yield* sample();
              assert.equal(messages.length, 2);
              denied = false;
              fingerprint = "changed";
              yield* sample();
              assert.equal(yield* Queue.take(events), "settings.json");
              assert.isTrue(Option.isNone(yield* Queue.poll(events)));
              assert.equal(readCount, 6);
            }).pipe(
              Effect.provideService(Clock.Clock, controlledClock),
              Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            ),
          );
          assert.equal(cancelledSamples, 1);
          assert.equal(readCount, 6);
        }),
      ),
  );

  it.effect("keeps metadata read failures nonfatal without withholding startup readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* service.start.pipe(Effect.timeout("2 seconds"));
        yield* service.ready;
        assert.equal(
          (yield* service.updateSettings({ responseStreamingMode: "turn" })).responseStreamingMode,
          "turn",
        );
      }),
    ).pipe(
      TestClock.withLive,
      Effect.provide(makeServerSettingsLayer()),
      Effect.provideService(SettingsFileMetadata, {
        readFingerprint: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "stat",
              description: "controlled metadata denial",
            }),
          ),
      }),
    ),
  );

  it.effect("keeps failed watch registration nonfatal and settles ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* service.start.pipe(Effect.timeout("2 seconds"));
        yield* service.ready;
        assert.equal(
          (yield* service.getSettings).responseStreamingMode,
          DEFAULT_SERVER_SETTINGS.responseStreamingMode,
        );
      }),
    ).pipe(
      TestClock.withLive,
      Effect.provide(makeServerSettingsLayer()),
      Effect.provideService(SettingsDirectoryWatch, {
        acquire: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "watch",
              description: "controlled watch denial",
            }),
          ),
      }),
    ),
  );

  it.effect.each([
    { failureDuringAcquisition: true, phase: "during destination acquisition" },
    { failureDuringAcquisition: false, phase: "after ready" },
  ])(
    "closes parent handles and keeps settings available when a watch stream fails $phase",
    ({ failureDuringAcquisition }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* SettingsDirectoryWatch;
          const entered = yield* Deferred.make<void>();
          const neverRegister = yield* Deferred.make<void>();
          const allClosed = yield* Deferred.make<void>();
          const streamErrors = yield* Queue.make<string, PlatformError.PlatformError>();
          yield* Effect.addFinalizer(() => Queue.shutdown(streamErrors));
          const closed = vi.fn();
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dotfiles = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-settings-stream-failure-",
          });
          const destination = path.join(dotfiles, "target", "settings.json");
          yield* writeFileStringAtomically({
            filePath: destination,
            contents: `{ "responseStreamingMode": "turn" }`,
          });
          yield* fs.remove(config.settingsPath, { force: true });
          yield* fs.symlink(destination, config.settingsPath);
          let parentCount = 0;
          const watch = {
            acquire: Effect.fnUntraced(function* (directory: string) {
              if (directory === path.dirname(destination) && failureDuringAcquisition) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(neverRegister);
              }
              const events = yield* native.acquire(directory);
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  closed(directory);
                  if (closed.mock.calls.length === (failureDuringAcquisition ? 2 : 3)) {
                    yield* Deferred.succeed(allClosed, undefined);
                  }
                }),
              );
              if (directory === path.dirname(config.settingsPath) && ++parentCount === 1) {
                return Stream.merge(events, Stream.fromQueue(streamErrors));
              }
              return events;
            }),
          };
          yield* Effect.gen(function* () {
            const service = yield* ServerSettingsModule.ServerSettingsService;
            const startup = yield* service.start.pipe(Effect.forkChild);
            if (failureDuringAcquisition) yield* Deferred.await(entered);
            else yield* Fiber.join(startup);
            yield* Queue.fail(
              streamErrors,
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "watch",
                description: "controlled parent stream failure",
              }),
            );
            yield* Fiber.join(startup).pipe(Effect.timeout("2 seconds"));
            yield* service.ready.pipe(Effect.timeout("2 seconds"));
            yield* Deferred.await(allClosed).pipe(Effect.timeout("2 seconds"));
            assert.equal(
              closed.mock.calls.filter(
                ([directory]) => directory === path.dirname(config.settingsPath),
              ).length,
              2,
            );
            assert.equal(
              closed.mock.calls.filter(([directory]) => directory === path.dirname(destination))
                .length,
              failureDuringAcquisition ? 0 : 1,
            );
            assert.equal((yield* service.getSettings).responseStreamingMode, "turn");
            assert.equal(
              (yield* service.updateSettings({ responseStreamingMode: "paragraph" }))
                .responseStreamingMode,
              "paragraph",
            );
          }).pipe(
            Effect.provide(
              makeServerSettingsLayer(
                ServerSecretStore.layer,
                Layer.succeed(ServerConfig.ServerConfig, config),
              ),
            ),
            Effect.provideService(SettingsDirectoryWatch, watch),
          );
          assert.equal(closed.mock.calls.length, failureDuringAcquisition ? 2 : 3);
        }),
      ).pipe(
        TestClock.withLive,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-server-settings-ready-test-" }),
        ),
      ),
  );

  it.effect(
    "closes acquired link watches when startup is interrupted during destination registration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* SettingsDirectoryWatch;
          const entered = yield* Deferred.make<void>();
          const neverRegister = yield* Deferred.make<void>();
          const parentsReady = yield* Deferred.make<void>();
          const acquired = vi.fn();
          const closed = vi.fn();
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dotfiles = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-settings-interrupt-ready-",
          });
          const destination = path.join(dotfiles, "held", "settings.json");
          yield* fs.remove(config.settingsPath, { force: true });
          yield* fs.symlink(destination, config.settingsPath);
          const watch = {
            acquire: Effect.fnUntraced(function* (directory: string) {
              if (directory === path.dirname(destination)) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(neverRegister);
              }
              const events = yield* native.acquire(directory);
              yield* Effect.sync(() => acquired(directory));
              if (acquired.mock.calls.length === 2)
                yield* Deferred.succeed(parentsReady, undefined);
              yield* Effect.addFinalizer(() => Effect.sync(() => closed(directory)));
              return events;
            }),
          };
          yield* Effect.gen(function* () {
            const service = yield* ServerSettingsModule.ServerSettingsService;
            const startup = yield* service.start.pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* Deferred.await(parentsReady);
            yield* Fiber.interrupt(startup);
            assert.isTrue(Exit.isFailure(yield* Fiber.await(startup)));
            const readyExit = yield* service.ready.pipe(Effect.exit, Effect.timeout("2 seconds"));
            assert.isTrue(Exit.isFailure(readyExit));
            assert.equal(closed.mock.calls.length, acquired.mock.calls.length);
            assert.equal(
              acquired.mock.calls.filter(([directory]) => directory === path.dirname(destination))
                .length,
              0,
            );
          }).pipe(
            Effect.provide(
              makeServerSettingsLayer(
                ServerSecretStore.layer,
                Layer.succeed(ServerConfig.ServerConfig, config),
              ),
            ),
            Effect.provideService(SettingsDirectoryWatch, watch),
          );
        }),
      ).pipe(
        TestClock.withLive,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3code-server-settings-ready-test-" }),
        ),
      ),
  );

  it.effect("preserves context when reading a provider environment secret fails", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });
    const layerConfig = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-secret-failure-test-",
      }),
    );
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerFailingSecretStore(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(layerConfig),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-secret",
        providerInstanceId: "codex_personal",
        environmentVariable: "OPENROUTER_API_KEY",
      });
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect("identifies provider history query failures", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_thread_sessions`;

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-provider-history",
        settingsPath: serverConfig.settingsPath,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("retries a failed settings read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // A directory where the file should be makes the read itself fail.
      yield* fileSystem.makeDirectory(serverConfig.settingsPath);

      const error = yield* Effect.flip(serverSettings.getSettings);
      assert.deepInclude(error, { _tag: "ServerSettingsError", operation: "read-file" });

      yield* fileSystem.remove(serverConfig.settingsPath, { recursive: true });
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{ "responseStreamingMode": "turn" }`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.equal(settings.responseStreamingMode, "turn");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("saves and resets Droid's Factory sync setting through the settings patch", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const droidId = ProviderInstanceId.make("droid");
      const persistedSync = fs.readFileString(serverConfig.settingsPath).pipe(
        Effect.map((raw) => {
          const persisted = JSON.parse(raw) as {
            providerInstances?: Record<
              string,
              { readonly config?: Pick<DroidSettings, "cloudSessionSync"> }
            >;
          };
          return persisted.providerInstances?.[droidId]?.config?.cloudSessionSync;
        }),
      );
      // As the settings RPC receives it: decoded through the patch contract.
      const off = yield* decodeSettingsPatch({
        providerInstances: {
          [droidId]: {
            driver: ProviderDriverKind.make("droid"),
            config: { cloudSessionSync: false },
          },
        },
      });
      const disabled = yield* serverSettings.updateSettings(off);
      assert.equal(
        (disabled.providerInstances[droidId]?.config as Pick<DroidSettings, "cloudSessionSync">)
          .cloudSessionSync,
        false,
      );
      assert.equal(yield* persistedSync, false);
      // Reset sends the driver's defaults inside the default instance.
      const { enabled, ...defaultConfig } = yield* Schema.decodeEffect(DroidSettings)({});
      const reset = yield* decodeSettingsPatch({
        providerInstances: {
          [droidId]: {
            driver: ProviderDriverKind.make("droid"),
            enabled,
            config: defaultConfig,
          },
        },
      });
      assert.equal(
        (
          (yield* serverSettings.updateSettings(reset)).providerInstances[droidId]?.config as Pick<
            DroidSettings,
            "cloudSessionSync"
          >
        ).cloudSessionSync,
        true,
      );
      assert.equal(yield* persistedSync, true);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        observability: { otlpMetricsUrl: "http://localhost:4318/v1/metrics" },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.equal(next.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
      assert.equal(next.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("creates provider instances atomically without overwriting a concurrent add", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("acpRegistry_shared");
      const results = yield* Effect.all(
        ["First", "Second"].map((displayName) =>
          serverSettings
            .updateProviderInstance({
              operation: "create",
              instanceId,
              instance: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName,
                config: { agentId: "shared", distribution: "auto" },
              },
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
      assert.isTrue(
        ["First", "Second"].includes(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName ?? "",
        ),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("pauses provider-instance mutations while a settings snapshot is in use", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const snapshotEntered = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const mutationCompleted = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acpRegistry_kilo");

      const snapshotFiber = yield* serverSettings
        .withSettingsSnapshot(() =>
          Deferred.succeed(snapshotEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSnapshot)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(snapshotEntered);

      const mutationFiber = yield* serverSettings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "Kilo",
            config: { agentId: "kilo", distribution: "auto" },
          },
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(mutationCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Effect.yieldNow;

      assert.isTrue(Option.isNone(yield* Deferred.poll(mutationCompleted)));
      yield* Deferred.succeed(releaseSnapshot, undefined);
      yield* Fiber.join(snapshotFiber);
      yield* Fiber.join(mutationFiber);
      assert.equal(
        (yield* serverSettings.getSettings).providerInstances[instanceId]?.displayName,
        "Kilo",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          addProjectBaseDirectory: "~/next",
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("1 second"));
        assert.equal(Option.getOrUndefined(firstChange)?.addProjectBaseDirectory, "~/next");
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists custom usage prices and removes them from the settings file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const prices = {
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 8,
          cacheReadCostPerMillionTokens: 0,
        };
        const readPersisted = fileSystem
          .readFileString(serverConfig.settingsPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))));

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": prices } });
        const persisted = yield* readPersisted;
        assert.deepStrictEqual(persisted.usagePriceOverrides, { "example-model": prices });

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* readPersisted;
        assert.deepStrictEqual(restored.usagePriceOverrides, {});
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists and broadcasts thread settlement settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        const next = yield* serverSettings.updateSettings({
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: true,
        });
        const change = Option.getOrUndefined(yield* Stream.runHead(changes));
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        // Inspect raw persisted JSON before schema decoding can apply defaults.
        const persisted = JSON.parse(raw) as Record<string, unknown>;

        assert.strictEqual(next.sidebarAutoSettleAfterDays, null);
        assert.isTrue(next.sidebarAutoSettleOnMerge);
        assert.strictEqual(change?.sidebarAutoSettleAfterDays, null);
        assert.isTrue(change?.sidebarAutoSettleOnMerge);
        assert.strictEqual(persisted.sidebarAutoSettleAfterDays, null);
        assert.isTrue(persisted.sidebarAutoSettleOnMerge);
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("gives Droid-only users Droid's own default model for text generation", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const next = yield* serverSettings.updateSettings({
        providerInstances: providerInstancesForDrivers(fallbackProviderDrivers, ["droid"]),
      });
      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("droid"),
        model: DROID_DEFAULT_MODEL,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  describe("automatic text-generation provider with every built-in instance disabled", () => {
    const builtInsDisabled = providerInstancesForDrivers(fallbackProviderDrivers);
    const named = (driver: string, enabled = true) => providerInstance(driver, enabled);
    const selectionWith = (
      patch: Parameters<ServerSettingsModule.ServerSettingsService["Service"]["updateSettings"]>[0],
    ) =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        return (yield* serverSettings.updateSettings(patch)).textGenerationModelSelection;
      }).pipe(Effect.provide(makeServerSettingsLayer()));

    it.effect("uses a named Droid instance, with the model Droid starts with", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: {
              ...builtInsDisabled,
              [ProviderInstanceId.make("droid_work")]: named("droid"),
            },
          }),
          { instanceId: ProviderInstanceId.make("droid_work"), model: DROID_DEFAULT_MODEL },
        );
      }),
    );

    it.effect("uses the automatic native model marker for Pi-only users", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: providerInstancesForDrivers(fallbackProviderDrivers, ["pi"]),
          }),
          { instanceId: ProviderInstanceId.make("pi"), model: "pi-default" },
        );
      }),
    );

    it.effect("uses the automatic native model marker for OMP-only users", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: providerInstancesForDrivers(fallbackProviderDrivers, ["omp"]),
          }),
          { instanceId: ProviderInstanceId.make("omp"), model: "omp-default" },
        );
      }),
    );

    it.effect("uses the selected named Pi instance without assuming a hosted model", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: {
              ...builtInsDisabled,
              [ProviderInstanceId.make("pi_b")]: named("pi"),
              [ProviderInstanceId.make("pi_a")]: named("pi"),
            },
          }),
          { instanceId: ProviderInstanceId.make("pi_a"), model: "pi-default" },
        );
      }),
    );

    it.effect("uses the selected named OMP instance without assuming a hosted model", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: {
              ...builtInsDisabled,
              [ProviderInstanceId.make("omp_b")]: named("omp"),
              [ProviderInstanceId.make("omp_a")]: named("omp"),
            },
          }),
          { instanceId: ProviderInstanceId.make("omp_a"), model: "omp-default" },
        );
      }),
    );

    it.effect("uses a named instance of any other provider, with that provider's model", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: {
              ...builtInsDisabled,
              [ProviderInstanceId.make("claude_work")]: named("claudeAgent"),
            },
          }),
          { instanceId: ProviderInstanceId.make("claude_work"), model: "claude-haiku-4-5" },
        );
      }),
    );

    it.effect("picks among several named instances by provider order, then by id", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: {
              ...builtInsDisabled,
              [ProviderInstanceId.make("droid_work")]: named("droid"),
              [ProviderInstanceId.make("claude_b")]: named("claudeAgent"),
              [ProviderInstanceId.make("claude_a")]: named("claudeAgent"),
              // Disabled and unknown-driver instances are never chosen.
              [ProviderInstanceId.make("codex_off")]: named("codex", false),
              [ProviderInstanceId.make("a_fork")]: named("someForkDriver"),
            },
          }),
          { instanceId: ProviderInstanceId.make("claude_a"), model: "claude-haiku-4-5" },
        );
      }),
    );

    it.effect("leaves Scient Agent, on by default, as the last resort", () =>
      Effect.gen(function* () {
        // An explicitly enabled named provider also precedes the implicit Scient default.
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: {
              ...providerInstancesForDrivers(
                fallbackProviderDrivers.filter((driver) => driver !== "scient"),
              ),
              [ProviderInstanceId.make("droid_work")]: named("droid"),
            },
          }),
          { instanceId: ProviderInstanceId.make("droid_work"), model: DROID_DEFAULT_MODEL },
        );
        // Another enabled built-in comes first, even one that sorts after it.
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: providerInstancesForDrivers(
              fallbackProviderDrivers.filter((driver) => driver !== "scient"),
              ["antigravity"],
            ),
          }),
          { instanceId: ProviderInstanceId.make("antigravity"), model: ANTIGRAVITY_DEFAULT_MODEL },
        );
        // With every other provider off, it is what is left.
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: providerInstancesForDrivers(
              fallbackProviderDrivers.filter((driver) => driver !== "scient"),
            ),
          }),
          {
            instanceId: ProviderInstanceId.make("scient"),
            model: SCIENT_DEFAULT_TEXT_GENERATION_MODEL,
          },
        );
        // Turned off, nothing is chosen for it.
        assert.equal(
          (yield* selectionWith({ providerInstances: builtInsDisabled }))?.instanceId,
          ProviderInstanceId.make("codex"),
        );
      }),
    );

    it.effect("prefers an enabled built-in instance over named ones", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* selectionWith({
            providerInstances: {
              ...builtInsDisabled,
              [ProviderInstanceId.make("droid")]: named("droid"),
              [ProviderInstanceId.make("claude_work")]: named("claudeAgent"),
            },
          }),
          { instanceId: ProviderInstanceId.make("droid"), model: DROID_DEFAULT_MODEL },
        );
      }),
    );
  });

  it.effect("keeps the selected provider while it is enabled, whatever named instances exist", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const before = (yield* serverSettings.getSettings).textGenerationModelSelection;
      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("droid_work")]: {
            driver: ProviderDriverKind.make("droid"),
            enabled: true,
          },
        },
      });
      assert.deepEqual(next.textGenerationModelSelection, before);
      assert.equal(before.instanceId, ProviderInstanceId.make("codex"));
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "keeps a custom instance's selection when the driver's default instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  // Only driver-keyed instances are fallback candidates; a custom instance id
  // is not one, so the selection stays put until the user changes it.
  it.effect.each(["codex"])(
    "falls back to enabled instance %s after disabling the selection",
    (fallbackId) =>
      Effect.scoped(
        Effect.gen(function* () {
          const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
          const serverConfig = yield* ServerConfig.ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          const writerId = ProviderInstanceId.make("writer");
          const fallbackInstanceId = ProviderInstanceId.make(fallbackId);
          const selection = { instanceId: writerId, model: "claude-sonnet-4-6" };
          const providerInstances = {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
            },
            [fallbackInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
            [writerId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: {},
            },
          };

          yield* serverSettings.updateSettings({
            providerInstances,
            textGenerationModelSelection: selection,
          });
          const changes = yield* serverSettings.subscribeChanges;

          const next = yield* serverSettings.updateSettings({
            providerInstances: {
              ...providerInstances,
              [writerId]: { ...providerInstances[writerId]!, enabled: false },
            },
          });
          const fallbackSelection = {
            instanceId: fallbackInstanceId,
            model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          };
          assert.deepEqual(next.textGenerationModelSelection, fallbackSelection);
          assert.deepEqual(
            (yield* serverSettings.getSettings).textGenerationModelSelection,
            fallbackSelection,
          );
          const change = Option.getOrUndefined(yield* Stream.runHead(changes));
          assert.deepEqual(change?.textGenerationModelSelection, fallbackSelection);

          const persisted = yield* fileSystem
            .readFileString(serverConfig.settingsPath)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))),
            );
          assert.deepEqual(persisted.textGenerationModelSelection, selection);

          const restored = yield* serverSettings.updateSettings({ providerInstances });
          assert.deepEqual(restored.textGenerationModelSelection, selection);
        }),
      ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("skips explicitly disabled default instances when choosing a fallback", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: {},
          },
        },
      });

      assert.equal(next.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "preserves the source control writer selection when its provider instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex_writer");
        const sourceControlWriterModelSelection = {
          instanceId,
          model: "gpt-5.4-mini",
        };

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        });

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
          },
        });

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection);
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next),
          next.textGenerationModelSelection,
        );
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.deepEqual(
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
        });
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored),
          sourceControlWriterModelSelection,
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("moves customized legacy provider settings into default instances on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          addProjectBaseDirectory: "~/Development",
          providers: {
            codex: { binaryPath: "/opt/guard/bin/codex" },
            claudeAgent: { enabled: false },
            cursor: { enabled: false },
            grok: { enabled: false },
            opencode: { enabled: false },
          },
        }),
      );

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances, {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { binaryPath: "/opt/guard/bin/codex" },
        },
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          config: {},
        },
      });
      // The file is rewritten once: instances persist and the retired map is gone.
      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.isUndefined(persisted.providers);
      assert.equal(persisted.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(persisted.providerInstances.codex, {
        driver: "codex",
        config: { binaryPath: "/opt/guard/bin/codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps an explicit default instance over the legacy blob for its driver", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          providers: { codex: { binaryPath: "/legacy/codex" } },
          providerInstances: {
            codex: { driver: "codex", enabled: true, config: { binaryPath: "/explicit/codex" } },
          },
        }),
      );

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { binaryPath: "/explicit/codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("enables previously used optional providers while migrating legacy settings", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({
          providers: { opencode: { serverUrl: "http://127.0.0.1:4096" }, cursor: {} },
          providerInstances: {
            cursor_work: { driver: "cursor", config: {} },
            droid_work: { driver: "droid", config: {} },
            opencode_unused: { driver: "opencode", config: {} },
          },
        }),
      );
      yield* recordProviderUsage("opencode");
      yield* recordProviderUsage("grok", null);
      yield* recordProviderUsage("cursor", "cursor_work");
      yield* recordProviderUsage("droid", "droid_work");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("opencode")], {
        driver: ProviderDriverKind.make("opencode"),
        enabled: true,
        config: { serverUrl: "http://127.0.0.1:4096" },
      });
      // Used without any legacy blob or instance: the slot is created enabled.
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("droid_work")]?.enabled);
      // Using any cursor instance counts as opting into the driver.
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor")]?.enabled);
      // Droid history opts in its default instance too.
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("droid")]?.enabled);
      const unused = settings.providerInstances[ProviderInstanceId.make("opencode_unused")];
      assert.isDefined(unused);
      assert.isFalse(resolveProviderInstanceEnabled(unused));
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps explicit legacy disables even when provider history shows use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        JSON.stringify({ providers: { grok: { enabled: false, binaryPath: "/opt/grok" } } }),
      );
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("grok")], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores provider history when a settings file has no legacy provider map", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("grok")], {
        driver: ProviderDriverKind.make("grok"),
        enabled: true,
        config: {},
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores provider history from persisted runtime sessions", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          status,
          last_seen_at
        )
        VALUES (
          ${"thread-opencode-runtime"},
          ${"opencode"},
          ${"opencode"},
          ${"opencode"},
          ${"ready"},
          ${"2026-08-25T00:00:00.000Z"}
        )
      `;

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("opencode")]?.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores provider history when no settings file exists", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists an explicit disable after provider history enabled the instance", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");
      yield* recordProviderUsage("grok");

      assert.isTrue((yield* serverSettings.getSettings).providerInstances[grokId]?.enabled);
      const settings = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: false,
            config: {},
          },
        },
      });
      assert.isFalse(settings.providerInstances[grokId]?.enabled);

      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.isUndefined(persisted.providers);
      assert.isFalse(persisted.providerInstances.grok.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists explicit optional-provider enables before first use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providerInstances: providerInstancesForDrivers(
          ["cursor", "droid", "grok", "opencode"],
          ["cursor", "droid", "grok", "opencode"],
        ),
      });
      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Development" });

      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      for (const driver of ["cursor", "droid", "grok", "opencode"]) {
        assert.isTrue(persisted.providerInstances[driver].enabled);
      }
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect.each(
    [null, "invalid-config", 42, false, [], [{ binaryPath: "/x" }]].map((blob) => ({
      blob,
      label: JSON.stringify(blob),
    })),
  )("preserves malformed legacy provider config $label for repair", ({ blob }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const raw = JSON.stringify({
        addProjectBaseDirectory: "~/Projects",
        providers: { codex: blob, claudeAgent: { binaryPath: "/legacy/claude" } },
        providerInstances: {
          codex_work: { driver: "codex", enabled: false, config: { homePath: "~/work" } },
        },
      });
      yield* fileSystem.writeFileString(serverConfig.settingsPath, raw);

      const settings = yield* serverSettings.getSettings;
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), raw);
      assert.isUndefined(settings.providerInstances[ProviderInstanceId.make("codex")]);
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("claudeAgent")], {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { binaryPath: "/legacy/claude" },
      });
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex_work")], {
        driver: ProviderDriverKind.make("codex"),
        enabled: false,
        config: { homePath: "~/work" },
      });
      assert.equal(settings.addProjectBaseDirectory, "~/Projects");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("migrates legacy providers from an invalid file without rewriting it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const raw = '{"addProjectBaseDirectory":42,"providers":{"codex":{"binaryPath":"/x"}}}';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, raw);

      const settings = yield* serverSettings.getSettings;

      // The readable provider settings still apply, but the file stays for the user to repair.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("codex")], {
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath: "/x" },
      });
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), raw);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("skips a disabled provider instance when picking the text generation fallback", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps a default-off provider's new instance disabled and sparse on disk", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        },
      });

      const grok = next.providerInstances[ProviderInstanceId.make("grok")];
      assert.isDefined(grok);
      assert.isFalse(resolveProviderInstanceEnabled(grok));
      const persisted = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.isUndefined(persisted.providers);
      assert.isUndefined(persisted.providerInstances.grok.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("folds a legacy in-config enabled flag into the envelope on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable sticks.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"grok":{"driver":"grok","enabled":true,"config":{"enabled":false}},"codex_work":{"driver":"codex","config":{"enabled":true,"homePath":"~/.codex"}},"cursor":{"driver":"cursor","config":{"enabled":"nope"}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      const grokId = ProviderInstanceId.make("grok");
      const codexWorkId = ProviderInstanceId.make("codex_work");
      assert.deepEqual(settings.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: {},
      });
      // A lone in-config flag is lifted to the envelope and stripped.
      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });
      // A malformed flag is left alone so driver schema validation can
      // surface it instead of the fold silently repairing the config.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("folds in-config enabled flags arriving through updates", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            config: { enabled: false, binaryPath: "/opt/grok" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
          otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpLogsUrl: "http://localhost:4318/v1/logs",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        backgroundActivity: {
          schemaVersion: 1,
          profile: "custom",
          baseProfile: "balanced",
          overrides: {
            automaticGitFetchInterval: 10_000,
          },
        },
        automaticGitFetchInterval: 10_000,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps the inline value on disk when secret migration fails", () => {
    const cause = new ServerSecretStore.SecretStorePersistError({
      resource: "provider environment secret",
      cause: new Error("Secret storage unavailable"),
    });
    const layerSecret = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        set: () => Effect.fail(cause),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const layerSettings = ServerSettingsModule.layer.pipe(
      Layer.provide(layerSecret),
      Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-inline-secret-failure-test-",
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const original =
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}';
      yield* fs.writeFileString(config.settingsPath, original);
      const error = yield* Effect.flip(
        service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true }],
              config: {},
            },
          },
        }),
      );
      assert.equal(error.operation, "write-secret");
      assert.strictEqual(error.cause, cause);
      assert.equal(yield* fs.readFileString(config.settingsPath), original);
      const settings = yield* service.getSettings;
      assert.equal(
        settings.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );
    }).pipe(Effect.provide(layerSettings));
  });

  it.effect.each(
    [
      {
        label: "preserves an inline secret on a redacted settings save",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "inline-test-token",
      },
      {
        label: "preserves the effective last inline secret when names are duplicated",
        variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
        expected: "last-inline-test-token",
        duplicate: true,
      },
      {
        label: "replaces an inline secret with an explicit value",
        variable: { name: "API_TOKEN", value: "replacement-test-token", sensitive: true },
        expected: "replacement-test-token",
      },
      {
        label: "clears an inline secret with an explicit empty value",
        variable: { name: "API_TOKEN", value: "", sensitive: true },
        expected: "",
      },
    ].map((testCase) => [testCase.label, testCase] as const),
  )("%s", ([, { variable, expected, duplicate }]) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        duplicate
          ? '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true},{"name":"API_TOKEN","value":"last-inline-test-token","sensitive":true}],"config":{}}}}'
          : '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}',
      );
      const initial = yield* serverSettings.getSettings;
      assert.equal(
        initial.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Renamed provider",
            environment: duplicate ? [variable, variable] : [variable],
            config: {},
          },
        },
      });
      assert.equal(next.providerInstances[instanceId]?.environment?.[0]?.value, expected);
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "inline-test-token");
      assert.notInclude(raw, "replacement-test-token");

      const reloaded = yield* Effect.gen(function* () {
        const fresh = yield* ServerSettingsModule.ServerSettingsService;
        return yield* fresh.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
        ),
      );
      assert.equal(reloaded.providerInstances[instanceId]?.environment?.[0]?.value, expected);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect.each([true, false])(
    "preserves duplicate secret operation order (sensitive last: %s)",
    (sensitiveLast) =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_duplicate");
        const secret = { name: "API_TOKEN", value: "secret-last", sensitive: true };
        const plain = { name: "API_TOKEN", value: "plain-last", sensitive: false };
        const next = yield* service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: sensitiveLast ? [plain, secret] : [secret, plain],
              config: {},
            },
          },
        });
        assert.equal(
          next.providerInstances[instanceId]?.environment?.at(-1)?.value,
          sensitiveLast ? "secret-last" : "plain-last",
        );
        assert.equal(
          next.providerInstances[instanceId]?.environment?.find((v) => v.sensitive)?.value,
          sensitiveLast ? "secret-last" : "",
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "keeps Bitbucket tokens in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          bitbucket: { email: "me@example.com", accessToken: "bb-access", apiToken: "bb-api" },
        });
        assert.deepEqual(saved.bitbucket, {
          email: "me@example.com",
          accessToken: "bb-access",
          apiToken: "bb-api",
        });

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "bb-access");
        assert.notInclude(raw, "bb-api");
        assert.include(raw, "me@example.com");

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved).bitbucket;
        assert.equal(forClient.email, "me@example.com");
        assert.notInclude(forClient.accessToken, "bb-access");
        assert.notInclude(forClient.apiToken, "bb-api");
        assert.isAbove(forClient.accessToken.length, 0);
        assert.isAbove(forClient.apiToken.length, 0);

        // A client echoing the redacted values back, or omitting them, keeps the saved tokens.
        yield* serverSettings.updateSettings({ bitbucket: forClient });
        yield* serverSettings.updateSettings({ bitbucket: { email: "other@example.com" } });
        assert.deepEqual((yield* serverSettings.getSettings).bitbucket, {
          email: "other@example.com",
          accessToken: "bb-access",
          apiToken: "bb-api",
        });

        const cleared = yield* serverSettings.updateSettings({ bitbucket: { accessToken: "" } });
        assert.equal(cleared.bitbucket.accessToken, "");
        assert.equal(cleared.bitbucket.apiToken, "bb-api");
        assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
        assert.equal(
          ServerSettingsModule.redactServerSettingsForClient(cleared).bitbucket.accessToken,
          "",
        );
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "keeps GitHub tokens per host in the secret store and tells clients only that one is set",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;

        const saved = yield* serverSettings.updateSettings({
          github: { tokens: { "GitHub.com": "ghp_dotcom", "ghe.acme.test": "ghp_ghe" } },
        });
        assert.deepEqual(saved.github.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "ghp_dotcom");
        assert.notInclude(raw, "ghp_ghe");

        const forClient = ServerSettingsModule.redactServerSettingsForClient(saved).github;
        assert.notInclude(forClient.tokens["github.com"]!, "ghp_dotcom");
        assert.isAbove(forClient.tokens["github.com"]!.length, 0);

        // Echoing the redacted values back keeps them; host and account changes leave tokens alone.
        yield* serverSettings.updateSettings({ github: { tokens: forClient.tokens } });
        yield* serverSettings.updateSettings({
          github: { hosts: { "github.com": { enabled: true, account: "work" } } },
        });
        assert.deepEqual((yield* serverSettings.getSettings).github.tokens, {
          "github.com": "ghp_dotcom",
          "ghe.acme.test": "ghp_ghe",
        });

        // An empty token removes that host's token and nothing else.
        const cleared = yield* serverSettings.updateSettings({
          github: { tokens: { "github.com": "" } },
        });
        assert.equal(cleared.github.tokens["github.com"] ?? "", "");
        assert.equal(cleared.github.tokens["ghe.acme.test"], "ghp_ghe");
        const remaining = yield* Effect.forEach(["github.com", "ghe.acme.test"], (host) =>
          secrets.get(`github-token-${Buffer.from(host, "utf8").toString("base64url")}`),
        );
        assert.isTrue(Option.isNone(remaining[0]!));
        assert.isTrue(Option.isSome(remaining[1]!));
      }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("removes a Bitbucket secret once its token is cleared by hand in settings.json", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // A token was saved, then the user deleted it from settings.json directly.
      yield* secrets.set("bitbucket-access-token", new TextEncoder().encode("stale-token"));
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      yield* serverSettings.updateSettings({ cursorKeychainUsageEnabled: true });

      assert.isTrue(Option.isNone(yield* secrets.get("bitbucket-access-token")));
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect("moves a hand-edited Bitbucket token into the secret store when settings load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"bitbucket":{"accessToken":"hand-edited-token"}}',
      );

      // Loading alone moves it: no settings update is needed.
      const loaded = yield* serverSettings.getSettings;

      assert.equal(loaded.bitbucket.accessToken, "hand-edited-token");
      assert.notInclude(
        yield* fileSystem.readFileString(serverConfig.settingsPath),
        "hand-edited-token",
      );
      const stored = yield* secrets.get("bitbucket-access-token");
      assert.equal(
        Option.isSome(stored) ? new TextDecoder().decode(stored.value) : null,
        "hand-edited-token",
      );
    }).pipe(Effect.provide(layerServerSettingsWithSecrets())),
  );

  it.effect(
    "moves a hand-edited Bitbucket token into the secret store when a client echoes the marker",
    () =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          '{"bitbucket":{"email":"me@example.com","apiToken":"hand-edited-token"}}',
        );

        // The form resends the redacted token when only the email changes.
        const forClient = ServerSettingsModule.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        ).bitbucket;
        const updated = yield* serverSettings.updateSettings({
          bitbucket: { email: "new@example.com", apiToken: forClient.apiToken },
        });

        assert.equal(updated.bitbucket.apiToken, "hand-edited-token");
        assert.equal((yield* serverSettings.getSettings).bitbucket.apiToken, "hand-edited-token");
        assert.notInclude(
          yield* fileSystem.readFileString(serverConfig.settingsPath),
          "hand-edited-token",
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("materializes provider secrets for terminal environment resolution", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("codex_terminal");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-terminal-secret", sensitive: true },
            ],
            config: { homePath: "~/.codex-terminal" },
          },
        },
      });

      const environment = yield* resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: instanceId,
        env: undefined,
      });
      const persisted = yield* fileSystem.readFileString(serverConfig.settingsPath);

      assert.equal(environment.OPENROUTER_API_KEY, "sk-terminal-secret");
      assert.match(environment.CODEX_HOME ?? "", /[\\/][.]codex-terminal$/);
      assert.notInclude(persisted, "sk-terminal-secret");
      assert.include(persisted, '"valueRedacted": true');
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
  it.effect("rolls back provider secret changes when the settings file commit fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let failRename = false;
      let settingsPathToFail: string | undefined;
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        description: "Forced settings write failure.",
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (fromPath, toPath) =>
          failRename && toPath === settingsPathToFail
            ? Effect.fail(writeFailure)
            : fileSystem.rename(fromPath, toPath),
      });
      const instanceId = ProviderInstanceId.make("codex_write_failure");
      const layerSettings = makeServerSettingsLayer().pipe(
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
      );

      yield* Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        settingsPathToFail = (yield* ServerConfig.ServerConfig).settingsPath;
        yield* serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
            config: {},
          },
        });

        failRename = true;
        const failedUpdate = yield* serverSettings
          .updateProviderInstance({
            operation: "upsert",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
              config: {},
            },
          })
          .pipe(Effect.result);
        assert.equal(failedUpdate._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );

        const failed = yield* serverSettings
          .updateProviderInstance({ operation: "remove", instanceId })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    }),
  );

  it.effect.each(["response materialization", "partially committed write"] as const)(
    "rolls back provider secret changes after %s fails",
    (failure) => {
      const textDecoder = new TextDecoder();
      const secrets = new Map<string, Uint8Array>();
      let rejectNewSecret = false;
      const layerSecretStore = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) =>
            Effect.suspend(() => {
              const value = secrets.get(name);
              if (
                failure === "response materialization" &&
                rejectNewSecret &&
                value !== undefined &&
                textDecoder.decode(value) === "sk-new"
              ) {
                return Effect.fail(
                  new ServerSecretStore.SecretStoreReadError({
                    resource: `secret ${name}`,
                    cause: "Forced response materialization failure.",
                  }),
                );
              }
              return Effect.succeed(
                value === undefined ? Option.none() : Option.some(Uint8Array.from(value)),
              );
            }),
          set: (name, value) =>
            Effect.suspend(() => {
              secrets.set(name, Uint8Array.from(value));
              return failure === "partially committed write" &&
                rejectNewSecret &&
                textDecoder.decode(value) === "sk-new"
                ? Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: `secret ${name}`,
                      cause: "chmod failed after rename",
                    }),
                  )
                : Effect.void;
            }),
          create: (name, value) =>
            Effect.sync(() => {
              secrets.set(name, Uint8Array.from(value));
            }),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const value = secrets.get(name) ?? new Uint8Array(bytes);
              secrets.set(name, value);
              return Uint8Array.from(value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              secrets.delete(name);
            }),
        }),
      );
      const layerSettings = ServerSettingsModule.layer.pipe(
        Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provide(layerSecretStore),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3code-server-settings-materialization-failure-test-",
            }),
          ),
        ),
      );
      const instanceId = ProviderInstanceId.make("codex_materialization_failure");

      return Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "OPENROUTER_API_KEY", value: "sk-kept", sensitive: true }],
              config: {},
            },
          },
        });

        rejectNewSecret = true;
        const failedUpdate = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                environment: [{ name: "OPENROUTER_API_KEY", value: "sk-new", sensitive: true }],
                config: {},
              },
            },
          })
          .pipe(Effect.result);

        assert.equal(failedUpdate._tag, "Failure");
        rejectNewSecret = false;
        assert.equal(
          (yield* serverSettings.getSettings).providerInstances[instanceId]?.environment?.[0]
            ?.value,
          "sk-kept",
        );
      }).pipe(Effect.provide(layerSettings));
    },
  );

  it.effect("folds legacy project overrides into projectSettingsOverrides once", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const legacyProject = ProjectId.make("project-legacy");
      const scriptedProject = ProjectId.make("project-scripted");
      const script: ProjectScript = {
        id: "check",
        name: "Check",
        command: "npm test",
        icon: "play",
        runOnWorktreeCreate: false,
      };
      const model = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
      const modelJson = yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
      const scriptsJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(ProjectScript)),
      )([script]);
      for (const [projectId, modelColumn, envMode, autoPull, scripts] of [
        // The legacy project also carries aggregate scripts, but its stored
        // null override reset them; the fold must not bring them back.
        [legacyProject, modelJson, "worktree", 1, scriptsJson],
        [scriptedProject, null, null, 0, scriptsJson],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
          )
          VALUES (
            ${projectId}, ${"Project"}, ${`/tmp/${projectId}`}, ${modelColumn},
            ${envMode}, ${autoPull}, ${scripts},
            ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
          )
        `;
      }
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{"projectAgentBrowserAccessOverrides":{"${legacyProject}":false},"projectAutoPullOverrides":{"${scriptedProject}":true},"projectScriptOverrides":{"${legacyProject}":null}}`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.isTrue(settings.projectSettingsFolded);
      assert.deepEqual<ServerSettings["projectSettingsOverrides"]>(
        settings.projectSettingsOverrides,
        {
          [legacyProject]: {
            enableAgentBrowserAccess: false,
            defaultModelSelection: model,
            defaultThreadEnvMode: "worktree",
            defaultAutoPull: true,
          },
          [scriptedProject]: { defaultAutoPull: true, defaultProjectScripts: [script] },
        },
      );
      // Derived legacy views keep older clients reading the same values.
      assert.deepEqual<ServerSettings["projectAutoPullOverrides"]>(
        settings.projectAutoPullOverrides,
        {
          [legacyProject]: true,
          [scriptedProject]: true,
        },
      );
      assert.deepEqual<ServerSettings["projectScriptOverrides"]>(settings.projectScriptOverrides, {
        [scriptedProject]: [script],
      });

      // A reset survives the next load: the fold does not run again.
      yield* serverSettings.updateSettings({
        projectSettingsOverrides: { [legacyProject]: null },
      });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = yield* decodeServerSettings(JSON.parse(raw));
      assert.isTrue(persisted.projectSettingsFolded);
      assert.isUndefined(persisted.projectSettingsOverrides[legacyProject]);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("leaves an unreadable settings.json untouched instead of folding over it", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at
        )
        VALUES (
          ${"project-broken"}, ${"Project"}, ${"/tmp/project-broken"}, ${1}, ${"[]"},
          ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
        )
      `;
      const broken = '{"defaultAutoPull": tru';
      yield* fileSystem.writeFileString(serverConfig.settingsPath, broken);

      const settings = yield* serverSettings.getSettings;
      assert.isFalse(settings.projectSettingsFolded);
      assert.deepEqual(settings.projectSettingsOverrides, {});
      // The user's file is still there to repair; nothing was written over it.
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), broken);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
