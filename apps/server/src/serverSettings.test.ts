import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type CustomModel,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { customModelSecretName } from "./customModels.ts";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminal/Manager.ts";

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));
const encodeSettingsJson = Schema.encodeEffect(Schema.fromJsonString(ServerSettings));

const makeServerSettingsLayer = (secretLayer = ServerSecretStore.layer) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(secretLayer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const makeFailingSecretStoreLayer = (cause: ServerSecretStore.SecretStoreError) =>
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

it.layer(NodeServices.layer)("server settings", (it) => {
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

  for (const scenario of ["automatic", "overrides", "legacy"] as const) {
    it.effect(`restores ${scenario} model capabilities after a settings-service restart`, () =>
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
              Layer.provide(Layer.fresh(SqlitePersistenceMemory)),
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
            const settings = yield* decodeSettingsJson(
              yield* fs.readFileString(config.settingsPath),
            );
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
  }

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

  for (const action of ["rotate", "remove"] as const) {
    it.effect(`keeps an in-progress credential read coherent during ${action}`, () =>
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
  }

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
      if ((yield* HostProcessPlatform) !== "win32") assert.equal(stat.mode & 0o777, 0o600);
      yield* service.updateSettings({ enableProviderUpdateChecks: false });
      assert.deepEqual((yield* service.getSettings).customModels, saved);
      yield* service.removeCustomModel({ revision: 1, connectionId: "fixture" });
      assert.equal(yield* fs.exists(keyFile), false);
      assert.deepEqual((yield* service.getSettings).customModels, { revision: 2, connections: [] });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
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
    const configLayer = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-secret-failure-test-",
      }),
    );
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(makeFailingSecretStoreLayer(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(configLayer),
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
    }).pipe(Effect.provide(settingsLayer));
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

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }),
        {
          providers: { codex: { binaryPath: "/tmp/codex" } },
        },
      );

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
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
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
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        homePath: "",
        customModels: ["claude-custom"],
        launchArgs: "",
        autoCompactWindow: "",
      });
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

  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex-next",
            },
          },
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("1 second"));
        assert.equal(
          Option.getOrUndefined(firstChange)?.providers.codex.binaryPath,
          "/usr/local/bin/codex-next",
        );
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
        // @effect-diagnostics-next-line preferSchemaOverJson:off
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
    "uses explicit provider instance enabled state over legacy provider enabled state",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providers: {
            claudeAgent: {
              enabled: false,
            },
          },
          providerInstances: {
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
          // @effect-diagnostics-next-line preferSchemaOverJson:off
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

  it.effect("enables previously used providers from sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"opencode":{"serverUrl":"http://127.0.0.1:4096"}}}',
      );
      yield* recordProviderUsage("opencode");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.isFalse(settings.providers.droid.enabled);
      assert.equal(settings.providers.opencode.serverUrl, "http://127.0.0.1:4096");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores a previously used Scient Droid provider and instance", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"droid_work":{"driver":"droid","config":{}}}}',
      );
      yield* recordProviderUsage("droid", "droid_work");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.droid.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("droid_work")]?.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves existing provider instances without explicit enabled flags", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"cursor_work":{"driver":"cursor","config":{}},"grok":{"driver":"grok","config":{}},"opencode_work":{"driver":"opencode","config":{"serverUrl":"http://127.0.0.1:4096"}},"opencode_unused":{"driver":"opencode","config":{}}}}',
      );
      yield* recordProviderUsage("cursor", "cursor_work");
      yield* recordProviderUsage("grok", null);
      yield* recordProviderUsage("opencode", "opencode_work");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("opencode_work")]?.enabled);
      const unused = settings.providerInstances[ProviderInstanceId.make("opencode_unused")];
      assert.isDefined(unused);
      assert.isFalse(resolveProviderInstanceEnabled(unused));
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves explicit provider disables in existing settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"grok":{"enabled":false},"opencode":{"enabled":false},"cursor":{"enabled":false}},"providerInstances":{"grok":{"driver":"grok","enabled":false,"config":{}},"opencode":{"driver":"opencode","config":{"enabled":false}},"cursor":{"driver":"cursor","enabled":false,"config":{}}}}',
      );
      yield* recordProviderUsage("grok");
      yield* recordProviderUsage("opencode");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.isFalse(settings.providers.droid.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("opencode")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("cursor")]?.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("skips a disabled provider instance when picking the text generation fallback", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // The Providers UI writes providerInstances only, so the legacy providers
      // map decodes to defaults where codex is enabled and listed first.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex":{"driver":"codex","enabled":false,"config":{}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.textGenerationModelSelection.instanceId, "claudeAgent");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps unused providers disabled in existing sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves provider history when no settings file exists", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.isFalse(settings.providers.droid.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves provider history when the settings file is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{invalid json");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.droid.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves valid provider flags when another settings field is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"addProjectBaseDirectory":42,"providers":{"cursor":{"enabled":false},"grok":{"enabled":true}}}',
      );
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.cursor.enabled);
      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores providers from persisted runtime sessions", () =>
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

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists explicit disables after a provider has been used", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      assert.isTrue((yield* serverSettings.getSettings).providers.grok.enabled);

      const settings = yield* serverSettings.updateSettings({
        providers: { grok: { enabled: false } },
      });
      assert.isFalse(settings.providers.grok.enabled);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.isFalse(JSON.parse(raw).providers.grok.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists explicit provider enables before their first use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          cursor: { enabled: true },
          droid: { enabled: true },
          grok: { enabled: true },
          opencode: { enabled: true },
        },
      });
      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Development" });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw);
      assert.isTrue(persisted.providers.cursor.enabled);
      assert.isTrue(persisted.providers.droid.enabled);
      assert.isTrue(persisted.providers.grok.enabled);
      assert.isTrue(persisted.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps optional providers disabled after a new installation writes settings", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const initial = yield* serverSettings.getSettings;
      assert.isFalse(initial.providers.grok.enabled);
      assert.isFalse(initial.providers.opencode.enabled);
      assert.isFalse(initial.providers.cursor.enabled);
      assert.isFalse(initial.providers.droid.enabled);

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        },
      });

      assert.isFalse(next.providers.grok.enabled);
      assert.isFalse(next.providers.opencode.enabled);
      assert.isFalse(next.providers.cursor.enabled);
      assert.isFalse(next.providers.droid.enabled);
      const grok = next.providerInstances[ProviderInstanceId.make("grok")];
      assert.isDefined(grok);
      assert.isFalse(resolveProviderInstanceEnabled(grok));

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw);
      assert.isFalse(persisted.providers.cursor.enabled);
      assert.isFalse(persisted.providers.droid.enabled);
      assert.isFalse(persisted.providers.grok.enabled);
      assert.isFalse(persisted.providers.opencode.enabled);
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

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
          opencode: {
            binaryPath: "  /opt/homebrew/bin/opencode  ",
            serverUrl: "  http://127.0.0.1:4096  ",
            serverPassword: "  secret-password  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        homePath: "",
        customModels: [],
        launchArgs: "",
        autoCompactWindow: "",
      });
      assert.deepEqual(next.providers.opencode, {
        // OpenCode is disabled by default; this update only touches paths.
        enabled: false,
        binaryPath: "/opt/homebrew/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "secret-password",
        customModels: [],
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
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes non-default settings and explicit optional provider defaults to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          cursor: {
            enabled: false,
          },
          droid: {
            enabled: false,
          },
          grok: {
            enabled: false,
          },
          opencode: {
            enabled: false,
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
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
    const secretLayer = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        set: () => Effect.fail(cause),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(secretLayer),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
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
    }).pipe(Effect.provide(settingsLayer));
  });

  for (const { label, variable, expected, duplicate } of [
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
  ]) {
    it.effect(label, () =>
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
  }

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
      // @effect-diagnostics-next-line preferSchemaOverJson:off
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
});
