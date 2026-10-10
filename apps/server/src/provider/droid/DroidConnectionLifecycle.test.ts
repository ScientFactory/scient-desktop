// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ServerConfig } from "../../config.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { makeDroidTextGeneration } from "../../textGeneration/DroidTextGeneration.ts";
import { makeDroidAcpRuntime } from "../acp/DroidAcpSupport.ts";
import { droidCustomModelId, makeDroidCustomModelsRuntimeFactory } from "./DroidCustomModels.ts";

const instanceId = ProviderInstanceId.make("droid");
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-droid-lifecycle-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const fixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-lifecycle-" });
    const processes: Array<ChildProcessSpawner.ChildProcessHandle> = [];
    // Keep a failing teardown assertion from leaving its real test child behind.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        processes,
        (child) =>
          child.isRunning.pipe(
            Effect.flatMap((running) =>
              running ? child.kill({ forceKillAfter: "1 second" }) : Effect.void,
            ),
            Effect.ignore,
          ),
        { discard: true },
      ),
    );
    const binaryPath = path.join(root, "droid");
    yield* fs.writeFileString(
      binaryPath,
      [
        "#!/bin/sh",
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, "../../../scripts/acp-mock-agent.ts"))} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(binaryPath, 0o755);
    let connections: ReadonlyArray<
      ResolvedModelConnection & {
        readonly apiKey: Redacted.Redacted<string> | null;
        readonly credentialError?: never;
      }
    > = [
      {
        id: "fixture",
        name: "Fixture",
        protocol: "openai-completions",
        baseUrl: "http://localhost:9000/v1",
        credentialId: "first",
        apiKey: Redacted.make("synthetic-key"),
        models: [
          {
            id: "model",
            modelId: "fixture",
            name: "Fixture",
            contextWindow: 128000,
            maxOutputTokens: 8192,
            images: false,
            reasoning: false,
            instanceIds: [instanceId],
          },
        ],
      },
    ];
    const pubsub = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
    const snapshot = () => ({
      ...DEFAULT_SERVER_SETTINGS,
      customModels: { revision: 0, connections },
    });
    const partial = yield* Deferred.make<void>();
    let generation = 0;
    const factory = yield* makeDroidCustomModelsRuntimeFactory(
      {
        committedCustomModels: () => snapshot().customModels,
        resolveCustomModels: () => Effect.sync(() => connections),
        subscribeChanges: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      },
      instanceId,
      (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeDroidAcpRuntime({
            ...input,
            childProcessSpawner: ChildProcessSpawner.make((command) =>
              input.childProcessSpawner.spawn(command).pipe(
                Effect.tap((child) =>
                  Effect.sync(() => {
                    processes.push(child);
                  }),
                ),
              ),
            ),
            environment: {
              ...input.environment,
              HOME: root,
              T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
              // Real Droid offers autonomy_level; background generation requires it.
              T3_ACP_DROID_AUTONOMY: "auto-high",
              T3_ACP_EMIT_CONTENT_THEN_HANG: generation++ === 0 ? "1" : "0",
              T3_ACP_PROMPT_RESPONSE_TEXT: '{"title":"Recovered"}',
            },
          });
          return {
            ...runtime,
            handleSessionUpdate: (handler) =>
              runtime.handleSessionUpdate((notification) =>
                handler(notification).pipe(
                  Effect.tap(() =>
                    notification.update.sessionUpdate === "agent_message_chunk"
                      ? Deferred.succeed(partial, undefined)
                      : Effect.void,
                  ),
                ),
              ),
          };
        }),
      // No organization policy; never the real home folder's Droid settings.
      () => Effect.succeed("overlay-hooks-allowed" as const),
    );
    return {
      root,
      processes,
      factory,
      partial,
      settings: { binaryPath, enabled: true, customModels: [], cloudSessionSync: true },
      selection: { instanceId, model: droidCustomModelId("fixture", "model") },
      update: (kind: "labels" | "add" | "rotate" | "remove") =>
        Effect.gen(function* () {
          connections =
            kind === "remove"
              ? []
              : connections.map((connection) => ({
                  ...connection,
                  ...(kind === "rotate"
                    ? { credentialId: "second", apiKey: Redacted.make("rotated-synthetic-key") }
                    : {}),
                  models:
                    kind === "add"
                      ? [
                          ...connection.models,
                          {
                            ...connection.models[0]!,
                            id: "added",
                            modelId: "added",
                          },
                        ]
                      : connection.models.map((model) =>
                          kind === "labels"
                            ? { ...model, name: "Renamed", defaultReasoningLevel: "high" as const }
                            : model,
                        ),
                }));
          yield* PubSub.publish(pubsub, snapshot());
        }),
    };
  });

it.effect.each(
  (["rotate", "remove"] as const).map((change) => ({
    caseTitle: `terminates revoked background generation and cleans up its replacement after ${change}`,
    change,
  })),
)("$caseTitle", ({ change }) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const generation = yield* makeDroidTextGeneration(f.settings, {}, f.factory);
    const input = { cwd: f.root, message: "test", modelSelection: f.selection };
    const pending = yield* generation
      .generateThreadTitle(input)
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(f.partial);
    yield* f.update(change);
    expect((yield* Fiber.join(pending))._tag).toBe("Failure");
    expect(f.processes).toHaveLength(1);
    expect(yield* f.processes[0]!.isRunning).toBe(false);
    const modelSelection = change === "remove" ? { instanceId, model: "default" } : f.selection;
    expect(yield* generation.generateThreadTitle({ ...input, modelSelection })).toEqual({
      title: "Recovered",
    });
    expect(f.processes).toHaveLength(2);
    expect(yield* f.processes[1]!.isRunning).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
