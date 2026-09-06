// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { makeDroidTextGeneration } from "../../textGeneration/DroidTextGeneration.ts";
import { makeDroidAdapter } from "../Layers/DroidAdapter.ts";
import { makeDroidAcpRuntime } from "../acp/DroidAcpSupport.ts";
import { droidCustomModelId, makeDroidCustomModelsRuntimeFactory } from "./DroidCustomModels.ts";

const instanceId = ProviderInstanceId.make("droid");
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "scient-droid-lifecycle-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const fixture = (stallFirst = true) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-lifecycle-" });
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
    const promptEntered = yield* Deferred.make<void>();
    const releasePrompt = yield* Deferred.make<void>();
    let generation = 0;
    const factory = yield* makeDroidCustomModelsRuntimeFactory(
      {
        getSettings: Effect.sync(snapshot),
        resolveCustomModels: () => Effect.sync(() => connections),
        subscribeChanges: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      },
      instanceId,
      (input) =>
        Effect.gen(function* () {
          const runtime = yield* makeDroidAcpRuntime({
            ...input,
            environment: {
              ...input.environment,
              HOME: root,
              T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
              T3_ACP_EMIT_CONTENT_THEN_HANG: generation++ === 0 && stallFirst ? "1" : "0",
              T3_ACP_PROMPT_RESPONSE_TEXT: '{"title":"Recovered"}',
            },
          });
          return {
            ...runtime,
            prompt: (...args: Parameters<typeof runtime.prompt>) =>
              (stallFirst
                ? Effect.void
                : Deferred.succeed(promptEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePrompt)),
                  )
              ).pipe(Effect.andThen(runtime.prompt(...args))),
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
    );
    return {
      root,
      factory,
      partial,
      promptEntered,
      releasePrompt,
      settings: { binaryPath, enabled: true, customModels: [] },
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

it.effect(
  "finishes an active turn after adding another model and adopts it at the idle boundary",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(false);
      const adapter = yield* makeDroidAdapter(f.settings, {
        instanceId,
        makeAcpRuntime: f.factory,
      });
      const threadId = ThreadId.make("droid-add-model");
      const input = {
        threadId,
        cwd: f.root,
        runtimeMode: "full-access" as const,
        modelSelection: f.selection,
      };
      const original = yield* adapter.startSession(input);
      const events = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const sending = yield* adapter
        .sendTurn({ threadId, input: "answer", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(f.promptEntered);
      yield* f.update("add");
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      yield* Deferred.succeed(f.releasePrompt, undefined);
      yield* Fiber.join(sending);
      const completed = (yield* Fiber.join(events)).filter(
        (event) => event.type === "turn.completed",
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]!.payload.state).toBe("completed");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      const modelSelection = { instanceId, model: droidCustomModelId("fixture", "added") };
      yield* adapter.startSession({
        ...input,
        modelSelection,
        resumeCursor: original.resumeCursor,
      });
      const next = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "continue", attachments: [], modelSelection });
      expect(
        (yield* Fiber.join(next)).find((event) => event.type === "turn.completed")?.payload.state,
      ).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

for (const change of ["rotate", "remove"] as const) {
  it.effect(`preserves partial chat output, settles once and recovers after ${change}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const adapter = yield* makeDroidAdapter(f.settings, {
        instanceId,
        makeAcpRuntime: f.factory,
      });
      const threadId = ThreadId.make(`droid-active-${change}`);
      const startInput = {
        threadId,
        cwd: f.root,
        runtimeMode: "full-access" as const,
        modelSelection: f.selection,
      };
      const original = yield* adapter.startSession(startInput);
      const chatPartial = yield* Deferred.make<void>();
      const events = yield* adapter.streamEvents.pipe(
        Stream.tap((event) =>
          event.type === "content.delta" ? Deferred.succeed(chatPartial, undefined) : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const sending = yield* adapter
        .sendTurn({ threadId, input: "hello", attachments: [] })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(chatPartial);
      yield* f.update("labels");
      yield* f.update("add");
      // Pending discovery freshness must not make an active runtime appear absent.
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect((yield* adapter.listSessions()).some((session) => session.threadId === threadId)).toBe(
        true,
      );
      // A direct factory check is covered separately; here revocation must still settle active work.
      yield* f.update(change);
      yield* Fiber.join(sending);
      const terminalEvents = yield* Fiber.join(events);
      expect(terminalEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(terminalEvents.find((event) => event.type === "turn.completed")?.payload.state).toBe(
        "cancelled",
      );
      expect(
        terminalEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "partial before stall",
        ),
      ).toBe(true);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      const nextSelection = change === "remove" ? { instanceId, model: "default" } : f.selection;
      yield* adapter.startSession({
        ...startInput,
        modelSelection: nextSelection,
        resumeCursor: original.resumeCursor,
      });
      const recovered = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({
        threadId,
        input: "continue",
        attachments: [],
        modelSelection: nextSelection,
      });
      expect(
        (yield* Fiber.join(recovered)).find((event) => event.type === "turn.completed")?.payload
          .state,
      ).toBe("completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect(
    `fails interrupted background generation and succeeds on the next request after ${change}`,
    () =>
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
        const modelSelection = change === "remove" ? { instanceId, model: "default" } : f.selection;
        expect(yield* generation.generateThreadTitle({ ...input, modelSelection })).toEqual({
          title: "Recovered",
        });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
}
