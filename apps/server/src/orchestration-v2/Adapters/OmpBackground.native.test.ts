import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ThreadManagementServiceShape } from "../ThreadManagementService.ts";
import { EventStoreV2 } from "../EventStore.ts";
import { applyToProjection, emptyProjection } from "../ProjectionStore.ts";
import * as ServerConfig from "../../config.ts";
import { layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { nativeOmpOrchestration as fixture } from "../../provider/testUtils/nativeOmpOrchestration.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  allocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-background-native-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

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

  it.live(
    "retains distinct async results and replay identities in one SQL wake and another wake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.run(({ waitFor, send }) =>
            Effect.gen(function* () {
              const store = yield* EventStoreV2;
              yield* send("Start background jobs");
              yield* waitFor((p) => p.providerTurns.some((t) => t.nativeAcceptance === "accepted"));
              yield* f.emit([{ type: "agent_start" }]);
              yield* f.finish(false);
              const parent = yield* waitFor((p) => p.runs[0]?.status === "completed");
              // The distinguishing job receipts follow a shared prefix longer than diagnostic clipping.
              const prefix = "Background evidence ".repeat(20);
              const first = `${prefix}Job alpha: FIRST RESULT`;
              const second = `${prefix}Job beta: SECOND RESULT`;
              const result = (content: string) => ({
                type: "message_end",
                message: { role: "custom", customType: "async-result", content },
              });
              yield* f.emit([
                { type: "agent_start" },
                result(first),
                result(second),
                result(first),
              ]);
              const awake = yield* waitFor(
                (p) => p.runs.length === 2 && p.runs[1]?.status === "running",
              );
              const wakeId = awake.runs[1]!.id;
              yield* f.emit([{ type: "agent_end", messages: [], yielded: true }]);
              const settled = yield* waitFor((p) => p.runs[1]?.status === "completed");
              const markers = settled.turnItems.filter(
                (item) => item.title === "Background result",
              );
              expect(markers).toHaveLength(2);
              expect(new Set(markers.map((item) => item.id)).size).toBe(2);
              expect(markers.map((item) => item.nativeItemRef)).not.toEqual([null, null]);
              expect(markers).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ runId: wakeId, status: "completed", output: first }),
                  expect.objectContaining({ runId: wakeId, status: "completed", output: second }),
                ]),
              );
              expect(settled.runs[0]?.id).toBe(parent.runs[0]?.id);
              expect(settled.messages.filter((message) => message.role === "assistant")).toEqual(
                [],
              );
              yield* f.emit([
                { type: "agent_start" },
                result("Job gamma: THIRD RESULT"),
                { type: "agent_end", messages: [], yielded: true },
                { type: "session_settled" },
              ]);
              const later = yield* waitFor(
                (p) =>
                  p.runs.length === 3 &&
                  p.runs[2]?.status === "completed" &&
                  p.providerThreads.every((thread) => thread.pendingBackgroundTasks?.length === 0),
              );
              const all = later.turnItems.filter((item) => item.title === "Background result");
              expect(all).toHaveLength(3);
              expect(all.filter((item) => item.runId === wakeId)).toEqual(markers);
              expect(all.find((item) => item.runId === later.runs[2]?.id)).toMatchObject({
                status: "completed",
                output: "Job gamma: THIRD RESULT",
              });
              expect(new Set(all.map((item) => item.id)).size).toBe(3);
              expect(f.peer.state.prompts).toHaveLength(1);
              expect(later.runs.every((run) => run.status === "completed")).toBe(true);
              // Reconstruct from persisted domain events, independently of the live SQL projection.
              const events = yield* store.read({ threadId: f.threadId }).pipe(
                Stream.map((stored) => stored.event),
                Stream.runCollect,
              );
              const created = events.find((event) => event.type === "thread.created");
              if (!created || created.type !== "thread.created")
                return yield* Effect.die("Missing persisted thread");
              const replayed = events.reduce(
                (projection, event) => applyToProjection(projection, event),
                emptyProjection(created),
              );
              expect(
                replayed?.turnItems.filter((item) => item.title === "Background result"),
              ).toEqual(all);
            }),
          );
        }),
      ).pipe(Effect.provide(dependencies)),
  );

  it.live.each(
    [false, true].map((wake) => ({
      caseTitle: `contains native background Stop ${wake ? "after wake" : "between turns"} without another parent outcome`,
      wake,
    })),
  )("$caseTitle", ({ wake }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const delegatedStops: Array<
          Parameters<ThreadManagementServiceShape["stopDelegatedTasks"]>[0]
        > = [];
        const f = yield* fixture({
          threads: {
            stopDelegatedTasks: (input) =>
              Effect.sync(() => {
                delegatedStops.push(input);
              }),
          },
        });
        yield* f.run(({ orchestrator, waitFor, send, completed }) =>
          Effect.gen(function* () {
            yield* send("Keep a child alive");
            yield* waitFor((p) => p.providerTurns.some((t) => t.nativeAcceptance === "accepted"));
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
            // These are native tasks; ThreadManagement stops only app-owned children.
            expect(latest.subagents.every((task) => task.origin === "provider_native")).toBe(true);
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("background-stop"),
              threadId: f.threadId,
              runId: latest.runs.at(-1)!.id,
              holdQueue: true,
            });
            yield* completed(CommandId.make("background-stop"));
            expect(delegatedStops).toEqual([
              {
                threadId: f.threadId,
                commandId: CommandId.make("background-stop"),
                reason: undefined,
              },
            ]);
            const stopped = yield* waitFor(
              (p) =>
                p.providerSessions.some((s) => s.status === "stopped" || s.status === "error") &&
                p.providerThreads.every((t) => t.pendingBackgroundTasks?.length === 0),
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
});
