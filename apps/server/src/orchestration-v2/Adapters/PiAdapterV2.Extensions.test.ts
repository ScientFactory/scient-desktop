import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { PI_PROVIDER } from "@t3tools/provider-pi/testing";
import { makePiRpcConnection, PiRpcError, type PiRpcRecord } from "@t3tools/provider-pi/testing";
import {
  testLayer,
  PI_INSTANCE_ID,
  THREAD_ID,
  SESSION_ID,
  FAKE_SESSION_FILE,
  runtimePolicy,
  modelSelection,
  makeFakePi,
  openRuntime,
  startTurn,
} from "./PiAdapterV2.fixture.ts";

describe("PiAdapterV2", () => {
  it.effect.each(
    [false, true].map((failedEdit) => ({
      caseTitle: `preserves native built-in tool details and identity, failed edit=${failedEdit}`,
      failedEdit,
    })),
  )("$caseTitle", ({ failedEdit }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      const command = "git status --short";
      const output = " M src/app.ts";
      for (const event of [
        {
          type: "tool_execution_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command },
        },
        {
          type: "tool_execution_update",
          toolCallId: "bash-1",
          toolName: "bash",
          partialResult: { content: [{ type: "text", text: output }] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "bash-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: output }], details: { exitCode: 0 } },
          isError: false,
        },
        {
          type: "tool_execution_start",
          toolCallId: "edit-1",
          toolName: "edit",
          args: { path: "src/app.ts", oldText: "old", newText: "new" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "edit-1",
          toolName: "edit",
          partialResult: { content: [{ type: "text", text: "Editing src/app.ts" }] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "edit-1",
          toolName: "edit",
          result: {
            content: [{ type: "text", text: failedEdit ? "Edit refused" : "Edited src/app.ts" }],
            details: failedEdit ? {} : { diff: "-old\n+new" },
          },
          isError: failedEdit,
        },
      ])
        yield* fake.emit(event);
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      const commands = observed.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
          ? [event.turnItem]
          : [],
      );
      const edits = observed.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "file_change"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(commands, 3);
      assert.lengthOf(edits, 3);
      for (const items of [commands, edits]) {
        assert.equal(new Set(items.map((item) => item.id)).size, 1);
        assert.equal(new Set(items.map((item) => item.ordinal)).size, 1);
        assert.deepEqual(
          items.map((item) => item.status),
          ["running", "running", items === edits && failedEdit ? "failed" : "completed"],
        );
      }
      assert.isTrue(commands.every((item) => item.input === command));
      assert.equal(commands[1]?.output, output);
      assert.equal(commands[2]?.output, output);
      assert.equal(commands[2]?.exitCode, 0);
      assert.isTrue(edits.every((item) => item.fileName === "src/app.ts"));
      assert.isTrue(edits.every((item) => item.oldStr === "old" && item.newStr === "new"));
      assert.deepEqual(edits[2]?.changes, [{ operation: "edit", path: "src/app.ts" }]);
      assert.equal(edits[2]?.diffStr, failedEdit ? "Edit refused" : "-old\n+new");
      assert.lengthOf(
        observed.filter((event) => event.type === "turn.terminal"),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("delivers core awareness through the native extension without a grant", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      const spawn = fake.lastSpawn();
      assert.equal(spawn.env.PI_RUNTIME_GUIDANCE, buildScientAwareness());
      assert.isUndefined(spawn.env.T3_MCP_URL);
      assert.isTrue(spawn.args.includes("--extension"));
      assert.isTrue(spawn.args.some((arg) => arg.endsWith("pi-t3-mcp-extension.ts")));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("injects the T3 MCP extension and bearer when a session exists", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-pi-mcp"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-session-pi",
        providerInstanceId: PI_INSTANCE_ID,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-pi-token",
        capabilities: new Set(["preview"] as const),
      });
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      const spawn = fake.lastSpawn();
      assert.isTrue(spawn.args.includes("--extension"));
      const extensions = spawn.args.flatMap((arg, index) =>
        arg === "--extension" ? [spawn.args[index + 1]] : [],
      );
      assert.isFalse(spawn.args.includes("--no-extensions"));
      assert.isTrue(extensions.some((path) => path?.endsWith("pi-t3-mcp-extension.ts")));
      assert.equal(spawn.env.T3_MCP_URL, "http://127.0.0.1:43123/mcp");
      assert.equal(spawn.env.T3_MCP_BEARER_TOKEN, "secret-pi-token");
      assert.equal(spawn.env.T3_PI_RUNTIME_MODE, "full-access");
      assert.equal(spawn.env.PI_RUNTIME_GUIDANCE, buildScientAwareness(new Set(["preview"])));
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID))),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );

  it.effect.each(
    [false, true].map((historical) => ({
      caseTitle: `natively forks ${historical ? "a historical turn" : "the latest turn"} into an independent session`,
      historical,
    })),
  )("$caseTitle", ({ historical }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const forkFile = "/fake/forked.jsonl";
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        forkFake,
      );
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId: `u${ordinal}`, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      forkFake.queueState({ sessionFile: forkFile });
      fake.queueState({ sessionFile: forkFile });
      const target = ThreadId.make("fork-target");
      const forked = yield* runtime.forkThread({
        sourceProviderThread: source,
        sourceProviderTurns: historical ? [turn(1), turn(2)] : [turn(1)],
        providerTurnId: turn(1).id,
        targetThreadId: target,
      });
      assert.equal(forked.appThreadId, target);
      assert.equal(forked.nativeThreadRef?.nativeId, forkFile);
      assert.notEqual(forked.id, source.id);
      assert.equal(source.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      const args = forkFake.lastSpawn().args;
      assert.equal(args[args.indexOf("--fork") + 1], FAKE_SESSION_FILE);
      assert.include(args, "--no-extensions");
      assert.include(args, "--no-tools");
      assert.notInclude(args, "--no-session");
      assert.deepEqual(
        forkFake
          .allRequests()
          .filter((request) => request.type === "fork")
          .map((request) => request.entryId),
        historical ? ["u2"] : [],
      );
      assert.isFalse(
        fake.allRequests().some((request) => request.type === "fork" || request.type === "clone"),
      );
      // ProviderTurnStartService adopts the fork into its pending row.
      const adopted = { ...forked, id: ProviderThreadId.make("pending-fork-row") };
      yield* startTurn(runtime, adopted, "default", [], "Continue", undefined, 1, target);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const updated = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" && event.providerThread.appThreadId === target,
      );
      assert.isTrue(
        updated.type === "provider_thread.updated" && updated.providerThread.id === adopted.id,
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
      yield* runtime.resumeThread({ providerThread: adopted });
      assert.equal(
        fake.allRequests().findLast((request) => request.type === "switch_session")?.sessionPath,
        forkFile,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("observes official subagent results without inventing child threads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_sub",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stderr: "",
                sessionFile: "/ignored/custom-extension-session.jsonl",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "scanning files" }] },
                ],
              },
            ],
          },
        },
      });
      const running = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      assert.isTrue(
        running.type === "subagent.updated" &&
          running.subagent.title === "scout" &&
          running.subagent.prompt === "map the repo" &&
          running.subagent.progress === "scanning files" &&
          running.subagent.childThreadId === null,
      );

      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sub",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stopReason: "stop",
                stderr: "",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "repo has one file" }] },
                ],
              },
            ],
          },
        },
      });
      const doneCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isTrue(
        doneCard.type === "subagent.updated" &&
          doneCard.subagent.result === "repo has one file" &&
          doneCard.subagent.childThreadId === null,
      );
      const subagentItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        subagentItem.type === "turn_item.updated" &&
          subagentItem.turnItem.type === "subagent" &&
          subagentItem.turnItem.childThreadId === null,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("emits session-start dialogs before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Project-trust style prompt before any turn exists.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({ requestId: requestId!, decision: "accept" });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    (["answer-first", "timeout-first", "same-tick", "close", "write-failure"] as const).map(
      (timing) => ({ caseTitle: `resolves a native Pi question exactly once (${timing})`, timing }),
    ),
  )("$caseTitle", ({ timing }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      let failResponse = timing === "write-failure";
      const attemptedResponses: PiRpcRecord[] = [];
      const makeConnection: typeof makePiRpcConnection = (input) =>
        makePiRpcConnection(input).pipe(
          Effect.map((connection) => ({
            ...connection,
            send: (record) => {
              if (record.type === "extension_ui_response") attemptedResponses.push(record);
              if (record.type === "extension_ui_response" && failResponse) {
                failResponse = false;
                return Effect.fail(
                  new PiRpcError({ operation: "stdin write", detail: "fixture rejection" }),
                );
              }
              return connection.send(record);
            },
          })),
        );
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const { runtime, takeEvent, observed } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        makeConnection,
      ).pipe(Effect.provideService(Scope.Scope, scope));
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "expiring",
        method: "confirm",
        title: "Proceed?",
        timeout: 100,
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return;
      const answer = runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      if (timing === "answer-first") {
        yield* answer;
        yield* TestClock.adjust("101 millis");
      } else if (timing === "same-tick") {
        yield* Effect.all([answer.pipe(Effect.result), TestClock.adjust("100 millis")], {
          concurrency: "unbounded",
        });
      } else if (timing === "write-failure") {
        assert.equal((yield* answer.pipe(Effect.result))._tag, "Failure");
        yield* TestClock.adjust("101 millis");
      } else if (timing === "close") {
        yield* Scope.close(scope, Exit.void);
        yield* TestClock.adjust("101 millis");
      } else {
        yield* TestClock.adjust("101 millis");
      }
      assert.equal((yield* answer.pipe(Effect.result))._tag, "Failure");
      const responses = fake
        .allRequests()
        .filter((record) => record.type === "extension_ui_response");
      if (timing === "close") {
        // Scope closure has already stopped the native stdin writer. The
        // request is cancelled once locally and can never be answered later.
        assert.equal(attemptedResponses.length, 1);
        assert.equal(attemptedResponses[0]?.cancelled, true);
        assert.equal(responses.length, 0);
      } else {
        assert.equal(responses.length, 1);
        assert.equal(responses[0]?.id, "expiring");
      }
      if (timing === "answer-first") assert.equal(responses[0]?.confirmed, true);
      if (timing === "timeout-first" || timing === "write-failure")
        assert.equal(responses[0]?.cancelled, true);
      if (timing !== "close")
        assert.equal(
          observed.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status !== "pending",
          ).length,
          1,
        );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("answers native Pi UI while initial prompt acceptance waits", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "preflight",
        method: "confirm",
        title: "Approve command",
        message: "Run the command?",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return;
      for (const invalid of [false, 12, {}, [], [12], "   ", "anything", ["true", "false"]]) {
        assert.equal(
          (yield* runtime
            .respondToRuntimeRequest({
              requestId: pending.runtimeRequest.id,
              answers: { preflight: invalid },
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }
      assert.equal(
        fake.allRequests().filter((record) => record.type === "extension_ui_response").length,
        0,
      );
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response")).confirmed, true);
      assert.isFalse(
        observed.some(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.acceptedAt !== undefined,
        ),
      );
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      assert.equal(
        (yield* takeEvent((event) => event.type === "turn.terminal")).type,
        "turn.terminal",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("remembers session approvals only for identical confirmation content", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Project-trust style prompt before any turn exists.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({
        requestId: requestId!,
        decision: "acceptForSession",
      });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust-again",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response"))["id"], "ui-trust-again");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-other",
        method: "confirm",
        title: "Run project extensions?",
        message: "A different project.",
      });
      const other = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.isTrue(
        other.type === "runtime_request.updated" &&
          other.runtimeRequest.nativeRequestRef?.nativeId === "ui-other",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("offers an explicit empty value for extension input dialogs", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-input",
        method: "input",
        title: "Optional value",
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      assert.isTrue(
        event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request")
        return;
      assert.equal(event.turnItem.questions[0]?.options[0]?.value, "");
      yield* runtime.respondToRuntimeRequest({
        requestId: event.turnItem.requestId,
        answers: { "ui-input": "" },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["value"], "");
      assert.isUndefined(response["cancelled"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("raises bridge edit confirmations as file-change approvals", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      for (const [id, title, requestKind] of [
        ["ui-edit", "Allow edit?", "file-change"],
        ["ui-bash", "Allow bash?", "command"],
        ["ui-ext", "Deploy to staging?", "command"],
      ] as const) {
        yield* fake.emit({ type: "extension_ui_request", id, method: "confirm", title });
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.isTrue(
          item.type === "turn_item.updated" &&
            item.turnItem.type === "approval_request" &&
            item.turnItem.requestKind === requestKind,
          `${title} should be ${requestKind}`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
