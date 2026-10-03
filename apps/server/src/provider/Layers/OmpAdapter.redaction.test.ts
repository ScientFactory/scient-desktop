// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeOmpRpcClient } from "effect-omp-rpc/client";

import { makeOmpScriptedWire } from "../omp/OmpCaptureReplay.testFixtures.ts";
import { makeOmpRedaction } from "../omp/OmpRpcProcess.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";
import { ompTarget } from "../omp/OmpTarget.ts";

const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** A custom-model key only the process knows: the adapter never sees it. */
const KEY = "customlivekey-0123456789abcdef";
const ECHO = `401 Incorrect API key provided: ${KEY}. (type=invalid_request_error)`;

const failedAssistant = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "scient-stub",
  model: "stub-model",
  stopReason: "error",
  errorStatus: 401,
  errorMessage: ECHO,
};

/** OMP 18.3.1's frames for a turn whose provider echoed the key (as `auth-401`). */
const echoingTurn = (id: string) => [
  { type: "agent_start" },
  { type: "turn_start" },
  {
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 1,
    errorMessage: ECHO,
  },
  { type: "extension_error", error: `extension saw ${KEY}` },
  {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: `echo ${KEY}` }] },
  },
  { type: "message_start", message: { ...failedAssistant }, messageId: "msg-2" },
  {
    type: "message_update",
    message: { role: "assistant", content: [] },
    messageId: "msg-2",
    assistantMessageEvent: {
      type: "text_delta",
      delta: `The key ${KEY} lives in /tmp/home/.env next to Bearer placeholders.`,
    },
  },
  { type: "message_end", message: failedAssistant, messageId: "msg-2" },
  { type: "turn_end", message: failedAssistant, toolResults: [] },
  { type: "agent_end", messages: [failedAssistant], isTerminal: true, yielded: true },
  {
    type: "prompt_result",
    id,
    agentInvoked: true,
    status: "error",
    sessionSettled: true,
    error: {
      message: ECHO,
      provider: "scient-stub",
      model: "stub-model",
      httpStatus: 401,
      retryable: false,
    },
  },
  { type: "session_settled" },
];

describe("Oh My Pi adapter redaction", () => {
  it.live("keeps a process-only secret out of events, errors and the native log", () =>
    Effect.gen(function* () {
      const wire = yield* makeOmpScriptedWire(
        (command) =>
          command.type === "set_model" && command.modelId === "echo-model"
            ? {
                type: "response",
                id: command.id,
                command: "set_model",
                success: false,
                error: `Model rejected: ${ECHO}`,
              }
            : undefined,
        (command) => (command.type === "prompt" ? echoingTurn(String(command.id)) : []),
      );
      const logged: Array<unknown> = [];
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-redact-"));
      const adapter = yield* makeOmpAdapter({
        target: ompTarget,
        binaryPath: "omp",
        providerInstanceId: ProviderInstanceId.make("omp"),
        stateDir,
        attachmentsDir: stateDir,
        environment: { HOME: "/tmp/home" },
        nativeEventLogger: {
          filePath: "/dev/null",
          write: (event) =>
            Effect.sync(() => {
              logged.push(event);
            }),
          close: () => Effect.void,
        },
        // Like the custom-model factory: the process adds its own secret to
        // the ones the adapter passed.
        makeProcess: (options) => {
          const redaction = makeOmpRedaction(options.env, [...(options.secrets ?? []), KEY]);
          const onFrame = options.onFrame;
          return makeOmpRpcClient(
            wire.io,
            onFrame
              ? {
                  onFrame: (trace) =>
                    onFrame({
                      direction: trace.direction,
                      frame: redaction.log(trace.frame) as typeof trace.frame,
                    }),
                }
              : {},
          ).pipe(
            Effect.map((client) => ({
              ...client,
              version: "18.3.1",
              runtimeVersion: "18.3.1",
              redaction,
            })),
          );
        },
      });
      const events: Array<ProviderRuntimeEvent> = [];
      const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
        ),
        Effect.forkScoped,
      );
      const threadId = ThreadId.make("omp-redaction");
      yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });

      // A rejected command's text reaches the caller as a request error.
      const rejected = yield* adapter
        .sendTurn({
          threadId,
          input: "Switch.",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("omp"),
            "scient-stub/echo-model",
          ),
        })
        .pipe(Effect.flip);
      expect(rejected.message).toContain("Model rejected");
      expect(toJson(rejected)).not.toContain(KEY);
      expect(String(rejected.cause ?? "")).not.toContain(KEY);

      yield* adapter.sendTurn({ threadId, input: "Say hello." });
      while (!events.some((event) => event.type === "turn.completed")) {
        yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"));
      }
      yield* Effect.sleep("50 millis");

      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.payload).toMatchObject({ state: "failed" });
      const errorMessage =
        completed?.type === "turn.completed" ? String(completed.payload.errorMessage) : "";
      expect(errorMessage).toContain("Incorrect API key provided: [REDACTED]");
      const warnings = events.flatMap((event) =>
        event.type === "runtime.warning" ? [event.payload.message] : [],
      );
      expect(warnings.some((message) => message.includes("retrying"))).toBe(true);
      expect(warnings.some((message) => message.includes("extension saw [REDACTED]"))).toBe(true);
      expect(warnings.some((message) => message.includes("cannot read"))).toBe(false);
      // Ordinary content loses the secret and nothing else.
      const text = events
        .flatMap((event) =>
          event.type === "content.delta" && event.payload.streamKind === "assistant_text"
            ? [event.payload.delta]
            : [],
        )
        .join("");
      expect(text).toBe("The key [REDACTED] lives in /tmp/home/.env next to Bearer placeholders.");
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      expect(session?.lastError).toContain("[REDACTED]");

      expect(toJson(events)).not.toContain(KEY);
      expect(toJson(session)).not.toContain(KEY);
      expect(logged.length).toBeGreaterThan(5);
      expect(toJson(logged)).not.toContain(KEY);
      yield* adapter.stopAll();
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
