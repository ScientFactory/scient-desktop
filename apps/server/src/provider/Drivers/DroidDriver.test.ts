// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DroidSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { vi } from "vite-plus/test";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import { ServerConfig } from "../../config.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../ProviderEventLoggers.ts";
import { DroidDriver } from "./DroidDriver.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const makeTestLayer = (settings: Parameters<typeof ServerSettingsService.layerTest>[0] = {}) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "scient-droid-driver-test-",
    }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(IdAllocator.layer),
      Layer.provideMerge(ProviderContinuationRequests.layer),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
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
              updatedAt: EPOCH,
            },
            leases: [],
            activeForegroundLeaseCount: 0,
            activeScopeKeys: [],
            shouldRunOpportunisticWork: true,
            updatedAt: EPOCH,
          }),
          streamChanges: Stream.empty,
          hasDemand: () => Effect.succeed(true),
          shouldRunScopeWork: () => Effect.succeed(true),
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest(settings)),
      Layer.provideMerge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" })),
            ),
          ),
        ),
      ),
      Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    ),
    layerTestProviderHost({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  );
const testLayer = makeTestLayer();

const KEY_CANARY = "sk-canary-3d7f41c09be2a58e";

/** Server settings holding one custom-model connection whose key is the canary. */
const canaryConnectionLayer = (instanceId: ProviderInstanceId) => {
  const connection: ResolvedModelConnection = {
    id: "canary",
    name: "Canary",
    protocol: "openai-completions",
    baseUrl: "https://canary.example/v1",
    credentialId: "canary-key",
    apiKey: Redacted.make(KEY_CANARY),
    models: [
      {
        id: "canary-model",
        modelId: "upstream/canary",
        name: "Canary",
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        images: false,
        reasoning: false,
        instanceIds: [instanceId],
      },
    ],
  };
  return Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettingsService;
      return {
        ...base,
        getSettings: base.getSettings.pipe(
          Effect.map((settings) => ({
            ...settings,
            customModels: { revision: 0, connections: [connection] },
          })),
        ),
        committedCustomModels: () => ({ revision: 0, connections: [connection] }),
        resolveCustomModels: () => Effect.succeed([connection]),
      };
    }),
  ).pipe(Layer.provide(ServerSettingsService.layerTest()));
};

/** A Droid stand-in that records the environment of every process Scient starts. */
function makeRecordingDroid(directory: string): string {
  const binary = NodePath.join(directory, "droid");
  NodeFS.writeFileSync(
    binary,
    [
      "#!/bin/sh",
      `env > ${JSON.stringify(directory)}/"$$.env"`,
      `printf '%s\\n' "$@" > ${JSON.stringify(directory)}/"$$.args"`,
      `if [ "$1" = "--settings" ]; then cp "$2" ${JSON.stringify(directory)}/"$$.overlay"; fi`,
      'if [ "$1" = "--version" ]; then echo "0.228.0"; exit 0; fi',
      'for arg in "$@"; do',
      '  if [ "$arg" = "acp" ]; then',
      "    export T3_ACP_DROID_ASYNC_CONFIG_REFRESH=1",
      "    export T3_ACP_DROID_AUTONOMY=normal",
      `    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "  fi",
      "done",
      "exit 3",
      "",
    ].join("\n"),
  );
  NodeFS.chmodSync(binary, 0o755);
  return binary;
}

const readSpawns = (directory: string) =>
  NodeFS.readdirSync(directory)
    .filter((name) => name.endsWith(".env"))
    .map((name) => ({
      args: NodeFS.readFileSync(NodePath.join(directory, name.replace(/\.env$/, ".args")), "utf8")
        .trim()
        .split("\n"),
      overlay: NodeFS.existsSync(NodePath.join(directory, name.replace(/\.env$/, ".overlay")))
        ? NodeFS.readFileSync(NodePath.join(directory, name.replace(/\.env$/, ".overlay")), "utf8")
        : undefined,
      env: Object.fromEntries(
        NodeFS.readFileSync(NodePath.join(directory, name), "utf8")
          .split("\n")
          .flatMap((line) => {
            const separator = line.indexOf("=");
            return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
          }),
      ),
    }));

/** Exercises the native conversation spawn beside discovery and background generation. */
const runNativeConversation = Effect.fnUntraced(function* (
  instance: Effect.Success<ReturnType<typeof DroidDriver.create>>,
  directory: string,
  threadId: ThreadId,
) {
  const now = yield* DateTime.now;
  const modelSelection = createModelSelection(instance.instanceId, "default");
  const runtimePolicy = {
    cwd: directory,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  const runtime = yield* instance.orchestrationAdapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`${threadId}:session`),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const completion = yield* runtime.events.pipe(
    Stream.filter((event) => event.type === "turn.terminal"),
    Stream.take(1),
    Stream.runCollect,
    Effect.forkChild,
  );
  yield* runtime.startTurn({
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy,
    appThread: {
      id: threadId,
      projectId: ProjectId.make("droid-driver-project"),
      title: "Environment fixture",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instance.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runId: RunId.make(`${threadId}:run`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`${threadId}:attempt`),
    rootNodeId: NodeId.make(`${threadId}:root`),
    message: {
      messageId: MessageId.make(`${threadId}:message`),
      text: "Hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
  });
  const terminal = yield* Fiber.join(completion);
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({ type: "turn.terminal", status: "completed" });
}, Effect.scoped);

it.effect("starts every Droid process with the agent environment contract", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-droid-spawn-env-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    vi.stubEnv("SCIENT_SPAWN_CANARY", "server-internal");
    vi.stubEnv("T3CODE_OTLP_HEADERS", "authorization=Bearer otlp-canary");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("NO_PROXY", "corp.internal");
    vi.stubEnv("no_proxy", undefined);
    vi.stubEnv("FACTORY_API_KEY", undefined);
    // Droid's settings folder, read for its organization policy: never the real one.
    vi.stubEnv("FACTORY_HOME_OVERRIDE", directory);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const instanceId = ProviderInstanceId.make("droid_env");
    const instance = yield* DroidDriver.create({
      instanceId,
      displayName: undefined,
      environment: [{ name: "DROID_INSTANCE_SETTING", value: "configured", sensitive: false }],
      enabled: true,
      config: decodeDroidSettings({ enabled: true, binaryPath: makeRecordingDroid(directory) }),
    });

    // Status (version and ACP probe) and native skills discovery.
    yield* instance.snapshot.refresh;
    // Background text generation, the path the custom-model Test action uses.
    yield* instance.textGeneration
      .generateThreadTitle({
        cwd: directory,
        message: "Title this",
        modelSelection: createModelSelection(instanceId, "custom:Ox-Alpha-0"),
      })
      .pipe(Effect.exit);
    // A conversation session.
    const threadId = ThreadId.make("droid-spawn-env");
    yield* runNativeConversation(instance, directory, threadId);
    // Assisted sign-in, offered when no Factory API key is configured.
    expect(instance.connectionActions).toBeDefined();
    yield* Effect.scoped(
      instance
        .connectionActions!.start("droid_device_pairing")
        .pipe(Effect.timeout("5 seconds"), Effect.exit),
    );

    const spawns = readSpawns(directory);
    const kinds = spawns.map(({ args }) =>
      args[0] === "--version" ? "version" : args.includes("acp") ? "acp" : "sdk",
    );
    expect(kinds.filter((kind) => kind === "version").length).toBeGreaterThanOrEqual(1);
    // Status probe, text generation, the session and sign-in.
    expect(kinds.filter((kind) => kind === "acp").length).toBeGreaterThanOrEqual(4);
    // Native skills discovery through Factory's SDK transport.
    expect(kinds).toContain("sdk");
    for (const { args, env } of spawns) {
      const label = args.join(" ");
      expect(env, label).not.toHaveProperty("SCIENT_SPAWN_CANARY");
      expect(env, label).not.toHaveProperty("T3CODE_OTLP_HEADERS");
      expect(env, label).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
      expect(env.DROID_INSTANCE_SETTING, label).toBe("configured");
      expect(env.NO_PROXY, label).toBe("corp.internal,127.0.0.1,localhost,::1");
      expect(env.no_proxy, label).toBe(env.NO_PROXY);
      expect(env.FACTORY_DROID_AUTO_UPDATE_ENABLED, label).toBe("false");
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live(
  "checks Droid periodically without starting Droid sessions",
  () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "scient-droid-periodic-"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const instance = yield* DroidDriver.create({
        instanceId: ProviderInstanceId.make("droid_periodic"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: decodeDroidSettings({ enabled: true, binaryPath: makeRecordingDroid(directory) }),
      });
      // Spawns still starting may not have written their arguments yet.
      const spawnArgs = () =>
        NodeFS.readdirSync(directory)
          .filter((name) => name.endsWith(".args"))
          .map((name) => NodeFS.readFileSync(NodePath.join(directory, name), "utf8"));
      const acpSpawns = () => spawnArgs().filter((args) => args.includes("acp")).length;
      const versionSpawns = () => spawnArgs().filter((args) => args.startsWith("--version")).length;
      // The startup probe is a full probe: one ACP session.
      while ((yield* instance.snapshot.getSnapshot).status !== "ready")
        yield* Effect.sleep("20 millis");
      const afterProbe = { acp: acpSpawns(), version: versionSpawns() };
      expect(afterProbe.acp).toBe(1);
      // Several periodic checks at the configured interval.
      yield* Effect.sleep("1200 millis");
      expect(acpSpawns()).toBe(afterProbe.acp);
      expect(versionSpawns()).toBeGreaterThan(afterProbe.version);
      expect((yield* instance.snapshot.getSnapshot).status).toBe("ready");
    }).pipe(
      Effect.scoped,
      Effect.provide(makeTestLayer({ providerHealthRefreshInterval: Duration.millis(200) })),
    ),
  20_000,
);

it.effect("gives no Droid process a custom-model key, on any spawn path", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "scient-droid-key-canary-"),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    vi.stubEnv("FACTORY_API_KEY", undefined);
    // Droid's settings folder, read for its organization policy: never the real one.
    vi.stubEnv("FACTORY_HOME_OVERRIDE", directory);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const instanceId = ProviderInstanceId.make("droid_key_canary");
    const instance = yield* DroidDriver.create({
      instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: decodeDroidSettings({ enabled: true, binaryPath: makeRecordingDroid(directory) }),
    }).pipe(Effect.provide(canaryConnectionLayer(instanceId)));

    yield* instance.snapshot.refresh;
    yield* instance.textGeneration
      .generateThreadTitle({
        cwd: directory,
        message: "Title this",
        modelSelection: createModelSelection(instanceId, "custom:Ox-Alpha-0"),
      })
      .pipe(Effect.exit);
    const threadId = ThreadId.make("droid-key-canary");
    yield* runNativeConversation(instance, directory, threadId);
    yield* Effect.scoped(
      instance
        .connectionActions!.start("droid_device_pairing")
        .pipe(Effect.timeout("5 seconds"), Effect.exit),
    );

    const spawns = readSpawns(directory);
    const overlays = spawns.flatMap(({ overlay }) => (overlay === undefined ? [] : [overlay]));
    // The connection was loaded: its model reached Droid through a broker route.
    expect(overlays.length).toBeGreaterThanOrEqual(3);
    for (const overlay of overlays) {
      expect(overlay).toContain('"model":"upstream/canary"');
      expect(overlay).toContain('"apiKey":"scient-cap-');
    }
    for (const { args, env, overlay } of spawns) {
      const label = args.join(" ");
      expect(label).not.toContain(KEY_CANARY);
      expect(Object.values(env).join("\n"), label).not.toContain(KEY_CANARY);
      expect(overlay ?? "", label).not.toContain(KEY_CANARY);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
