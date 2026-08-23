// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Real timers coordinate native child-process exits.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ANTIGRAVITY_SCIENT_HOST_CONTEXT, makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/agy-stream-mock.ts");
const instanceId = ProviderInstanceId.make("antigravity");
const decodeResumeConversationId = Schema.decodeUnknownSync(
  Schema.Struct({ schemaVersion: Schema.Number, conversationId: Schema.String }),
);

function makeMockBinary() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-agy-adapter-"));
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

it.layer(TestLayer)("AntigravityAdapter", (it) => {
  it.effect("labels concise Scient host context and sends it only on the first turn", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { instanceId },
      );
      const threadId = ThreadId.make("agy-adapter-host-context");
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "ECHO_PROMPT" });
      const second = yield* adapter.sendTurn({ threadId, input: "ECHO_PROMPT" });
      const responseForTurn = (turnId: typeof first.turnId) =>
        events
          .flatMap((event) =>
            event.type === "content.delta" && event.turnId === turnId ? [event.payload.delta] : [],
          )
          .join("");

      const firstPrompt = responseForTurn(first.turnId);
      assert.ok(firstPrompt.startsWith(ANTIGRAVITY_SCIENT_HOST_CONTEXT.trim()));
      assert.include(firstPrompt, "coding, academic, and scientific work");
      assert.include(firstPrompt, "Use only capabilities and tools actually available");
      assert.include(firstPrompt, "files created in the workspace remain visible and editable");
      assert.include(firstPrompt, "Do not mention this host context unless it is relevant");
      assert.include(firstPrompt, "[User request]\n\nECHO_PROMPT");
      assert.notInclude(firstPrompt, "Scient rich chat presentation");
      assert.strictEqual(responseForTurn(second.turnId), "ECHO_PROMPT");
    }),
  );

  it.effect("streams canonical events and preserves one native conversation across turns", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { instanceId },
      );
      const threadId = ThreadId.make("agy-adapter-stream");
      const modelSelection = createModelSelection(instanceId, "gemini-3.7-flash", [
        { id: "reasoning", value: "high" },
      ]);
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("antigravity"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection,
      });
      const first = yield* adapter.sendTurn({ threadId, input: "TOOL one", modelSelection });
      const second = yield* adapter.sendTurn({ threadId, input: "two", modelSelection });

      assert.strictEqual(session.status, "ready");
      assert.deepStrictEqual(first.resumeCursor, second.resumeCursor);
      assert.ok(events.some((event) => event.type === "item.started"));
      assert.ok(events.some((event) => event.type === "item.completed"));
      assert.ok(events.some((event) => event.type === "content.delta"));
      assert.strictEqual(events.filter((event) => event.type === "turn.completed").length, 2);
      assert.ok(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta)
          .join("")
          .includes("turn-2:two"),
      );
    }),
  );

  it.effect("cancels a hung turn once and restarts the native process for the next turn", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { instanceId },
      );
      const threadId = ThreadId.make("agy-adapter-cancel");
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const pending = yield* adapter.sendTurn({ threadId, input: "HANG" }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(pending);
      const recovered = yield* adapter.sendTurn({ threadId, input: "after cancel" });

      assert.ok(recovered.resumeCursor);
      assert.strictEqual(
        events.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
        ).length,
        1,
      );
      assert.strictEqual(
        events.filter(
          (event) =>
            event.type === "runtime.warning" && event.payload.message.includes("unexpectedly"),
        ).length,
        0,
      );
    }),
  );

  it.effect("recovers a provider process that exits while idle", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { instanceId },
      );
      const threadId = ThreadId.make("agy-adapter-idle-exit");
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const beforeCrash = yield* adapter.sendTurn({ threadId, input: "CRASH_AFTER" });
      yield* waitReal(100);
      const afterCrash = yield* adapter.sendTurn({ threadId, input: "after idle crash" });

      assert.deepStrictEqual(beforeCrash.resumeCursor, afterCrash.resumeCursor);
      assert.strictEqual(
        events.filter(
          (event) =>
            event.type === "runtime.warning" && event.payload.message.includes("will restart"),
        ).length,
        1,
      );
      assert.strictEqual(
        events.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ).length,
        2,
      );
    }),
  );

  it.effect("stages attachments privately and removes them with the session", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "scient-agy-attachment-source-"),
      );
      const attachmentId = "thread-123e4567-e89b-12d3-a456-426614174000";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "image-bytes");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(mock.directory, { recursive: true, force: true });
          NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
        }),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { attachmentsDir, instanceId },
      );
      const threadId = ThreadId.make("agy-adapter-attachments");
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Inspect the attachment.",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "result.png",
            mimeType: "image/png",
            sizeBytes: 11,
          },
        ],
      });

      const response = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta)
        .join("");
      const stagedPath = response.match(/available at: ([^\]]+)\]/u)?.[1];
      assert.ok(stagedPath);
      assert.ok(stagedPath.includes("scient-antigravity-attachments-"));
      assert.strictEqual(NodeFS.readFileSync(stagedPath, "utf8"), "image-bytes");

      yield* adapter.stopSession(threadId);
      assert.strictEqual(NodeFS.existsSync(stagedPath), false);
      assert.strictEqual(
        NodeFS.existsSync(NodePath.join(attachmentsDir, `${attachmentId}.png`)),
        true,
      );
    }),
  );

  it.effect("keeps concurrent native sessions isolated under repeated turns", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { instanceId },
      );
      const threadIds = Array.from({ length: 8 }, (_, index) =>
        ThreadId.make(`agy-adapter-stress-${index}`),
      );

      const cursors = yield* Effect.forEach(
        threadIds,
        (threadId) =>
          Effect.gen(function* () {
            yield* adapter.startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
            });
            let resumeCursor: unknown;
            for (let turn = 0; turn < 25; turn += 1) {
              const result = yield* adapter.sendTurn({
                threadId,
                input: `session-${threadId}-${turn}`,
              });
              assert.ok(result.resumeCursor);
              resumeCursor = result.resumeCursor;
            }
            const snapshot = yield* adapter.readThread(threadId);
            assert.strictEqual(snapshot.turns.length, 25);
            return decodeResumeConversationId(resumeCursor).conversationId;
          }),
        { concurrency: "unbounded" },
      );

      assert.strictEqual((yield* adapter.listSessions()).length, threadIds.length);
      assert.strictEqual(new Set(cursors).size, threadIds.length);
      yield* adapter.stopAll();
      assert.strictEqual((yield* adapter.listSessions()).length, 0);
    }),
  );

  it.effect("surfaces failed native results honestly while keeping the session usable", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { instanceId },
      );
      const threadId = ThreadId.make("agy-adapter-failure");
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "FAIL" });
      yield* adapter.sendTurn({ threadId, input: "recovered" });

      assert.ok(
        events.some((event) => event.type === "turn.completed" && event.payload.state === "failed"),
      );
      assert.ok(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
      );
      assert.ok(events.some((event) => event.type === "runtime.error"));
    }),
  );

  it.effect("rejects fake interactive requests and rollback instead of claiming support", () =>
    Effect.gen(function* () {
      const mock = makeMockBinary();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(mock.directory, { recursive: true, force: true })),
      );
      const adapter = yield* makeAntigravityAdapter(
        decodeSettings({ binaryPath: mock.binaryPath }),
        { instanceId },
      );
      const threadId = ThreadId.make("agy-adapter-unsupported");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const rollback = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
      assert.strictEqual(rollback._tag, "ProviderAdapterRequestError");
    }),
  );
});
