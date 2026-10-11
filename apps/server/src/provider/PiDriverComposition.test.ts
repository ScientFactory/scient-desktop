import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  NodeId,
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type CustomModelConnection,
  type ServerSettings as ServerSettingsData,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelManifest from "./ModelManifest.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ManagedRuntimeCatalog from "../scient/providerLifecycle/ManagedRuntimeCatalog.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ResolvedModelConnection } from "../customModels.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  buildPiRuntimeGuidance,
  mapPiTurnStartError,
  piCustomModelSnapshot,
  PiDriver,
  type PiCompositionRequirements,
} from "./PiDriverComposition.ts";
import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  scientToolProjectionForProvider,
} from "./ScientToolProjection.ts";

const PI = ProviderDriverKind.make("pi");
const instanceId = ProviderInstanceId.make("pi-scient-composition");

const piVersionSpawner = ChildProcessSpawner.make((_command) =>
  Effect.gen(function* () {
    const output = new TextEncoder().encode("0.82.0\n");
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(999_999_999),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.succeed(output),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }),
);

const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJsonLine = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeOwnedModelCatalog = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      config: Schema.Struct({
        models: Schema.Array(Schema.Struct({ id: Schema.String })),
      }),
    }),
  ),
);
const encoder = new TextEncoder();

function makePiCompositionDiscoverySpawner(input: {
  readonly onRpcSpawn: (launch: {
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
  }) => void;
  readonly catalogs: Array<unknown>;
}) {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command))
        return yield* Effect.die("Pi discovery should use a standard command");

      const { args, options } = command;
      if (args.includes("--version"))
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.succeed(encoder.encode("0.84.4\n")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });

      const env = options.env ?? {};
      input.onRpcSpawn({ args, env });
      const catalogUrl = env["SCIENT_PI_MODELS_URL"];
      const catalogToken = env["SCIENT_PI_MODELS_TOKEN"];
      if (catalogUrl === undefined || catalogToken === undefined)
        return yield* Effect.die("Pi custom-model extension bootstrap was not configured");

      // Model the one catalog request the owned Pi extension makes at startup.
      const catalogResponse = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.get(catalogUrl).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${catalogToken}`),
          ),
        );
        return { status: response.status, body: yield* response.json };
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie);
      input.catalogs.push(catalogResponse.body);
      if (catalogResponse.status !== 200)
        return yield* Effect.die(`Pi custom-model catalog returned ${catalogResponse.status}`);

      const stdout = yield* Queue.unbounded<Uint8Array>();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          const request = decodeJsonLine(new TextDecoder().decode(chunk).trim());
          const type = request["type"];
          const data =
            type === "get_state"
              ? { thinkingLevel: "medium" }
              : type === "get_available_models"
                ? {
                    models: [
                      {
                        provider: "scient_local-models",
                        id: "local/assistant",
                        name: "Local assistant",
                      },
                    ],
                  }
                : type === "get_commands"
                  ? { commands: [{ name: "scient-models-refresh", source: "extension" }] }
                  : {};
          return Queue.offer(
            stdout,
            encoder.encode(
              `${encodeJsonLine({ type: "response", id: request["id"], command: type, success: true, data })}\n`,
            ),
          ).pipe(Effect.asVoid);
        }),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-pi-composition-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettings.layerTest(),
  ManagedRuntimeCatalog.layerTest,
  TestProviderHost.layer({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }).pipe(Layer.provide(NodeServices.layer)),
  IdAllocator.layer,
  ModelManifest.layerTest,
  ProviderLatestVersions.layer,
  McpProviderSessions.layer,
  Layer.succeed(HostProcess.Environment, {}),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Disabled Pi must not make an HTTP request")),
  ),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, piVersionSpawner),
);

it("registers the app-composed Pi driver with canonical models and config", () => {
  const registered = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === PI);
  assert.strictEqual(registered, PiDriver);
  assert.deepStrictEqual(PiDriver.defaultConfig(), {
    enabled: false,
    binaryPath: "pi",
    launchArgs: "",
    customModels: [],
  });
});

it("keeps Pi prompt guidance and model-visible names on the canonical default", () => {
  assert.include(buildPiRuntimeGuidance(), "## Scient");
  assert.include(buildPiRuntimeGuidance(new Set(["preview"])), "## Scient browser");
  assert.notInclude(buildPiRuntimeGuidance(new Set()), "## Scient browser");

  const piProjection = scientToolProjectionForProvider("pi");
  assert.strictEqual(piProjection, CANONICAL_SCIENT_TOOL_PROJECTION);
  assert.strictEqual(piProjection.name("preview_status"), "preview_status");
  assert.strictEqual(piProjection.name("scient_pdf_build"), "scient_pdf_build");
});

it("preserves an existing Pi native turn receipt", () => {
  const threadId = ThreadId.make("thread:pi-receipt");
  const providerThreadId = ProviderThreadId.make("provider-thread:pi-receipt");
  const runId = RunId.make("run:pi-receipt");
  const receipt = Schema.decodeUnknownSync(OrchestrationV2ProviderTurn)({
    id: ProviderTurnId.make("provider-turn:pi-receipt"),
    providerThreadId,
    nodeId: NodeId.make("node:pi-receipt"),
    runAttemptId: RunAttemptId.make("attempt:pi-receipt"),
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    nativeAcceptance: "accepted",
    startedAt: null,
    completedAt: null,
  });
  const nativeError = new ProviderAdapterTurnStartError({
    driver: PI,
    threadId,
    providerThreadId,
    runId,
    providerTurn: receipt,
  });

  const mapped = mapPiTurnStartError(
    { threadId, providerThread: { id: providerThreadId }, runId },
    nativeError,
  );
  assert.strictEqual(mapped, nativeError);
  assert.deepStrictEqual(mapped.providerTurn, receipt);
});

it("projects only custom models assigned to the Pi instance", () => {
  const settings = {
    customModels: {
      revision: 1,
      connections: [
        {
          id: "local-models",
          name: "Local models",
          protocol: "openai-completions",
          baseUrl: "http://localhost:1234/v1",
          credentialId: null,
          models: [
            {
              id: "pi-model",
              modelId: "local/assistant",
              name: "Local assistant",
              images: false,
              reasoning: false,
              instanceIds: [instanceId],
            },
            {
              id: "other-model",
              modelId: "local/other",
              name: "Other provider model",
              images: false,
              reasoning: false,
              instanceIds: [ProviderInstanceId.make("other-instance")],
            },
          ],
        },
      ],
    },
  } satisfies Pick<ServerSettingsData, "customModels">;

  assert.deepStrictEqual(piCustomModelSnapshot(settings, instanceId), [
    {
      id: "local-models",
      name: "Local models",
      protocol: "openai-completions",
      baseUrl: "http://localhost:1234/v1",
      credentialId: null,
      models: [
        {
          id: "pi-model",
          modelId: "local/assistant",
          name: "Local assistant",
          configurationMode: undefined,
          contextWindow: undefined,
          maxOutputTokens: undefined,
          images: false,
          imageInput: undefined,
          reasoning: false,
          defaultReasoningLevel: undefined,
          reasoningOverride: undefined,
          reasoningMetadata: {
            contextWindow: undefined,
            maxOutputTokens: undefined,
            images: undefined,
          },
        },
      ],
    },
  ]);
});

it.layer(testLayer)("PiDriver production composition", (it) => {
  it.effect("registers managed runtime actions and stamps the live snapshot", () =>
    Effect.gen(function* () {
      const configMap: ProviderInstanceConfigMap = {
        [instanceId]: {
          driver: PI,
          enabled: false,
          config: PiDriver.defaultConfig(),
        },
      };
      const { registry } = yield* makeProviderInstanceRegistry<PiCompositionRequirements>({
        drivers: [PiDriver],
        configMap,
      });
      const instance = yield* registry.getInstance(instanceId);

      assert.isDefined(instance);
      assert.isDefined(instance?.managedRuntimeActions);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      assert.isDefined(snapshot.connection?.runtime);
      assert.deepStrictEqual(snapshot.connection?.methods, []);
      assert.isFalse(snapshot.connection?.canDisconnect);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "strips configured user extensions during production discovery and keeps the owned model extension",
    () =>
      Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const host = yield* ProviderHost.ProviderHost;
        const path = yield* Path.Path;
        const connection: CustomModelConnection = {
          id: "local-models",
          name: "Local models",
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:1234/v1",
          credentialId: "synthetic-credential",
          models: [
            {
              id: "local-model",
              modelId: "local/assistant",
              name: "Local assistant",
              contextWindow: 8192,
              maxOutputTokens: 2048,
              images: false,
              reasoning: false,
              instanceIds: [instanceId],
            },
          ],
        };
        const resolvedConnection: ResolvedModelConnection = {
          ...connection,
          apiKey: Redacted.make("synthetic-custom-model-key"),
        };
        const composedSettings: ServerSettings.ServerSettingsService["Service"] = {
          ...settingsService,
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            customModels: { revision: 1, connections: [connection] },
          }),
          resolveCustomModels: () => Effect.succeed([resolvedConnection]),
        };
        const launches: Array<{ args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> = [];
        const catalogs: Array<unknown> = [];
        const instance = yield* PiDriver.create({
          instanceId,
          displayName: "Pi",
          environment: [],
          enabled: true,
          config: {
            ...PiDriver.defaultConfig(),
            enabled: true,
            launchArgs:
              '-e "/user/short extension.ts" --extension /user/long.ts --extension=/user/equals.ts -e=/user/short-equals.ts --provider anthropic --model "model with space" --thinking high',
          },
        }).pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, composedSettings),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makePiCompositionDiscoverySpawner({
              onRpcSpawn: (launch) => launches.push(launch),
              catalogs,
            }),
          ),
          Effect.provideService(HostProcess.Environment, {
            PI_TOKEN: "synthetic-pi-session-token",
          }),
        );

        yield* instance.snapshot.refresh;
        const snapshot = yield* instance.snapshot.getSnapshot;
        const rpcLaunches = launches.filter((launch) => launch.args.includes("--mode"));
        assert.equal(rpcLaunches.length, 1);
        assert.deepEqual(rpcLaunches[0]?.args, [
          "--mode",
          "rpc",
          "--no-session",
          "--provider",
          "anthropic",
          "--model",
          "model with space",
          "--thinking",
          "high",
          "--no-extensions",
          "--extension",
          path.join(host.paths.stateDir, "pi", "extensions", "scient-custom-models.mjs"),
        ]);
        assert.equal(rpcLaunches[0]?.env.PI_TOKEN, "synthetic-pi-session-token");

        assert.equal(catalogs.length, 1);
        const catalog = decodeOwnedModelCatalog(catalogs[0]);
        const ownedConnection = catalog[0];
        if (ownedConnection === undefined) throw new Error("Expected an owned Pi model catalog");
        assert.equal(ownedConnection.id, "scient_local-models");
        assert.deepEqual(
          ownedConnection.config.models.map((model) => model.id),
          ["local/assistant"],
        );
        assert.isTrue(
          snapshot.models.some(
            (model) => model.name === "Local assistant" && model.subProvider === "Local models",
          ),
        );
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.auth.status, "authenticated");
      }).pipe(Effect.scoped),
  );
});
