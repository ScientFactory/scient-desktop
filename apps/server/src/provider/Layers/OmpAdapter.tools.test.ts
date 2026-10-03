// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { projectWorkLog } from "@scientfactory/conversation";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeOmpRpcClient } from "effect-omp-rpc/client";

import { liveActivityToolStatus } from "../../../../../packages/client-runtime/src/work-log/presentation.ts";
import { projectActivityPayload } from "../../orchestration/ActivityPayloadProjection.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { makeOmpScriptedWire } from "../omp/OmpCaptureReplay.testFixtures.ts";
import { ompTarget } from "../omp/OmpTarget.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const encodeEventJson = Schema.encodeUnknownEffect(Schema.fromJsonString(ProviderRuntimeEvent));
const encodeEventsJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProviderRuntimeEvent)),
);
const decodeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);

const toolsHarness = Effect.fn("ompToolsHarness")(function* (
  environment: Readonly<Record<string, string>> = {},
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-tools-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  const wire = yield* makeOmpScriptedWire();
  const adapter = yield* makeOmpAdapter({
    target: ompTarget,
    binaryPath: "omp",
    providerInstanceId: ProviderInstanceId.make("omp"),
    stateDir: root,
    attachmentsDir: root,
    environment,
    eventQueueByteLimit: 64 * 1024,
    makeProcess: () =>
      makeOmpRpcClient(wire.io).pipe(
        Effect.map((client) => ({ ...client, version: "18.3.1", runtimeVersion: "18.3.1" })),
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
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        yield* Queue.take(queue).pipe(Effect.timeout("3 seconds"));
      }
    });
  const threadId = ThreadId.make("omp-tools");
  yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
  const turn = yield* adapter.sendTurn({ threadId, input: "Run tools." });
  yield* wire.send({ type: "agent_start" });
  const items = () =>
    events.filter(
      (event) =>
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "dynamic_tool_call",
    );
  const workLog = () =>
    projectWorkLog(
      events.flatMap((event) => runtimeEventToActivities(event).map(projectActivityPayload)),
    ).entries;
  return { wire, adapter, threadId, turn, events, until, items, workLog };
});

const start = (id: string, name: string, args: unknown) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: name,
  args,
});
const end = (id: string, name: string, result: unknown, isError = false) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: name,
  result,
  isError,
});
const completed = (id: string) => (event: ProviderRuntimeEvent) =>
  event.type === "item.completed" && event.providerRefs?.providerItemId === id;

describe("Oh My Pi ordinary tool activity", () => {
  it.live(
    "preserves interleaved command/file inputs and output through sparse updates and projection",
    () =>
      Effect.gen(function* () {
        const h = yield* toolsHarness();
        yield* h.wire.send(
          start("shell", "bash", { command: "printf synthetic" }),
          start("file", "read", { path: "note.txt" }),
          { type: "tool_stream_update", toolCallId: "shell", update: { text: "first line" } },
          { type: "tool_stream_update", toolCallId: "file", update: { text: "file text" } },
        );
        yield* h.until(
          (event) => event.type === "item.updated" && event.providerRefs?.providerItemId === "file",
        );
        expect(h.workLog()).toMatchObject([
          { title: "bash", command: { text: "printf synthetic" }, output: { text: "first line" } },
          { title: "read", detail: { text: "note.txt" }, output: { text: "file text" } },
        ]);
        yield* h.wire.send(
          end("shell", "bash", { content: [{ type: "text", text: "final line" }] }),
          end("file", "read", {}),
        );
        yield* h.until(completed("file"));
        expect(h.workLog()).toMatchObject([
          {
            title: "bash",
            status: "completed",
            command: { text: "printf synthetic" },
            output: { text: "final line" },
          },
          {
            title: "read",
            status: "completed",
            detail: { text: "note.txt" },
            output: { text: "file text" },
          },
        ]);
        expect(h.items().every((event) => event.turnId === h.turn.turnId)).toBe(true);
        yield* h.adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("labels a row by what the tool acted on, never by the tool's output", () =>
    Effect.gen(function* () {
      const h = yield* toolsHarness();
      const text = (value: string) => ({ content: [{ type: "text", text: value }] });
      yield* h.wire.send(
        start("skills", "scient_skills_list", {}),
        end("skills", "scient_skills_list", text('{"skills":[{"name":"html-pdf-authoring"}]}')),
        start("search", "grep", { pattern: "TODO", path: "src" }),
        end("search", "grep", text("src/app.ts:1: TODO")),
        start("missing", "read", { path: "gone.txt" }),
        end("missing", "read", text("File not found: gone.txt\nChecked the workspace."), true),
      );
      yield* h.until(completed("missing"));
      const finished = (id: string) =>
        h
          .items()
          .find(
            (event) => event.type === "item.completed" && event.providerRefs?.providerItemId === id,
          )?.payload;
      expect(finished("skills")).not.toHaveProperty("detail");
      expect(finished("search")).toMatchObject({ detail: "TODO in src" });
      expect(finished("missing")).toMatchObject({
        status: "failed",
        detail: "File not found: gone.txt",
      });
      expect(h.workLog()).toMatchObject([
        {
          title: "scient_skills_list",
          output: { text: '{"skills":[{"name":"html-pdf-authoring"}]}' },
        },
        { title: "grep", detail: { text: "TODO in src" } },
        { title: "read", status: "failed" },
      ]);
      yield* h.adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const trigger of ["stop", "process-exit"] as const) {
    it.live(
      `terminalizes open ordinary calls before ${trigger} receipts and retains partial output`,
      () =>
        Effect.gen(function* () {
          const h = yield* toolsHarness();
          yield* h.wire.send(start("shell", "bash", { command: "sleep 10" }), {
            type: "tool_stream_update",
            toolCallId: "shell",
            update: { text: "partial text" },
          });
          yield* h.until((event) => event.type === "item.updated");
          if (trigger === "stop") yield* h.adapter.interruptTurn(h.threadId, h.turn.turnId);
          else yield* h.wire.io.close!;
          yield* h.until((event) => event.type === "session.exited");
          const terminal = h.items().filter((event) => event.type === "item.completed");
          expect(terminal).toHaveLength(1);
          expect(terminal[0]?.payload).toMatchObject({
            status: trigger === "stop" ? "stopped" : "failed",
            title: "bash",
          });
          expect(h.events.indexOf(terminal[0]!)).toBeLessThan(
            h.events.findIndex((event) => event.type === "turn.aborted"),
          );
          expect(h.workLog()[0]).toMatchObject({
            status: trigger === "stop" ? "stopped" : "failed",
            command: { text: "sleep 10" },
            output: { text: "partial text" },
          });
          const status =
            terminal[0]?.payload && "status" in terminal[0].payload
              ? terminal[0].payload.status
              : undefined;
          expect(liveActivityToolStatus(status, false)).not.toBe("inProgress");
          yield* decodeEvent(terminal[0]);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live(
    "does not reopen or complete native terminal calls twice, and preserves an actual failure on Stop",
    () =>
      Effect.gen(function* () {
        const h = yield* toolsHarness();
        yield* h.wire.send(
          start("shell", "bash", { command: "false" }),
          end("shell", "bash", { content: [{ type: "text", text: "exit code 1" }] }, true),
        );
        yield* h.until(completed("shell"));
        yield* h.wire.send(
          { type: "tool_stream_update", toolCallId: "shell", update: { text: "late" } },
          start("shell", "bash", { command: "echo late" }),
          end("shell", "bash", {}),
          start("barrier", "read", { path: "barrier.txt" }),
        );
        yield* h.until(
          (event) =>
            event.type === "item.started" && event.providerRefs?.providerItemId === "barrier",
        );
        yield* h.adapter.interruptTurn(h.threadId, h.turn.turnId);
        yield* h.until((event) => event.type === "session.exited");
        expect(
          h.items().filter((event) => event.providerRefs?.providerItemId === "shell"),
        ).toHaveLength(2);
        expect(h.workLog()[0]).toMatchObject({
          status: "failed",
          command: { text: "false" },
          output: { text: "exit code 1" },
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("bounds retained tool output without discarding its command identity", () =>
    Effect.gen(function* () {
      const h = yield* toolsHarness();
      yield* h.wire.send(start("shell", "bash", { command: "printf large" }), {
        type: "tool_execution_update",
        toolCallId: "shell",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "z".repeat(128 * 1024) }] },
      });
      const updated = yield* h.until((event) => event.type === "item.updated");
      const encoded = yield* encodeEventJson(updated);
      expect(Buffer.byteLength(encoded)).toBeLessThan(16 * 1024);
      expect(updated.payload).toMatchObject({
        data: { rawOutput: { truncated: true, originalBytes: 128 * 1024 } },
      });
      expect(h.workLog()[0]).toMatchObject({ title: "bash", command: { text: "printf large" } });
      yield* h.adapter.interruptTurn(h.threadId, h.turn.turnId);
      yield* h.until((event) => event.type === "session.exited");
      expect(h.workLog()[0]).toMatchObject({
        status: "stopped",
        command: { text: "printf large" },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("redacts known credentials before clipping input and output previews", () =>
    Effect.gen(function* () {
      const secret = "opaque-fixture-credential-abcdefghijk";
      const h = yield* toolsHarness({ SYNTHETIC_API_KEY: secret });
      const command =
        "x".repeat(4096 - '{"command":"'.length - secret.length + 1) +
        secret +
        "y".repeat(128 * 1024);
      const output = "z".repeat(4096 - secret.length + 1) + secret + "w".repeat(128 * 1024);
      yield* h.wire.send(start("shell", "bash", { command }), {
        type: "tool_execution_update",
        toolCallId: "shell",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: output }] },
      });
      yield* h.until((event) => event.type === "item.updated");
      const serialized = yield* encodeEventsJson(h.items());
      expect(serialized).not.toContain(secret.slice(0, -1));
      expect(serialized).toContain("[REDACTED]");
      yield* h.adapter.interruptTurn(h.threadId, h.turn.turnId);
      yield* h.until((event) => event.type === "session.exited");
      expect(yield* encodeEventsJson(h.items())).not.toContain(secret.slice(0, -1));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps native identity for a pre-execution stream and adopts its finalized input", () =>
    Effect.gen(function* () {
      const h = yield* toolsHarness();
      yield* h.wire.send({
        type: "tool_stream_update",
        toolCallId: "early",
        toolName: "edit",
        update: { text: "patch preview" },
      });
      const updated = yield* h.until((event) => event.type === "item.updated");
      expect(updated.payload).toMatchObject({ title: "edit" });
      yield* h.wire.send(start("early", "edit", { path: "src/app.ts" }), end("early", "edit", {}));
      yield* h.until(completed("early"));
      expect(h.workLog()).toMatchObject([
        {
          title: "edit",
          status: "completed",
          detail: { text: "src/app.ts" },
          output: { text: "patch preview" },
        },
      ]);
      yield* h.adapter.stopAll();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "settles lost ordinary tools without closing detached subagents or changing later ownership",
    () =>
      Effect.gen(function* () {
        const h = yield* toolsHarness();
        yield* h.wire.send(
          start("same-id", "read", { path: "first.txt" }),
          {
            type: "subagent_lifecycle",
            payload: {
              id: "child",
              agent: "task",
              detached: true,
              status: "started",
              description: "Detached task",
            },
          },
          { type: "agent_end", isTerminal: true, yielded: true, messages: [] },
          {
            type: "prompt_result",
            id: h.wire.written.find((frame) => frame.type === "prompt")?.id,
            agentInvoked: true,
            status: "completed",
            sessionSettled: false,
          },
        );
        yield* h.until(
          (event) => event.type === "turn.completed" && event.turnId === h.turn.turnId,
        );
        expect(h.items().filter((event) => event.type === "item.completed")).toHaveLength(1);
        expect(h.items().at(-1)?.payload).toMatchObject({ status: "failed" });
        expect(
          h.events.some(
            (event) => event.type === "task.completed" && event.payload.taskId === "child",
          ),
        ).toBe(false);
        const later = yield* h.adapter.sendTurn({
          threadId: h.threadId,
          input: "Read another file.",
        });
        yield* h.wire.send(
          { type: "agent_start" },
          start("same-id", "read", { path: "second.txt" }),
          end("same-id", "read", {}),
        );
        yield* h.until((event) => event.type === "item.completed" && event.turnId === later.turnId);
        const terminal = h.items().filter((event) => event.type === "item.completed");
        expect(terminal.map((event) => event.turnId)).toEqual([h.turn.turnId, later.turnId]);
        expect(new Set(terminal.map((event) => event.itemId)).size).toBe(2);
        yield* h.adapter.stopAll();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
