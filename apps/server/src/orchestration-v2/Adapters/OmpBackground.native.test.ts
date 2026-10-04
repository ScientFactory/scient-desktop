import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { scriptedOmpRpc } from "../../provider/testUtils/scriptedOmpRpc.ts";
import { IdAllocatorV2, layer as allocatorLayer } from "../IdAllocator.ts";
import { EffectOutboxV2 } from "../EffectOutbox.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { makeLayerEffect } from "../ProviderAdapterRegistry.ts";
import { ProviderContinuationRequests } from "../ProviderContinuationRequests.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import { makeOmpAdapterV2 } from "./OmpAdapterV2.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  allocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-background-native-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

/** Real native RPC, continuation worker and durable projection share one provider session. */
const fixture = Effect.fnUntraced(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const allocator = yield* IdAllocatorV2;
  const cwd = yield* checkpointWorkspace("omp-background-native");
  const instanceId = ProviderInstanceId.make("omp-native-background-instance");
  const threadId = ThreadId.make("omp-native-background-thread");
  const modelSelection = { instanceId, model: "test/selected" };
  const peer = scriptedOmpRpc({ models: [], initial: { provider: "test", id: "selected" } });
  const registry = makeLayerEffect(
    Effect.gen(function* () {
      return [
        makeOmpAdapterV2({
          target: ompTarget,
          instanceId,
          settings: { binaryPath: "synthetic-omp" },
          environment: { HOME: config.stateDir },
          fileSystem: fs,
          path,
          crypto,
          spawner,
          idAllocator: allocator,
          serverConfig: config,
          makeProcess: peer.makeProcess,
          continuations: yield* ProviderContinuationRequests,
        }),
      ];
    }),
  );
  const runtimeLayer = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "omp-native-background", runtimePolicyOverride: { cwd } },
    registry,
    {
      configureMcp: false,
      runEffectWorker: true,
      runContinuationWorker: true,
      serverConfigLayer: Layer.succeed(ServerConfig.ServerConfig, config),
    },
  );
  const initialize = Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const outbox = yield* EffectOutboxV2;
    const completed = (commandId: CommandId) =>
      Effect.gen(function* () {
        const updates = yield* outbox.subscribeCompletions;
        const done = yield* Stream.concat(Stream.succeed(undefined), updates).pipe(
          Stream.mapEffect(() => outbox.listByCommandId(commandId)),
          Stream.filter(
            (rows) => rows.length > 0 && rows.every((row) => row.status === "succeeded"),
          ),
          Stream.runHead,
        );
        if (Option.isNone(done)) return yield* Effect.die("Native effect completion stream ended");
      }).pipe(Effect.timeout("10 seconds"));
    const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
      Effect.gen(function* () {
        const sequence = yield* orchestrator.getThreadEventSequence(threadId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence: sequence }),
        );
        const found = yield* Stream.concat(
          Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
          Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
          ),
        ).pipe(Stream.filter(predicate), Stream.runHead);
        if (Option.isNone(found))
          return yield* Effect.die("Native background projection ended before receipt");
        return found.value;
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.tapError(() =>
          orchestrator.getThreadProjection(threadId).pipe(
            Effect.flatMap((p) =>
              Effect.logWarning("Native background receipt timeout", {
                runs: p.runs.map((r) => ({ id: r.id, status: r.status })),
                sessions: p.providerSessions.map((row) => ({ id: row.id, status: row.status })),
                threads: p.providerThreads.map((row) => ({
                  id: row.id,
                  status: row.status,
                  pending: row.pendingBackgroundTasks,
                })),
                shutdowns: peer.state.shutdowns,
              }),
            ),
          ),
        ),
      );
    let ordinal = 0;
    const send = (text: string) => {
      ordinal++;
      return orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`background-send-${ordinal}`),
          threadId,
          messageId: MessageId.make(`background-message-${ordinal}`),
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.asVoid);
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("background-create"),
      threadId,
      projectId: ProjectId.make("background-project"),
      title: "Native background",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return { orchestrator, waitFor, send, completed };
  });
  const run = <A, E, R>(
    body: (state: Effect.Success<typeof initialize>) => Effect.Effect<A, E, R>,
  ) => initialize.pipe(Effect.flatMap(body), Effect.provide(runtimeLayer));
  const emit = (frames: ReadonlyArray<Record<string, unknown>>) =>
    Effect.sync(() => {
      for (const frame of frames) {
        if (frame.type === "agent_start") peer.state.streaming = true;
        if (frame.type === "agent_end" || frame.type === "session_settled")
          peer.state.streaming = false;
        if (frame.type === "session_settled") peer.state.pendingAsyncWork = false;
      }
    }).pipe(Effect.andThen(peer.emit(frames)));
  const finish = (sessionSettled: boolean) => {
    peer.state.pendingAsyncWork = !sessionSettled;
    return emit([
      { type: "agent_end", messages: [], isTerminal: true },
      {
        type: "prompt_result",
        id: peer.state.prompts.at(-1)?.frame.id,
        status: "completed",
        sessionSettled,
      },
    ]);
  };
  return { peer, emit, run, finish, threadId };
});

describe("native OMP persisted background work", () => {
  it.live("settles an idle native child under its original run without admitting a wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(({ waitFor, send }) =>
          Effect.gen(function* () {
            yield* send("Delegate a child");
            yield* waitFor((p) => p.providerTurns.some((t) => t.nativeAcceptance === "accepted"));
            yield* f.emit([
              { type: "agent_start" },
              {
                type: "subagent_lifecycle",
                payload: {
                  id: "retained-child",
                  agent: "task",
                  detached: true,
                  status: "started",
                  description: "Review background evidence",
                },
              },
            ]);
            const started = yield* waitFor((p) => p.subagents.some((s) => s.status === "running"));
            const child = started.subagents[0]!;
            yield* f.finish(false);
            const parent = yield* waitFor((p) => p.runs.some((r) => r.status === "completed"));
            expect(parent.providerThreads[0]?.pendingBackgroundTasks).toHaveLength(1);
            yield* send("Another question while the child runs");
            yield* waitFor(
              (p) => p.providerTurns.filter((t) => t.nativeAcceptance === "accepted").length === 2,
            );
            yield* f.emit([
              { type: "agent_start" },
              {
                type: "subagent_lifecycle",
                payload: {
                  id: "second-child",
                  agent: "task",
                  detached: true,
                  status: "started",
                  description: "Review next evidence",
                },
              },
            ]);
            yield* waitFor((p) => p.subagents.length === 2);
            yield* f.finish(false);
            const another = yield* waitFor(
              (p) => p.runs.filter((r) => r.status === "completed").length === 2,
            );
            expect(another.subagents.find((s) => s.id === child.id)?.status).toBe("running");
            yield* f.emit([
              {
                type: "subagent_progress",
                payload: {
                  id: "retained-child",
                  progress: {
                    id: "retained-child",
                    status: "running",
                    description: "Still reviewing",
                  },
                },
              },
            ]);
            const progress = yield* waitFor((p) =>
              p.subagents.some((s) => s.id === child.id && s.title === "Still reviewing"),
            );
            expect(progress.subagents.find((s) => s.id === child.id)?.runId).toBe(child.runId);
            yield* f.emit([
              {
                type: "subagent_lifecycle",
                payload: {
                  id: "retained-child",
                  agent: "task",
                  detached: true,
                  status: "completed",
                  description: "Review background evidence",
                },
              },
            ]);
            const settled = yield* waitFor((p) =>
              p.subagents.some((s) => s.id === child.id && s.status === "completed"),
            );
            expect(settled.runs).toHaveLength(2);
            expect(settled.subagents.find((s) => s.id === child.id)?.runId).toBe(child.runId);
            expect(settled.subagents.find((s) => s.id === child.id)?.status).toBe("completed");
            expect(f.peer.state.prompts).toHaveLength(2);
            yield* f.emit([{ type: "session_settled" }]);
            const closed = yield* waitFor((p) =>
              p.providerThreads.every((t) => t.pendingBackgroundTasks?.length === 0),
            );
            expect(closed.subagents.find((s) => s.id !== child.id)?.status).toBe("cancelled");
            expect(closed.runs).toHaveLength(2);
          }),
        );
      }),
    ).pipe(Effect.provide(dependencies)),
  );
  it.live("persists an unnamed native monitor and admits its visible continuation and Steer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(({ orchestrator, waitFor, send, completed }) =>
          Effect.gen(function* () {
            yield* send("Work in the background");
            yield* waitFor((p) => p.providerTurns.some((t) => t.nativeAcceptance === "accepted"));
            yield* f.emit([{ type: "agent_start" }]);
            yield* f.finish(false);
            const parent = yield* waitFor((p) => p.runs.some((r) => r.status === "completed"));
            expect(parent.providerThreads[0]?.pendingBackgroundTasks).toMatchObject([
              { kind: "monitor" },
            ]);
            yield* f.emit([
              { type: "agent_start" },
              {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "I have the background result." }],
                },
              },
            ]);
            const awake = yield* waitFor(
              (p) =>
                p.runs.length === 2 &&
                p.runs[1]?.status === "running" &&
                p.messages.some((m) => m.text === "I have the background result."),
            );
            const wake = awake.runs[1]!;
            expect(wake.id).not.toBe(parent.runs[0]?.id);
            expect(f.peer.state.prompts).toHaveLength(1);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("background-steer"),
              threadId: f.threadId,
              messageId: MessageId.make("background-steer-message"),
              text: "Include a summary",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "steer_active", targetRunId: wake.id },
            });
            yield* waitFor((p) =>
              p.turnItems.some(
                (item) =>
                  item.type === "user_message" &&
                  item.inputIntent === "steer" &&
                  item.status === "completed",
              ),
            );
            yield* completed(CommandId.make("background-steer"));
            expect(f.peer.state.frames.findLast((frame) => frame.type === "steer")).toMatchObject({
              message: "Include a summary",
            });
            yield* f.emit([{ type: "agent_end", messages: [] }, { type: "session_settled" }]);
            const settled = yield* waitFor(
              (p) =>
                p.runs.length === 2 &&
                p.runs.every((r) => r.status === "completed") &&
                p.providerThreads.every((t) => t.pendingBackgroundTasks?.length === 0),
            );
            expect(settled.providerTurns).toHaveLength(2);
          }),
        );
      }),
    ).pipe(Effect.provide(dependencies)),
  );

  it.live(
    "answers a user message in its own run before a marked native background continuation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.run(({ waitFor, send }) =>
            Effect.gen(function* () {
              yield* send("Work in the background");
              yield* waitFor((p) => p.providerTurns.some((t) => t.nativeAcceptance === "accepted"));
              yield* f.emit([{ type: "agent_start" }]);
              yield* f.finish(false);
              const first = yield* waitFor((p) => p.runs.some((r) => r.status === "completed"));
              yield* send("Another question");
              yield* waitFor(
                (p) =>
                  p.providerTurns.filter((t) => t.nativeAcceptance === "accepted").length === 2,
              );
              yield* f.emit([
                { type: "agent_start" },
                {
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "This answer belongs to the user question." }],
                  },
                },
              ]);
              yield* f.finish(false);
              const second = yield* waitFor(
                (p) => p.runs.filter((r) => r.status === "completed").length === 2,
              );
              const userRun = second.runs[1]!;
              expect(userRun.id).not.toBe(first.runs[0]?.id);
              expect(
                second.messages.find((m) => m.text === "This answer belongs to the user question.")
                  ?.runId,
              ).toBe(userRun.id);
              expect(f.peer.state.prompts[1]?.frame.message).toBe("Another question");
              yield* f.emit([
                { type: "agent_start" },
                {
                  type: "message_end",
                  message: { role: "custom", customType: "async-result", content: "Job finished" },
                },
                { type: "agent_end", messages: [], yielded: true },
                { type: "session_settled" },
              ]);
              const awake = yield* waitFor(
                (p) =>
                  p.runs.length === 3 &&
                  p.runs[2]?.status === "completed" &&
                  p.turnItems.some(
                    (item) => item.type === "dynamic_tool" && item.title === "Background result",
                  ),
              );
              const marker = awake.turnItems.find(
                (item) => item.type === "dynamic_tool" && item.title === "Background result",
              );
              expect(marker).toMatchObject({
                runId: awake.runs[2]?.id,
                status: "completed",
                output: "Job finished",
              });
              expect(f.peer.state.prompts).toHaveLength(2);
            }),
          );
        }),
      ).pipe(Effect.provide(dependencies)),
  );

  for (const wake of [false, true]) {
    it.live(
      `contains native background Stop ${wake ? "after wake" : "between turns"} without another parent outcome`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.run(({ orchestrator, waitFor, send }) =>
              Effect.gen(function* () {
                yield* send("Keep a child alive");
                yield* waitFor((p) =>
                  p.providerTurns.some((t) => t.nativeAcceptance === "accepted"),
                );
                yield* f.emit([
                  { type: "agent_start" },
                  {
                    type: "subagent_lifecycle",
                    payload: {
                      id: "stop-child",
                      agent: "task",
                      detached: true,
                      status: "started",
                      description: "Wait for evidence",
                    },
                  },
                ]);
                yield* waitFor((p) => p.subagents.length === 1);
                yield* f.finish(false);
                let latest = yield* waitFor((p) => p.runs.some((r) => r.status === "completed"));
                const parent = latest.runs[0]!;
                if (wake) {
                  yield* f.emit([{ type: "agent_start" }]);
                  latest = yield* waitFor(
                    (p) => p.runs.length === 2 && p.runs[1]?.status === "running",
                  );
                }
                yield* orchestrator.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make("background-stop"),
                  threadId: f.threadId,
                  runId: latest.runs.at(-1)!.id,
                  holdQueue: true,
                });
                const stopped = yield* waitFor(
                  (p) =>
                    p.providerSessions.some(
                      (s) => s.status === "stopped" || s.status === "error",
                    ) && p.providerThreads.every((t) => t.pendingBackgroundTasks?.length === 0),
                );
                expect(stopped.runs.find((r) => r.id === parent.id)?.status).toBe("completed");
                expect(stopped.runs.filter((r) => r.status === "interrupted")).toHaveLength(
                  wake ? 1 : 0,
                );
                expect(stopped.subagents[0]?.status).toBe("interrupted");
                expect(f.peer.state.shutdowns).toBe(1);
                expect(f.peer.state.frames.some((frame) => frame.type === "abort")).toBe(false);
                expect(stopped.runs).toHaveLength(wake ? 2 : 1);
              }),
            );
          }),
        ).pipe(Effect.provide(dependencies)),
    );
  }
});
