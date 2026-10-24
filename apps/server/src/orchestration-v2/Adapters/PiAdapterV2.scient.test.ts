// Scient's PiAdapterV2 cases, run through the Scient composition (makeScientPiAdapterV2).
// Upstream behavior of the shared Pi adapter is tested in packages/provider-pi/src/server/adapter.test.ts.
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { type ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { ProviderContinuationRequests } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { piContextErrorMessage } from "@t3tools/provider-pi/server/contextError";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piContinuationRequestsIfProvided,
  PiRpcError,
  type PiRpcRecord,
} from "@t3tools/provider-pi/testing";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../../config.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { makePiCustomModelsConnectionFactory } from "../../provider/pi/PiCustomModelsConnection.ts";
import { encodePiModelSlug } from "../../provider/pi/PiModel.ts";
import {
  expectModelFailure,
  FAKE_SESSION_FILE,
  isNativeStartReceiptError,
  makeAdapter,
  makeFakePi,
  modelSelection,
  openRuntime,
  PI_INSTANCE_ID,
  recordedIdleState,
  runtimePolicy,
  SESSION_ID,
  startTurn,
  testLayer,
  THREAD_ID,
} from "./PiAdapterV2.fixture.ts";

describe("Pi captured work admission fences", () => {
  it.effect("propagates permanent native owner refusal without a producer-local retry", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const offered = yield* Queue.unbounded<ProviderContinuationRequest>();
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        {
          offer: (packet) => Queue.offer(offered, packet).pipe(Effect.asVoid),
        },
      );
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ model: { provider: "fixture", id: "synthetic" } });
      yield* fake.emit({ type: "agent_start" });
      const packet = yield* Queue.take(offered);
      const refusal = {
        _tag: "OrchestratorDispatchError",
        cause: "Provider-initiated work no longer owns an idle native thread.",
      };
      assert.strictEqual(
        yield* packet.dispatchIfCurrent!(Effect.fail(refusal)).pipe(Effect.flip),
        refusal,
      );
      yield* TestClock.adjust(Duration.millis(500));
      assert.equal(yield* Queue.size(offered), 0);
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      yield* packet.clearIfCurrent!();
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      assert.isTrue(
        Option.isNone(yield* packet.dispatchIfCurrent!(Effect.die("stale dispatch ran"))),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("checks exact Stop after selection and before native prompt wire", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, observed } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      let checks = 0;
      const cancelled = yield* startTurn(
        runtime,
        thread,
        "default",
        [],
        "Cancelled before wire",
        undefined,
        1,
        THREAD_ID,
        {
          shouldStartProviderTurn: () =>
            Effect.sync(() => {
              checks++;
              return false;
            }),
        },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(cancelled));
      if (Exit.isFailure(cancelled)) assert.isTrue(Cause.hasInterruptsOnly(cancelled.cause));
      assert.equal(checks, 1);
      assert.lengthOf(
        fake.allRequests().filter((r) => r.type === "prompt"),
        0,
      );
      assert.lengthOf(
        observed.filter((e) => e.type === "provider_turn.updated" || e.type === "turn.terminal"),
        0,
      );
      yield* startTurn(runtime, thread, "default", [], "Next owned turn", undefined, 2);
      yield* fake.takeRequest("prompt");
      assert.lengthOf(
        fake.allRequests().filter((r) => r.type === "prompt"),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    [false, true].map((stopped) => ({
      caseTitle: `adopts only the exact captured native generation and fences Stop (${stopped})`,
      stopped,
    })),
  )("$caseTitle", ({ stopped }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const offered = yield* Queue.unbounded<ProviderContinuationRequest>();
      const { runtime, observed, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        { offer: (r) => Queue.offer(offered, r).pipe(Effect.asVoid) },
      );
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ model: { provider: "fixture", id: "synthetic" } });
      yield* fake.emit({ type: "agent_start" });
      const packet = yield* Queue.take(offered);
      const captured = packet.initiated!;
      assert.equal(runtime.providerSession.model, captured.modelSelection.model);
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      const notification = {
        source: {
          kind: "provider_work" as const,
          workId: captured.workId,
          providerSessionId: captured.providerSessionId,
          providerThreadId: packet.providerThreadId,
          modelSelection: captured.modelSelection,
          runtimePolicy: captured.runtimePolicy,
        },
        outcome: "updated" as const,
        summary: "Pi native work",
      };
      const overrides = {
        modelSelection: captured.modelSelection,
        runtimePolicy: captured.runtimePolicy,
        message: {
          messageId: MessageId.make("native-generation"),
          text: "Adopt existing native work",
          attachments: [],
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          notification,
        },
      };
      const mismatch = yield* startTurn(
        runtime,
        thread,
        "default",
        [],
        "",
        undefined,
        1,
        THREAD_ID,
        { ...overrides, runtimePolicy: { ...captured.runtimePolicy, cwd: "/another-workspace" } },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(mismatch));
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      const adopted = yield* startTurn(
        runtime,
        thread,
        "default",
        [],
        "",
        undefined,
        1,
        THREAD_ID,
        { ...overrides, shouldStartProviderTurn: () => Effect.succeed(!stopped) },
      ).pipe(Effect.exit);
      assert.equal(Exit.isFailure(adopted), stopped);
      assert.lengthOf(
        fake.allRequests().filter((r) => r.type === "prompt"),
        0,
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      if (stopped) {
        assert.lengthOf(
          observed.filter((e) => e.type === "provider_turn.updated" || e.type === "turn.terminal"),
          0,
        );
        assert.isTrue(Option.isNone(yield* packet.dispatchIfCurrent!(Effect.succeed("stale"))));
      } else {
        const receipt = yield* takeEvent(
          (e) =>
            e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
        );
        assert.equal(receipt.type, "provider_turn.updated");
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
        assert.equal(terminal.type === "turn.terminal" ? terminal.status : undefined, "completed");
        assert.lengthOf(
          observed.filter((e) => e.type === "turn.terminal"),
          1,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

it.effect("refuses an ordinary prompt when native work races its correlated preparation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const offered = yield* Queue.unbounded<ProviderContinuationRequest>();
    let selectionStarted = false;
    let held = false;
    const { runtime } = yield* openRuntime(
      fake,
      "default",
      THREAD_ID,
      SESSION_ID,
      undefined,
      (input) =>
        makePiRpcConnection(input).pipe(
          Effect.map((connection) => ({
            ...connection,
            request: (record, timeout) =>
              connection.request(record, timeout).pipe(
                Effect.tap(() => {
                  if (record.type === "set_model") selectionStarted = true;
                  if (record.type !== "get_state" || !selectionStarted || held) return Effect.void;
                  held = true;
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  );
                }),
              ),
          })),
        ),
      { offer: (packet) => Queue.offer(offered, packet).pipe(Effect.asVoid) },
    );
    const thread = yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: modelSelection("default"),
      runtimePolicy,
    });
    const preparing = yield* startTurn(runtime, thread, "fixture/synthetic").pipe(
      Effect.exit,
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* fake.emit({ type: "agent_start" });
    const packet = yield* Queue.take(offered);
    assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(preparing)));
    assert.lengthOf(
      fake.allRequests().filter((r) => r.type === "prompt"),
      0,
    );
    assert.isTrue(Option.isNone(yield* packet.dispatchIfCurrent!(Effect.succeed("stale"))));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(
  (["unknown-model", "state-query", "relative-cwd"] as const).map((failure) => ({
    caseTitle: `refuses and releases unowned native work when capture fails (${failure})`,
    failure,
  })),
)("$caseTitle", ({ failure }) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    let offers = 0;
    const { runtime, observed, takeEvent } = yield* openRuntime(
      fake,
      "default",
      THREAD_ID,
      SESSION_ID,
      undefined,
      undefined,
      {
        offer: () =>
          Effect.sync(() => {
            offers++;
          }),
      },
      failure === "relative-cwd" ? { ...runtimePolicy, cwd: "relative" } : runtimePolicy,
    );
    yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: modelSelection("default"),
      runtimePolicy,
    });
    if (failure === "state-query") fake.failNextState();
    if (failure === "relative-cwd")
      fake.queueState({ model: { provider: "fixture", id: "synthetic" } });
    yield* fake.emit({ type: "agent_start" });
    const refusal = yield* takeEvent(
      (e) => e.type === "provider_session.updated" && e.providerSession.status === "error",
    );
    assert.include(
      refusal.type === "provider_session.updated" ? refusal.providerSession.lastError : "",
      failure === "state-query"
        ? "could not be captured"
        : failure === "relative-cwd"
          ? "absolute captured cwd"
          : "known native model",
    );
    assert.equal(offers, 0);
    assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
    assert.lengthOf(
      observed.filter((e) => e.type === "provider_turn.updated" || e.type === "turn.terminal"),
      0,
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "requires an explicitly provided continuation queue instead of the dropping reference default",
  () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* piContinuationRequestsIfProvided);
      const bus = { offer: () => Effect.void, take: Effect.never };
      assert.strictEqual(
        yield* piContinuationRequestsIfProvided.pipe(
          Effect.provideService(ProviderContinuationRequests, bus),
        ),
        bus,
      );
    }).pipe(Effect.provide(testLayer)),
);

describe("PiAdapterV2 Extensions", () => {
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
      assert.notInclude(spawn.env.PI_RUNTIME_GUIDANCE, "preview_status");
      assert.isUndefined(spawn.env.T3_MCP_URL);
      assert.isTrue(spawn.args.includes("--extension"));
      assert.isTrue(spawn.args.some((arg) => arg.endsWith("pi-t3-mcp-extension.ts")));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("injects the T3 MCP extension and bearer when a session exists", () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* Effect.acquireRelease(
        mcpSessions.set({
          environmentId: EnvironmentId.make("environment-pi-mcp"),
          threadId: THREAD_ID,
          providerSessionId: "mcp-session-pi",
          providerInstanceId: PI_INSTANCE_ID,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer secret-pi-token",
          capabilities: new Set(["preview"] as const),
          connectors: [],
        }),
        () => mcpSessions.clear(THREAD_ID),
      );
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
      assert.include(spawn.env.PI_RUNTIME_GUIDANCE, "preview_status");
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
      if (timing !== "close") yield* fake.takeRequest("extension_ui_response");
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
});

describe("PiAdapterV2 Inputs", () => {
  it.effect("expands a selected $ skill through Pi's native skill command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            description: "Review this repository.",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Review this change please $repo-review",
      );
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review Review this change please");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("expands every selected $ skill through Pi native skill commands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
          {
            name: "skill:deploy",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/deploy/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "use $repo-review and $deploy");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review /skill:deploy use  and");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    // Every text below takes the same pass-through path; one command and one plain row.
    ["/scient-status exact  arguments\nsecond line", "ordinary text"].map((text) => ({
      caseTitle: `preserves exact native Pi prompt syntax: ${JSON.stringify(text)}`,
      text,
    })),
  )("$caseTitle", ({ text }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], text);
      assert.equal((yield* fake.takeRequest("prompt")).message, text);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    ["/compact", "/native-template"].map((text) => ({
      caseTitle: `rejects native ${text} attachments before delivery and permits recovery`,
      text,
    })),
  )("$caseTitle", ({ text }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({ commands: [{ name: "native-template", source: "prompt" }] });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const result = yield* startTurn(
        runtime,
        providerThread,
        "default",
        [
          {
            type: "file",
            id: "unused",
            name: "fixture.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
          },
        ],
        text,
      ).pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.isFalse(
        fake
          .allRequests()
          .some((request) => request.type === "prompt" || request.type === "compact"),
      );
      yield* startTurn(runtime, providerThread);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects a missing generic Pi attachment before delivery and permits recovery", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const result = yield* startTurn(runtime, providerThread, "default", [
        { type: "file", id: "missing", name: "missing.txt", mimeType: "text/plain", sizeBytes: 1 },
      ]).pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.isFalse(fake.allRequests().some((request) => request.type === "prompt"));
      yield* startTurn(runtime, providerThread);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "sends persisted Pi images and rejects unsupported image steering without ending the turn",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const host = yield* ProviderHost.ProviderHost;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(host.paths.attachmentsDir, { recursive: true });
        yield* fs.writeFileString(`${host.paths.attachmentsDir}/pi-image`, "image");
        const attachment: ChatAttachment = {
          type: "image",
          id: "pi-image",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 5,
        };
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.queueState({ model: { input: ["text", "image"] } });
        yield* startTurn(runtime, providerThread, "default", [attachment], "");
        assert.deepEqual((yield* fake.takeRequest("prompt")).images, [
          { type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" },
        ]);
        const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
        if (running.type !== "provider_turn.updated")
          return yield* Effect.die("Missing native turn");
        fake.queueState({ model: { input: ["text"] } });
        const result = yield* runtime
          .steerTurn({
            threadId: THREAD_ID,
            runId: RunId.make(`run:${THREAD_ID}:1`),
            providerThread,
            providerTurnId: running.providerTurn.id,
            message: {
              messageId: "steer-image" as never,
              text: "look",
              attachments: [attachment],
              createdBy: "user",
              creationSource: "web",
            },
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        assert.equal(fake.allRequests().filter((request) => request.type === "prompt").length, 1);
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          terminal.type === "turn.terminal" &&
            terminal.status === "completed" &&
            terminal.providerTurnId === running.providerTurn.id,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiAdapterV2 Models", () => {
  it.effect(
    "uses instance-scoped custom-model metadata and blocks a later prompt after revocation",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const http = yield* HttpClient.HttpClient;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const requestedInstances: string[] = [];
        const connection: ResolvedModelConnection = {
          id: "fixture",
          name: "Fixture",
          baseUrl: "https://example.test/v1",
          protocol: "openai-completions",
          credentialId: "synthetic-key-id",
          apiKey: Redacted.make("synthetic-key"),
          models: [
            {
              id: "selected",
              modelId: "model/with slash",
              name: "Selected",
              contextWindow: 32000,
              maxOutputTokens: 8192,
              images: false,
              reasoning: true,
              reasoningMetadata: {
                status: "known",
                source: "manual",
                checkedAt: "2026-01-01T00:00:00.000Z",
                stale: false,
                supported: true,
                levels: ["off", "high"],
                defaultLevel: "off",
              },
              instanceIds: [PI_INSTANCE_ID],
            },
          ],
        };
        let connections = [connection];
        const snapshot = () => ({
          ...DEFAULT_SERVER_SETTINGS,
          customModels: { revision: 0, connections },
        });
        const updates = yield* PubSub.unbounded<ReturnType<typeof snapshot>>();
        fake.onSpawn((env) =>
          http
            .get(env.SCIENT_PI_MODELS_URL!, {
              headers: { authorization: "Bearer " + env.SCIENT_PI_MODELS_TOKEN! },
            })
            .pipe(
              Effect.flatMap((response) => response.text),
              Effect.asVoid,
              Effect.orDie,
            ),
        );
        fake.queueCommands({ commands: [{ name: "scient-models-refresh", source: "extension" }] });
        const makeConnection = yield* makePiCustomModelsConnectionFactory(
          {
            getSettings: Effect.sync(snapshot),
            resolveCustomModels: (instanceId) =>
              Effect.sync(() => {
                requestedInstances.push(instanceId);
                return connections;
              }),
            subscribeChanges: PubSub.subscribe(updates).pipe(Effect.map(Stream.fromSubscription)),
          },
          PI_INSTANCE_ID,
          serverConfig.stateDir,
        );
        const { runtime, takeEvent } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          makeConnection,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        // Raw Pi says high is inherited; Scient's annotated default is off.
        const selection = {
          instanceId: PI_INSTANCE_ID,
          model: encodePiModelSlug("scient_fixture", "model/with slash")!,
          options: [{ id: "thinkingLevel", value: "default" }],
        };
        yield* startTurn(runtime, providerThread, "default", [], "First custom prompt", selection);
        assert.equal((yield* fake.takeRequest("set_thinking_level")).level, "off");
        assert.isTrue(
          requestedInstances.length > 0 && requestedInstances.every((id) => id === PI_INSTANCE_ID),
        );
        assert.isTrue(fake.lastSpawn().args.includes("--extension"));
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent((event) => event.type === "turn.terminal");
        connections = [];
        yield* PubSub.publish(updates, snapshot());
        const result = yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          "Revoked custom prompt",
          selection,
          2,
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(
          fake
            .allRequests()
            .some(
              (request) => request.type === "prompt" && request.message === "Revoked custom prompt",
            ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(testLayer.pipe(Layer.provideMerge(FetchHttpClient.layer))),
      ),
  );

  it.effect("leaves the native default model and effort untouched when neither is overridden", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({ model: { provider: "xai", id: "grok-4.6" }, thinkingLevel: "off" });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default");
      assert.isFalse(
        fake
          .allRequests()
          .some((request) => request.type === "set_model" || request.type === "set_thinking_level"),
      );
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "decodes canonical special-character models and confirms explicit thinkingLevel off",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const slug = encodePiModelSlug("provider/name%", "models/name with spaces%");
        assert.isDefined(slug);
        assert.deepEqual(parsePiModelSlug(slug!), {
          provider: "provider/name%",
          modelId: "models/name with spaces%",
        });
        assert.isNull(parsePiModelSlug("provider/models/name with spaces%"));
        yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
          instanceId: PI_INSTANCE_ID,
          model: slug!,
          options: [{ id: "thinkingLevel", value: "off" }],
        });
        const selected = yield* fake.takeRequest("set_model");
        assert.equal(selected.provider, "provider/name%");
        assert.equal(selected.modelId, "models/name with spaces%");
        assert.equal((yield* fake.takeRequest("set_thinking_level")).level, "off");
        assert.isTrue(
          fake.allRequests().some((request) => request.type === "get_available_thinking_levels"),
        );
        yield* fake.takeRequest("prompt");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses prompt delivery when native state does not confirm the requested model", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ model: { provider: "different", id: "model" } });
      const result = yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Hello pi",
        modelSelection("xai/grok-4.6"),
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(fake.allRequests().some((request) => request.type === "prompt"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "refuses prompt delivery when native state substitutes an explicit thinking level",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        fake.queueState({ thinkingLevel: "high" });
        const result = yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
          instanceId: PI_INSTANCE_ID,
          model: "xai/grok-4.6",
          options: [{ id: "thinkingLevel", value: "off" }],
        }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(fake.allRequests().some((request) => request.type === "prompt"));
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps native Pi usable after unsupported thinking validation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const invalid = yield* startTurn(runtime, providerThread, "default", [], "invalid", {
        ...modelSelection("xai/grok-4.6"),
        options: [{ id: "thinkingLevel", value: "impossible" }],
      }).pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 0);
      assert.isFalse(observed.some((event) => event.type === "provider_turn.updated"));
      yield* startTurn(runtime, providerThread, "xai/grok-4.6");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      assert.isTrue(
        (yield* takeEvent((event) => event.type === "turn.terminal")).type === "turn.terminal",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects unsupported Pi automatic mode before native spawn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      let spawned = false;
      fake.onSpawn(() =>
        Effect.sync(() => {
          spawned = true;
        }),
      );
      const adapter = yield* makeAdapter(fake);
      const result = yield* adapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy: { ...runtimePolicy, runtimeMode: "auto" },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(spawned);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiAdapterV2 Offers", () => {
  it.effect.each(
    [false, true].map((rejectPrompt) => ({
      caseTitle: `cancels an unacknowledged native offer before a late prompt ack, rejection=${rejectPrompt}`,
      rejectPrompt,
    })),
  )("$caseTitle", ({ rejectPrompt }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/extension-command");
      yield* fake.takeRequest("prompt");
      const pending = yield* takeEvent((e) => e.type === "provider_turn.updated");
      if (pending.type !== "provider_turn.updated") return;
      assert.equal(pending.providerTurn.nativeAcceptance, "unknown");
      assert.isUndefined(pending.providerTurn.acceptedAt);
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.providerTurn.id,
        requestRuntimeRestart: true,
      });
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: !rejectPrompt,
        ...(rejectPrompt ? { error: "closed by Stop" } : {}),
      });
      yield* fake.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
      assert.isFalse(
        observed.some(
          (e) =>
            e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
        ),
      );
      assert.isFalse(
        observed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
      );
      const stopped = observed
        .flatMap((e) => (e.type === "provider_turn.updated" ? [e.providerTurn] : []))
        .at(-1);
      assert.equal(stopped?.nativeAcceptance, "unknown");
      assert.isUndefined(stopped?.acceptedAt);
      assert.equal(fake.allRequests().filter((r) => r.type === "abort").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    [false, true].map((hardStop) => ({
      caseTitle: `interrupts steering held in native preflight without offering it, hard Stop=${hardStop}`,
      hardStop,
    })),
  )("$caseTitle", ({ hardStop }) =>
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
      const accepted = yield* takeEvent(
        (e) => e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted.type !== "provider_turn.updated") return;
      fake.deferNextState();
      const steering = yield* runtime
        .steerTurn({
          threadId: THREAD_ID,
          runId: RunId.make(`run:${THREAD_ID}:1`),
          providerThread,
          providerTurnId: accepted.providerTurn.id,
          message: {
            messageId: MessageId.make("held-steer"),
            text: "steer",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* fake.takeRequest("get_state");
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: accepted.providerTurn.id,
        requestRuntimeRestart: hardStop,
      });
      if (!hardStop) yield* fake.resolveDeferredState(recordedIdleState(FAKE_SESSION_FILE));
      const result = yield* Fiber.join(steering);
      assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
      if (!hardStop) yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      assert.equal(fake.allRequests().filter((r) => r.type === "prompt").length, 1);
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
      assert.isFalse(
        observed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("contains a blocked native steering write without waiting for command acceptance", () =>
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
      const accepted = yield* takeEvent(
        (e) => e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted.type !== "provider_turn.updated") return;
      fake.blockNextPromptWrite();
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make(`run:${THREAD_ID}:1`),
        providerThread,
        providerTurnId: accepted.providerTurn.id,
        message: {
          messageId: MessageId.make("blocked-steer"),
          text: "steer",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      const stopping = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: accepted.providerTurn.id,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(stopping);
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      yield* fake.releasePromptWrite;
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "closed by Stop",
      });
      yield* Effect.yieldNow;
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
      assert.isFalse(
        observed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
      );
      assert.equal(fake.allRequests().filter((r) => r.type === "prompt").length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reports rejected native steering while the original turn keeps streaming", () =>
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
      const accepted = yield* takeEvent(
        (e) => e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted.type !== "provider_turn.updated") return;
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make(`run:${THREAD_ID}:1`),
        providerThread,
        providerTurnId: accepted.providerTurn.id,
        message: {
          messageId: MessageId.make("refused-steer"),
          text: "steer",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "Steering refused",
      });
      const refused = yield* takeEvent(
        (e) => e.type === "turn_item.updated" && e.turnItem.type === "error",
      );
      assert.isTrue(
        refused.type === "turn_item.updated" &&
          refused.turnItem.type === "error" &&
          refused.turnItem.failure.message === "Steering refused" &&
          refused.turnItem.providerTurnId === accepted.providerTurn.id,
      );
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        0,
      );
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Original reply after refusal" }],
        },
      });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      assert.isTrue(
        observed.some(
          (e) => e.type === "message.updated" && e.message.text === "Original reply after refusal",
        ),
      );
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "retains the exact uncertain offer when a native stdin write fails before its receipt is emitted",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const makeConnection: typeof makePiRpcConnection = (input) =>
          makePiRpcConnection(input).pipe(
            Effect.map((connection) => ({
              ...connection,
              send: (record) =>
                connection.send(record).pipe(
                  Effect.andThen(
                    record.type === "prompt"
                      ? Effect.fail(
                          new PiRpcError({
                            operation: "stdin write",
                            detail: "Write outcome unknown",
                          }),
                        )
                      : Effect.void,
                  ),
                ),
            })),
          );
        const { runtime } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          makeConnection,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const error = yield* startTurn(runtime, providerThread).pipe(Effect.flip);
        if (!isNativeStartReceiptError(error))
          return yield* Effect.die("Expected exact native start error");
        assert.equal(error.providerTurn?.nativeAcceptance, "unknown");
        assert.isUndefined(error.providerTurn?.acceptedAt);
        assert.equal(error.providerTurn?.providerThreadId, providerThread.id);
        assert.equal(
          error.providerTurn?.runAttemptId,
          RunAttemptId.make(`run-attempt:run:${THREAD_ID}:1:1`),
        );
        assert.equal(error.providerTurn?.nodeId, NodeId.make(`node:run:${THREAD_ID}:1:root`));
        assert.equal((yield* fake.takeRequest("prompt")).type, "prompt");
        assert.equal(runtime.providerSession.status, "error");
        assert.equal(
          (yield* startTurn(
            runtime,
            providerThread,
            "default",
            [],
            "cannot replay",
            undefined,
            2,
          ).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(fake.allRequests().filter((request) => request.type === "prompt").length, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiAdapterV2 Progress", () => {
  it.effect("defers native preflight compaction settlement until initial acceptance", () =>
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
      yield* fake.emit({ type: "compaction_end" });
      yield* fake.takeRequest("get_state");
      yield* Effect.yieldNow;
      assert.isFalse(observed.some((event) => event.type === "turn.terminal"));
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    (
      [
        "pending-acceptance",
        "buffered-content",
        "buffered-error",
        "final-idle-error",
        "stop",
      ] as const
    ).map((scenario) => ({
      caseTitle: `fences native settlement across a blocked usage request (${scenario})`,
      scenario,
    })),
  )("$caseTitle", ({ scenario }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      const receipt = yield* takeEvent((event) => event.type === "provider_turn.updated");
      if (receipt.type !== "provider_turn.updated") return;
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      fake.deferNextStats();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_session_stats");
      if (scenario === "stop") {
        const stopping = yield* runtime
          .interruptTurn({ providerThread, providerTurnId: receipt.providerTurn.id })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("3 seconds");
        yield* fake.closeStdout;
        yield* Fiber.join(stopping);
      } else {
        yield* runtime.steerTurn({
          threadId: THREAD_ID,
          providerThread,
          providerTurnId: receipt.providerTurn.id,
          runId: RunId.make("run:thread-pi-test:1"),
          message: {
            messageId: "steer-settle" as Parameters<
              ProviderAdapterV2SessionRuntime["steerTurn"]
            >[0]["message"]["messageId"],
            text: "steer",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });
        yield* fake.takeRequest("prompt");
        if (scenario !== "pending-acceptance" && scenario !== "final-idle-error") {
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "  Fast steering response\n" }],
              stopReason: scenario === "buffered-error" ? "error" : "stop",
              errorMessage: "Synthetic steering failure",
            },
          });
          yield* fake.emit({ type: "agent_settled" });
        }
      }
      if (scenario === "final-idle-error") fake.deferNextState();
      if (scenario !== "stop") yield* fake.resolveDeferredStats();
      if (scenario === "final-idle-error") {
        yield* fake.takeRequest("get_state");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "  Fast steering response\n" }],
            stopReason: "error",
            errorMessage: "Synthetic steering failure",
          },
        });
        yield* fake.emit({ type: "agent_settled" });
        yield* fake.resolveDeferredState(recordedIdleState(FAKE_SESSION_FILE));
      }
      if (scenario === "pending-acceptance") {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "acceptance-fence",
        });
        yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "system_notice" &&
            event.turnItem.message === "acceptance-fence",
        );
        assert.isFalse(observed.some((event) => event.type === "turn.terminal"));
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "response", command: "prompt", success: true });
      }
      // Stop changes the generation/intent while telemetry is blocked; its
      // actual idle acknowledgement must settle the same owned turn.

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" && terminal.providerTurnId === receipt.providerTurn.id,
      );
      if (terminal.type === "turn.terminal")
        assert.equal(
          terminal.status,
          scenario === "stop"
            ? "interrupted"
            : scenario === "buffered-error" || scenario === "final-idle-error"
              ? "failed"
              : "completed",
        );
      if (scenario.startsWith("buffered") || scenario === "final-idle-error")
        assert.isTrue(
          observed.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.text === "  Fast steering response\n",
          ),
        );
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiAdapterV2 Recovery", () => {
  it.effect.each(
    ["", "Preserved partial answer"].map((partial) => ({
      caseTitle: `settles native Pi truncation with ${partial ? "partial" : "empty"} text and reuses the session`,
      partial,
    })),
  )("$caseTitle", ({ partial }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "text", text: partial }],
        },
      });
      yield* fake.emit({ type: "agent_end" });
      yield* fake.emit({ type: "agent_settled" });
      const first = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(first.type === "turn.terminal" && first.status === "completed");
      assert.deepEqual(
        observed
          .filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
          )
          .map((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? event.turnItem.text
              : "",
          ),
        partial ? [partial] : [],
      );
      assert.isTrue(
        observed.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "notification" &&
            event.turnItem.source.kind === "output_truncated",
        ),
      );
      yield* startTurn(runtime, providerThread, "default", [], "continue", undefined, 2);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const second = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(second.type === "turn.terminal" && second.status === "completed");
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    ["error", "length"].map((initialStopReason) => ({
      caseTitle: `preserves final whitespace after native Pi recovery from ${initialStopReason}`,
      initialStopReason,
    })),
  )("$caseTitle", ({ initialStopReason }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: initialStopReason,
          errorMessage: "retrying",
          content: [],
        },
      });
      yield* fake.emit({ type: "agent_end" });
      yield* fake.emit({ type: "turn_end" });
      yield* fake.emit({ type: "turn_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "  שלום π\n" }],
        },
      });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "notify",
        message: "cycle-fence",
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "system_notice" &&
          event.turnItem.message === "cycle-fence",
      );
      assert.isFalse(observed.some((event) => event.type === "turn.terminal"));
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      const text = observed
        .filter(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        )
        .map((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? event.turnItem.text
            : "",
        );
      assert.deepEqual(text, ["  שלום π\n"]);
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("native Pi Stop wins pending truncation and suppresses blank messages", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
      if (running.type !== "provider_turn.updated")
        return yield* Effect.die("Missing running turn");
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "length", content: [] },
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      assert.isFalse(
        observed.some(
          (event) =>
            event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "notification"),
        ),
      );
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    [
      "400 maximum context length exceeded",
      "429 rate limit: too many tokens",
      "Invalid API key",
    ].map((error) => ({
      caseTitle: `classifies native Pi context failure without rewriting ${error.startsWith("400") ? "the recovery advice" : error}`,
      error,
    })),
  )("$caseTitle", ({ error }) => expectModelFailure(error, piContextErrorMessage(error)));

  it.effect.each(
    ["context-limit", "extension-error", "continue"].map((failure) => ({
      caseTitle: `settles guarded native Pi context recovery after ${failure}`,
      failure,
    })),
  )("$caseTitle", ({ failure }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "notify",
        message: "scient:context-recovery: compacting",
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "system_notice" &&
          event.turnItem.message === "scient:context-recovery: compacting",
      );
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({
        type: "extension_ui_request",
        method: "notify",
        message: "probe-fence",
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "system_notice" &&
          event.turnItem.message === "probe-fence",
      );
      assert.isFalse(observed.some((event) => event.type === "turn.terminal"));
      yield* fake.emit({ type: "compaction_end", result: { summary: "saved progress" } });
      if (failure === "context-limit")
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "scient:context-limit: failed",
        });
      else if (failure === "extension-error")
        yield* fake.emit({
          type: "extension_error",
          event: "send_message",
          error: "synthetic continuation failure",
        });
      else {
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
        yield* fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Continued" }],
          },
        });
        yield* fake.emit({ type: "agent_settled" });
      }
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === (failure === "continue" ? "completed" : "failed"),
      );
      if (terminal.type === "turn.terminal" && terminal.status === "failed")
        assert.include(terminal.failure.message, "Saved");
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a rejected native Pi prompt once and permits the next turn", () =>
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
        type: "response",
        command: "prompt",
        success: false,
        error: "Synthetic rejected prompt",
      });
      const failed = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        failed.type === "turn.terminal" &&
          failed.status === "failed" &&
          failed.failure?.message === "Synthetic rejected prompt",
      );
      yield* startTurn(runtime, providerThread, "default", [], "second", undefined, 2);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const recovered = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        recovered.type === "turn.terminal" &&
          recovered.status === "completed" &&
          recovered.providerTurnId !==
            (failed.type === "turn.terminal" ? failed.providerTurnId : undefined),
      );
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails native Pi transport closure once and refuses further delivery", () =>
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
      yield* fake.emit({ type: "agent_start" });
      yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.nativeAcceptance === "accepted",
      );
      yield* fake.closeStdout;
      const failed = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        failed.type === "turn.terminal" &&
          failed.status === "failed" &&
          failed.threadDisposition === "broken" &&
          failed.failure?.message.includes("exited unexpectedly"),
      );
      assert.equal(
        (yield* startTurn(runtime, providerThread, "default", [], "after close", undefined, 2).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 1);
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
      const replacement = yield* makeFakePi;
      const next = yield* openRuntime(replacement);
      const resumed = yield* next.runtime.resumeThread({ providerThread });
      yield* startTurn(next.runtime, resumed, "default", [], "recovered", undefined, 2);
      yield* replacement.emit({ type: "agent_start" });
      yield* replacement.emit({ type: "agent_settled" });
      assert.isTrue(
        (yield* next.takeEvent((event) => event.type === "turn.terminal")).type === "turn.terminal",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects native Pi thread startup after an already closed transport", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.closeStdout;
      const { runtime } = yield* openRuntime(fake);
      const starting = yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(starting.pollUnsafe());
      const result = yield* Fiber.join(starting);
      assert.equal(result._tag, "Failure");
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects native Pi preflight when stdout closes during model confirmation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextState();
      const sending = yield* startTurn(runtime, providerThread, "xai/grok-4.6").pipe(
        Effect.result,
        Effect.forkScoped,
      );
      yield* fake.takeRequest("set_model");
      yield* fake.takeRequest("get_state");
      yield* fake.closeStdout;
      assert.equal((yield* Fiber.join(sending))._tag, "Failure");
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 0);
      assert.isFalse(observed.some((event) => event.type === "provider_turn.updated"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    (["settlement", "steering"] as const).map((phase) => ({
      caseTitle: `fails native Pi identity drift during ${phase} once and keeps Stop idempotent`,
      phase,
    })),
  )("$caseTitle", ({ phase }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      let terminations = 0;
      const makeConnection: typeof makePiRpcConnection = (input) =>
        makePiRpcConnection(input).pipe(
          Effect.map((connection) => ({
            ...connection,
            terminate: Effect.sync(() => {
              terminations += 1;
            }).pipe(Effect.andThen(connection.terminate), Effect.andThen(fake.closeStdout)),
          })),
        );
      const { runtime, takeEvent, observed } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        makeConnection,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const accepted = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted.type !== "provider_turn.updated") return;
      fake.queueState({ sessionId: "unexpected-session" });
      if (phase === "settlement") yield* fake.emit({ type: "agent_settled" });
      else {
        const result = yield* runtime
          .steerTurn({
            threadId: THREAD_ID,
            runId: RunId.make("run:thread-pi-test:1"),
            providerThread,
            providerTurnId: accepted.providerTurn.id,
            message: {
              messageId: "drift" as never,
              text: "steer",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.isFalse(Cause.hasInterruptsOnly(result.cause));
      }
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.threadDisposition === "broken",
      );
      for (let count = 0; count < 2; count++)
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: accepted.providerTurn.id,
          requestRuntimeRestart: true,
        });
      assert.equal(terminations, 1);
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiAdapterV2 Sessions", () => {
  it.effect("rejects a foreign instance resume before switching the native session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const result = yield* runtime
        .resumeThread({
          providerThread: {
            ...providerThread,
            providerInstanceId: ProviderInstanceId.make("other-pi"),
          },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(fake.allRequests().some((request) => request.type === "switch_session"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
