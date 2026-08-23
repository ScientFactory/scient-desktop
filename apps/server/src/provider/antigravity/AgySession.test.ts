// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Real timers coordinate native child-process exits.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  buildAgySessionArgs,
  decodeAgyOutputLine,
  makeAgySession,
  type AgySessionEvent,
} from "./AgySession.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/agy-stream-mock.ts");

function makeMockBinary(): { readonly directory: string; readonly binaryPath: string } {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-agy-stream-"));
  const binaryPath = NodePath.join(directory, "agy");
  NodeFS.writeFileSync(
    binaryPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockPath)} "$@"\n`,
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return { directory, binaryPath };
}

const TestLayer = Layer.mergeAll(NodeServices.layer);
const waitReal = (milliseconds: number) =>
  Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, milliseconds)));

it("builds the documented persistent stream-json command", () => {
  assert.deepStrictEqual(
    buildAgySessionArgs({
      binaryPath: "agy",
      cwd: "/repo",
      environment: {},
      addDirs: ["/attachments", "/repo"],
      model: "gemini-3.7-flash",
      effort: "medium",
      conversationId: "conversation-1",
      runtimeMode: "full-access",
      jsonSchema: '{"type":"object"}',
    }),
    [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "5m",
      "--disable-slash-commands",
      "--add-dir",
      "/repo",
      "--add-dir",
      "/attachments",
      "--model",
      "gemini-3.7-flash",
      "--effort",
      "medium",
      "--conversation",
      "conversation-1",
      "--json-schema",
      '{"type":"object"}',
      "--dangerously-skip-permissions",
    ],
  );
});

it("decodes the official nested event envelope and rejects malformed known events", () => {
  const decoded = decodeAgyOutputLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "c1",
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "hello",
      },
    }),
  );
  assert.strictEqual(decoded._tag, "Known");
  assert.strictEqual(decodeAgyOutputLine('{"event":"result"}')._tag, "Invalid");
  assert.strictEqual(decodeAgyOutputLine('{"event":"future_event","data":1}')._tag, "Unknown");
  assert.strictEqual(decodeAgyOutputLine("not-json")._tag, "Invalid");
});

it.layer(TestLayer)("AgySession", (it) => {
  it.effect("keeps one child warm across turns and forwards true deltas and tools", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const session = yield* makeAgySession({
        binaryPath: mock.binaryPath,
        cwd: process.cwd(),
        environment: process.env,
      });
      const events: AgySessionEvent[] = [];
      const first = yield* session.prompt({
        text: "TOOL one",
        onEvent: (event) => Effect.sync(() => events.push(event)),
      });
      const second = yield* session.prompt({ text: "two" });

      assert.strictEqual(first.status, "success");
      assert.strictEqual(first.response, "turn-1:TOOL one");
      assert.strictEqual(second.response, "turn-2:two");
      assert.strictEqual(first.conversationId, second.conversationId);
      assert.deepStrictEqual(
        events.filter((event) => event._tag === "AssistantText").map((event) => event.text),
        ["turn-", "1:TOOL one"],
      );
      assert.strictEqual(events.filter((event) => event._tag === "ToolCall").length, 1);
      assert.strictEqual(events.filter((event) => event._tag === "ToolCallUpdate").length, 1);
      yield* session.close;
    }),
  );

  it.effect("reports provider failures without killing a healthy persistent session", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const session = yield* makeAgySession({
        binaryPath: mock.binaryPath,
        cwd: process.cwd(),
        environment: process.env,
      });
      const failed = yield* session.prompt({ text: "FAIL" });
      const recovered = yield* session.prompt({ text: "after" });
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.error, "mock turn failure");
      assert.strictEqual(recovered.status, "success");
    }),
  );

  it.effect("surfaces native subagent steps as observable dynamic work", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const session = yield* makeAgySession({
        binaryPath: mock.binaryPath,
        cwd: process.cwd(),
        environment: process.env,
      });
      const events: AgySessionEvent[] = [];
      yield* session.prompt({
        text: "SUBAGENT",
        onEvent: (event) => Effect.sync(() => events.push(event)),
      });

      const started = events.find((event) => event._tag === "ToolCall");
      const completed = events.find((event) => event._tag === "ToolCallUpdate");
      assert.strictEqual(started?._tag === "ToolCall" ? started.name : undefined, "subagent");
      assert.strictEqual(
        completed?._tag === "ToolCallUpdate" ? completed.status : undefined,
        "completed",
      );
    }),
  );

  it.effect("rejects concurrent turns and cancels a hung process deterministically", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const unexpectedExits = yield* Ref.make(0);
      const session = yield* makeAgySession({
        binaryPath: mock.binaryPath,
        cwd: process.cwd(),
        environment: process.env,
        onUnexpectedExit: () => Ref.update(unexpectedExits, (count) => count + 1),
      });
      const hung = yield* session.prompt({ text: "HANG" }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const concurrent = yield* Effect.flip(session.prompt({ text: "second" }));
      assert.strictEqual(concurrent.stage, "concurrent");
      yield* session.cancel;
      const cancelled = yield* Fiber.join(hung);
      assert.strictEqual(cancelled.status, "cancelled");
      yield* waitReal(50);
      assert.strictEqual(yield* Ref.get(unexpectedExits), 0);
      const closed = yield* Effect.flip(session.prompt({ text: "after cancellation" }));
      assert.strictEqual(closed.stage, "closed");
    }),
  );

  it.effect("turns malformed protocol output and unexpected exits into typed failures", () =>
    Effect.gen(function* () {
      const malformedMock = makeMockBinary();
      const exitMock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(malformedMock.directory, { recursive: true, force: true });
          NodeFS.rmSync(exitMock.directory, { recursive: true, force: true });
        }),
      );
      const malformedSession = yield* makeAgySession({
        binaryPath: malformedMock.binaryPath,
        cwd: process.cwd(),
        environment: process.env,
      });
      const malformed = yield* Effect.flip(malformedSession.prompt({ text: "MALFORMED" }));
      assert.strictEqual(malformed.stage, "protocol");

      const exitSession = yield* makeAgySession({
        binaryPath: exitMock.binaryPath,
        cwd: process.cwd(),
        environment: process.env,
      });
      const exited = yield* Effect.flip(exitSession.prompt({ text: "EXIT" }));
      assert.strictEqual(exited.stage, "process");
      assert.match(exited.detail, /mock process failure/);
    }),
  );
});
