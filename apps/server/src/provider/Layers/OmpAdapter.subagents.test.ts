// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { make as makeLiveness } from "../../orchestration/ThreadBackgroundLiveness.ts";
import { makeOmpRpcClient } from "effect-omp-rpc/client";

import { makeOmpScriptedWire } from "../omp/OmpCaptureReplay.testFixtures.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const lifecycle = (id: string, status: string) => ({
  type: "subagent_lifecycle",
  payload: { id, agent: "task", detached: true, status, description: `Review ${id}` },
});

/**
 * A run that spawns a detached subagent and still ends terminal (OMP 18.3.1
 * ends a run stopped mid-tool-use, or by compaction, with `isTerminal: true`
 * even while background work is pending), so its prompt settles with
 * `sessionSettled: false` and the subagent outlives the turn.
 */
const backgroundTurn = (promptId: string, subagentId: string) => [
  { type: "agent_start" },
  lifecycle(subagentId, "started"),
  { type: "agent_end", messages: [], isTerminal: true, yielded: true },
  {
    type: "prompt_result",
    id: promptId,
    agentInvoked: true,
    status: "completed",
    sessionSettled: false,
  },
];

const tasks = (events: ReadonlyArray<ProviderRuntimeEvent>, type: ProviderRuntimeEvent["type"]) =>
  events.flatMap((event) =>
    event.type === type &&
    event.payload &&
    "taskId" in event.payload &&
    (!("taskType" in event.payload) || event.payload.taskType !== "monitor")
      ? [{ turnId: event.turnId, ...(event.payload as Record<string, unknown>) }]
      : [],
  );

describe("Oh My Pi adapter background subagents", () => {
  it.live("keeps a background subagent open past its turn and closes it on its own end", () =>
    Effect.gen(function* () {
      let prompts = 0;
      const wire = yield* makeOmpScriptedWire(undefined, (command) =>
        command.type === "prompt"
          ? backgroundTurn(String(command.id), prompts++ === 0 ? "bg-1" : "bg-2")
          : [],
      );
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-bg-"));
      const adapter = yield* makeOmpAdapter({
        binaryPath: "omp",
        providerInstanceId: ProviderInstanceId.make("omp"),
        stateDir,
        attachmentsDir: stateDir,
        environment: {},
        makeProcess: () =>
          makeOmpRpcClient(wire.io).pipe(
            Effect.map((client) => ({ ...client, version: "18.3.1" })),
          ),
      });
      const events: Array<ProviderRuntimeEvent> = [];
      const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
        ),
        Effect.forkScoped,
      );
      const until = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
        Effect.gen(function* () {
          while (!events.some(predicate)) {
            yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"));
          }
        });
      const threadId = ThreadId.make("omp-background-subagents");
      yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });

      const first = yield* adapter.sendTurn({ threadId, input: "Delegate a review." });
      yield* until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
      // The turn settled; OMP still runs the subagent.
      expect(tasks(events, "task.started")).toMatchObject([
        { turnId: first.turnId, taskId: "bg-1" },
      ]);
      expect(tasks(events, "task.completed")).toEqual([]);

      // A later turn is open when the first turn's subagent reports and ends.
      const second = yield* adapter.sendTurn({ threadId, input: "Something else." });
      yield* until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
      yield* wire.send(
        {
          type: "subagent_progress",
          payload: { id: "bg-1", progress: { id: "bg-1", status: "running" } },
        },
        lifecycle("bg-1", "completed"),
      );
      yield* until((event) => event.type === "task.completed");
      expect(tasks(events, "task.progress")).toMatchObject([
        { turnId: first.turnId, taskId: "bg-1" },
      ]);
      expect(tasks(events, "task.completed")).toMatchObject([
        { turnId: first.turnId, taskId: "bg-1", status: "completed" },
      ]);

      // OMP settles the session: the second turn's subagent never reported an
      // end, so nothing can still be running it.
      yield* wire.send({ type: "session_settled" });
      yield* until(
        (event) =>
          event.type === "task.completed" &&
          "taskId" in event.payload &&
          event.payload.taskId === "bg-2",
      );
      expect(tasks(events, "task.completed")).toMatchObject([
        { turnId: first.turnId, taskId: "bg-1", status: "completed" },
        { turnId: second.turnId, taskId: "bg-2", status: "stopped" },
      ]);
      yield* adapter.stopAll();
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const continuationHarness = Effect.fn("continuationHarness")(function* (withSubagent: boolean) {
  const wire = yield* makeOmpScriptedWire(undefined, (command) =>
    command.type === "prompt"
      ? backgroundTurn(String(command.id), "child").filter(
          (frame) => withSubagent || frame.type !== "subagent_lifecycle",
        )
      : [],
  );
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-continuation-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true, force: true })),
  );
  let closed = false;
  const adapter = yield* makeOmpAdapter({
    binaryPath: "omp",
    providerInstanceId: ProviderInstanceId.make("omp"),
    stateDir,
    attachmentsDir: stateDir,
    environment: {},
    makeProcess: () =>
      makeOmpRpcClient({
        ...wire.io,
        close: Effect.sync(() => {
          closed = true;
        }).pipe(Effect.andThen(wire.io.close!)),
      }).pipe(Effect.map((client) => ({ ...client, version: "18.3.1" }))),
  });
  const threadId = ThreadId.make("omp-continuation");
  const events: Array<ProviderRuntimeEvent> = [];
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const liveness = makeLiveness();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        if (
          event.type === "task.started" ||
          event.type === "task.completed" ||
          event.type === "task.progress"
        ) {
          liveness.recordTaskLiveness({
            threadId,
            taskId: event.payload.taskId,
            taskType: event.payload.taskType,
            status: "status" in event.payload ? event.payload.status : undefined,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.completed"
                  ? "completed"
                  : "progress",
          });
        }
        if (event.type === "session.exited") liveness.clearThreadLiveness(threadId);
        yield* Queue.offer(queue, event);
      }),
    ),
    Effect.forkScoped,
  );
  const until = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
    Effect.gen(function* () {
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"));
      }
    });
  yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });
  const first = yield* adapter.sendTurn({ threadId, input: "Work in the background" });
  yield* until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
  return {
    adapter,
    threadId,
    first,
    wire,
    events,
    until,
    liveness: () => liveness.getThreadBackgroundLiveness(threadId),
    closed: () => closed,
  };
});

describe("Oh My Pi background continuation and Stop", () => {
  it.live("monitors native pending work, displays its parent continuation, and settles", () =>
    Effect.gen(function* () {
      const h = yield* continuationHarness(false);
      expect(h.liveness()).toBe("monitoring");
      yield* h.wire.send(
        { type: "agent_start" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I have the background result." }],
          },
        },
      );
      const started = yield* h.until(
        (event) => event.type === "turn.started" && event.turnId !== h.first.turnId,
      );
      yield* h.until((event) => event.type === "content.delta");
      expect((yield* h.adapter.listSessions())[0]?.activeTurnId).toBe(started.turnId);
      const steer = yield* h.adapter.sendTurn({ threadId: h.threadId, input: "Include a summary" });
      expect(steer.turnId).toBe(started.turnId);
      expect(h.wire.written.at(-1)?.type).toBe("steer");
      yield* h.wire.send({ type: "agent_end", messages: [] }, { type: "session_settled" });
      yield* h.until((event) => event.type === "turn.completed" && event.turnId === started.turnId);
      yield* h.until(
        (event) => event.type === "task.completed" && event.payload.taskType === "monitor",
      );
      expect(h.liveness()).toBe(null);
      expect(h.events.filter((event) => event.type === "turn.started")).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const wake of [false, true]) {
    it.live(`Stop closes background work ${wake ? "after wake-up" : "between turns"}`, () =>
      Effect.gen(function* () {
        const h = yield* continuationHarness(true);
        expect(h.liveness()).toBe("working");
        if (wake) {
          yield* h.wire.send({ type: "agent_start" });
          yield* h.until(
            (event) => event.type === "turn.started" && event.turnId !== h.first.turnId,
          );
        }
        yield* h.adapter.interruptTurn(h.threadId, undefined);
        yield* h.until((event) => event.type === "session.exited");
        expect(h.closed()).toBe(true);
        expect(h.liveness()).toBe(null);
        expect(yield* h.adapter.hasSession(h.threadId)).toBe(false);
        expect(tasks(h.events, "task.completed")).toMatchObject([
          { taskId: "child", status: "stopped" },
        ]);
        expect(h.events.filter((event) => event.type === "turn.aborted")).toHaveLength(
          wake ? 1 : 0,
        );
        expect(h.wire.written.some((command) => command.type === "abort")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
