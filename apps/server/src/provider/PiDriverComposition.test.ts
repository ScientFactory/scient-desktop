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
  type ServerSettings as ServerSettingsData,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ManagedRuntimeCatalog from "../scient/providerLifecycle/ManagedRuntimeCatalog.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  buildPiRuntimeGuidance,
  buildPiScientToolNameMap,
  mapPiTurnStartError,
  piCustomModelSnapshot,
  PiDriver,
  type PiCompositionRequirements,
} from "./PiDriverComposition.ts";

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

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-pi-composition-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettings.layerTest(),
  ManagedRuntimeCatalog.layerTest,
  layerTestProviderHost({
    cwd: "/machine",
    settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    runBackgroundWork: false,
  }).pipe(Layer.provide(NodeServices.layer)),
  IdAllocator.layer,
  Layer.succeed(HostProcessEnvironment, {}),
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

it("keeps Pi prompt guidance and model-visible names canonical", () => {
  assert.include(buildPiRuntimeGuidance(), "## Scient");
  assert.include(buildPiRuntimeGuidance(new Set(["preview"])), "## Scient browser");
  assert.notInclude(buildPiRuntimeGuidance(new Set()), "## Scient browser");

  const toolNameMap = buildPiScientToolNameMap();
  assert.strictEqual(toolNameMap.preview_status, "preview_status");
  assert.strictEqual(toolNameMap.scient_pdf_build, "scient_pdf_build");
  assert.isFalse(Object.values(toolNameMap).some((name) => name.includes("t3-code")));
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
});
