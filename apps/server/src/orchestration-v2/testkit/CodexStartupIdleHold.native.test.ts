import * as Crypto from "effect/Crypto";
// @effect-diagnostics nodeBuiltinImport:off
/** Only external JSONL is controlled: native adapter, manager, turn start and worker are production. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { makeCodexAdapterV2 } from "../Adapters/CodexAdapterV2.ts";
import { EventStoreV2 } from "../EventStore.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "gpt-5.4" };
const settings = Schema.decodeSync(CodexSettings)({});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Number),
      method: Schema.optional(Schema.String),
    }),
  ),
);
const IDLE_TIMEOUT_MS = 5;
const turn = (id: string, status: "inProgress" | "completed") => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "completed" ? 1782622450 : null,
  durationMs: null,
});

const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (p: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  return Option.getOrThrow(found);
});

it.live("keeps a fresh Codex session through startup that outlasts the idle window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const allocator = yield* IdAllocatorV2;
      const cwd = yield* checkpointWorkspace("codex-startup-idle-hold");
      const threadStartReceived = yield* Deferred.make<void>();
      const threadStartReleased = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const offered: string[] = [];
      const clientFactory = {
        open: () =>
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<Uint8Array>();
            yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
            const emit = (frame: unknown) =>
              Queue.offer(queue, new TextEncoder().encode(`${encodeJson(frame)}\n`));
            let buffer = "";
            const process = (chunk: string | Uint8Array) =>
              Effect.gen(function* () {
                buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                while (buffer.includes("\n")) {
                  const newline = buffer.indexOf("\n");
                  const frame = decodeFrame(buffer.slice(0, newline));
                  buffer = buffer.slice(newline + 1);
                  if (frame.id === undefined || frame.method === undefined) continue;
                  switch (frame.method) {
                    case "initialize":
                      yield* emit({
                        id: frame.id,
                        result: {
                          userAgent: "Synthetic Codex",
                          codexHome: "/synthetic",
                          platformFamily: "unix",
                          platformOs: "macos",
                        },
                      });
                      break;
                    case "thread/start":
                      // Startup preparation is still pending while this reply is held.
                      yield* Deferred.succeed(threadStartReceived, undefined);
                      yield* Deferred.await(threadStartReleased);
                      yield* emit({
                        id: frame.id,
                        result: {
                          thread: {
                            id: "startup-native",
                            sessionId: "startup-native",
                            forkedFromId: null,
                            preview: "",
                            projectId: null,
                            ephemeral: false,
                            modelProvider: "openai",
                            createdAt: 1782622440,
                            updatedAt: 1782622440,
                            status: { type: "idle" },
                            path: "/synthetic/startup-native.jsonl",
                            cwd,
                            cliVersion: "0.156.1",
                            source: "vscode",
                            threadSource: null,
                            agentNickname: null,
                            agentRole: null,
                            gitInfo: null,
                            name: null,
                            turns: [],
                          },
                          model: "gpt-5.4",
                          modelProvider: "openai",
                          serviceTier: null,
                          cwd,
                          instructionSources: [],
                          approvalPolicy: "on-request",
                          approvalsReviewer: "user",
                          sandbox: {
                            type: "workspaceWrite",
                            writableRoots: [],
                            networkAccess: false,
                          },
                          reasoningEffort: "medium",
                        },
                      });
                      break;
                    case "turn/start":
                      offered.push(frame.method);
                      yield* emit({
                        id: frame.id,
                        result: { turn: turn("startup-turn", "inProgress") },
                      });
                      yield* emit({
                        method: "turn/started",
                        params: {
                          threadId: "startup-native",
                          turn: turn("startup-turn", "inProgress"),
                        },
                      });
                      yield* emit({
                        method: "turn/completed",
                        params: {
                          threadId: "startup-native",
                          turn: turn("startup-turn", "completed"),
                        },
                      });
                      break;
                    default:
                      return yield* Effect.die(`Unexpected native request ${frame.method}`);
                  }
                }
              });
            return yield* CodexClient.make(
              Stdio.make({
                args: Effect.succeed([]),
                stdin: Stream.fromQueue(queue),
                stdout: () => Sink.forEach(process),
                stderr: () => Sink.drain,
              }),
            );
          }),
      };
      const registry = makeLayer([
        makeCodexAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          settings,
          environment: {},
          fileSystem: fs,
          path,
          idAllocator: allocator,
          serverConfig: config,
          clientFactory,
          resolveRuntime: Effect.succeed({
            config: { ...settings, binaryPath: "/synthetic/codex" },
            environment: { HOME: "/synthetic/home" },
            revision: "synthetic",
          }),
        }),
      ]);
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "codex-startup-idle-hold", runtimePolicyOverride: { cwd } },
        registry,
        {
          providerSessionIdleTimeoutMs: IDLE_TIMEOUT_MS,
          layerServerConfig: Layer.succeed(ServerConfig, config),
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const projectId = ProjectId.make("startup-idle-project");
        const threadId = ThreadId.make("startup-idle-thread");
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* (yield* EventStoreV2).appendProjectEvent({
          eventId: EventId.make("startup-idle-project-create"),
          type: "project.created",
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Startup idle",
            workspaceRoot: cwd,
            scripts: [],
            defaultModelSelection: selection,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          threadId,
          commandId: CommandId.make(`create:${threadId}`),
          projectId,
          title: "Startup idle",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          threadId,
          commandId: CommandId.make(`send:${threadId}`),
          messageId: MessageId.make(`send:${threadId}`),
          text: "Start after slow preparation",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Deferred.await(threadStartReceived).pipe(Effect.timeout("10 seconds"));
        // Many idle windows pass while the canonical start is still preparing.
        yield* Effect.sleep(`${IDLE_TIMEOUT_MS * 20} millis`);
        assert.isFalse(yield* Deferred.isDone(closed), "idle release retired a pending start");
        yield* Deferred.succeed(threadStartReleased, undefined);
        const completed = yield* waitFor(threadId, (p) => p.runs.at(-1)?.status === "completed");
        assert.equal(completed.runs.length, 1);
        assert.deepEqual(offered, ["turn/start"]);
        // Once the turn is over, the ordinary idle release still retires the session.
        yield* Deferred.await(closed).pipe(Effect.timeout("10 seconds"));
      }).pipe(
        Effect.ensuring(Deferred.succeed(threadStartReleased, undefined)),
        Effect.provide(layer),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          idAllocatorLayer,
          ServerConfig.layerTest(process.cwd(), { prefix: "codex-startup-idle-hold-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          Layer.succeed(HostProcessEnvironment, {}),
        ),
      ),
      Effect.timeout("60 seconds"),
    ),
  ),
);
