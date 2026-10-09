import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { type ProviderAdapterV2HistoricalContext } from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, EnvironmentId, RunAttemptId, RunId, TurnItemId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  CODEX_TEST_RUNTIME_POLICY,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect(
    "withholds a live peer's MCP config and turn instructions when native injection is disabled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = "disabled-mcp-peer";
          const threadId = ThreadId.make(`thread-${scenario}`);
          const nativeThreadId = "disabled-mcp-native";
          const nativeTurnId = "disabled-mcp-turn";
          McpProviderSession.setMcpProviderSession({
            environmentId: EnvironmentId.make("disabled-mcp-environment"),
            threadId,
            providerSessionId: "disabled-mcp-live-peer",
            providerInstanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer synthetic-live-peer",
            capabilities: new Set(["orchestration", "skills:read"] as const),
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
          );
          const transcript = makeCodexReplayTranscript({
            scenario,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" }),
              {
                type: "emit_inbound",
                label: "completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                  },
                },
              },
            ],
          });
          // Exact replay expectations require no peer MCP server/config or agent-facing tool instructions.
          const harness = yield* makeCodexReplayHarness(
            transcript,
            undefined,
            undefined,
            undefined,
            false,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("disabled-mcp-attempt"),
              text: "work",
            }),
          );
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.equal(
            McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
            "disabled-mcp-live-peer",
          );
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect.each(
    (["supported", "unsupported", "invalid"] as const).map((response) => ({
      caseTitle: `delivers native history with ${response} app-server protocol`,
      response,
    })),
  )("$caseTitle", ({ response }) =>
    Effect.gen(function* () {
      const nativeThreadId = `inject-${response}`;
      const prompt = "Only the current request";
      const history: ProviderAdapterV2HistoricalContext = {
        context: "Historical conversation",
        messages: (["user", "assistant"] as const).map((role) => ({
          role,
          text:
            role === "user" ? "Original request\n" + "界".repeat(300) : "Partial interrupted work",
          threadId: ThreadId.make("source"),
          runId: RunId.make("source-run"),
          itemId: TurnItemId.make(`source-${role}`),
          providerThreadId: null,
          kind: `${role}_message`,
          status: "interrupted",
        })),
      };
      const items = historyResponseItems(history.messages, history.context);
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "current-turn",
        prompt,
      });
      const transcript = makeCodexReplayTranscript({
        scenario: `inject-${response}`,
        entries: [
          ...preamble.slice(0, -3),
          {
            type: "expect_outbound",
            label: "inject",
            frame: {
              id: 3,
              method: "thread/inject_items",
              params: { threadId: nativeThreadId, items },
            },
          },
          {
            type: "emit_inbound",
            label: "inject-result",
            frame:
              response === "supported"
                ? { id: 3, result: {} }
                : {
                    id: 3,
                    error: {
                      code: response === "unsupported" ? -32601 : -32602,
                      message: "Injection rejected",
                    },
                  },
          },
          ...(response === "invalid"
            ? []
            : preamble
                .slice(-3)
                .map((entry) =>
                  "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
                    ? { ...entry, frame: { ...entry.frame, id: 4 } }
                    : entry,
                )),
        ],
      });
      const requests: string[] = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            requests.push(method);
          }),
      );
      const injection = yield* harness.runtime.injectHistory!({
        providerThread: harness.providerThread,
        ...history,
      }).pipe(Effect.result);
      if (response === "invalid") {
        assert.equal(injection._tag, "Failure");
        if (injection._tag === "Failure") {
          assert.equal(injection.failure._tag, "ProviderAdapterProtocolError");
          assert.propertyVal(injection.failure.cause, "code", -32602);
          assert.notProperty(injection.failure, "payload");
        }
        assert.notInclude(requests, "turn/start");
        return;
      }
      assert.equal(injection._tag, "Success");
      if (injection._tag === "Success") assert.equal(injection.success, response === "supported");
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("inject-attempt"),
          text: prompt,
        }),
      );
      assert.equal(requests.filter((method) => method === "turn/start").length, 1);
      assert.isBelow(requests.indexOf("thread/inject_items"), requests.indexOf("turn/start"));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("identifies sessions to Codex with the same client info as main", () =>
    Effect.gen(function* () {
      const transcript = makeCodexReplayTranscript({
        scenario: "initialize-client-info",
        entries: codexReplayPreamble({
          nativeThreadId: "client-info-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        }).slice(0, 5),
      });
      const initializeParams: Array<unknown> = [];
      yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "initialize") initializeParams.push(params);
          }),
      );
      // Codex uses clientInfo.name as the request originator. Replays ignore the
      // version, so pin the whole value here.
      assert.deepEqual(initializeParams, [
        {
          clientInfo: {
            name: "t3code_desktop",
            title: "Scient Desktop",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
            optOutNotificationMethods: ["turn/diff/updated"],
          },
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("applies distinct native thread workspaces inside one pooled Codex process", () =>
    Effect.gen(function* () {
      const firstNative = "pooled-project-one";
      const secondNative = "pooled-project-two";
      const preamble = codexReplayPreamble({
        nativeThreadId: firstNative,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const second = codexReplayPreamble({
        nativeThreadId: secondNative,
        nativeTurnId: "unused",
        prompt: "unused",
        startRequestId: 3,
        cwd: "/workspace/second-project",
      });
      const requested: unknown[] = [];
      const h = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "pooled-project-workspaces",
          entries: [...preamble.slice(0, 5), ...second.slice(3, 5)],
        }),
        () => Effect.void,
        (method, params) =>
          method === "thread/start" ? Effect.sync(() => requested.push(params)) : Effect.void,
      );
      const sibling = yield* h.runtime.ensureThread({
        threadId: ThreadId.make("pooled-second-app-thread"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, cwd: "/workspace/second-project" },
      });
      assert.equal(
        h.runtime.providerSession.capabilities.sessions.supportsPerThreadWorkspace,
        true,
      );
      assert.equal(h.providerThread.nativeThreadRef?.nativeId, firstNative);
      assert.equal(sibling.nativeThreadRef?.nativeId, secondNative);
      assert.equal(sibling.providerSessionId, h.providerThread.providerSessionId);
      assert.deepEqual(requested, [
        CodexAdapterV2.codexThreadRuntimeParams({
          threadId: h.threadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        }),
        CodexAdapterV2.codexThreadRuntimeParams({
          threadId: ThreadId.make("pooled-second-app-thread"),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, cwd: "/workspace/second-project" },
        }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("unsubscribes from the native thread when it is unloaded", () =>
    Effect.gen(function* () {
      const nativeThreadId = "unload-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "unload-thread",
        entries: [
          // initialize + thread/start only; no turn runs.
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          // Response shape recorded from codex app-server 0.156.1.
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 3, result: { status: "unsubscribed" } },
          },
        ],
      });
      const requests: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) => Effect.sync(() => requests.push(method)),
      );
      assert.isDefined(harness.runtime.unloadThread);
      yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
      assert.deepEqual(requests, ["initialize", "thread/start", "thread/unsubscribe"]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("keeps the app-server failure as the cause when an unload is rejected", () =>
    Effect.gen(function* () {
      const nativeThreadId = "unload-thread-rejected";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "unload-thread-rejected",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 3, error: { code: -32600, message: "invalid thread id" } },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const error = yield* harness.runtime.unloadThread!({
        providerThread: harness.providerThread,
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProtocolError");
      const cause = error._tag === "ProviderAdapterProtocolError" ? error.cause : undefined;
      assert.equal((cause as { _tag?: string } | undefined)?._tag, "CodexAppServerRequestError");
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});
