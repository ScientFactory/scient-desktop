// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeOmpRpcClient } from "effect-omp-rpc/client";
import { makeOmpScriptedWire } from "../../provider/omp/OmpCaptureReplay.testFixtures.ts";
import { makeOmpRedaction } from "../../provider/omp/OmpRpcProcess.ts";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";
import { nativeOmpSession } from "../../provider/testUtils/nativeOmpSession.ts";
import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";
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

describe("native OMP process redaction", () => {
  it.live(
    "keeps a process-only secret out of native events, request errors and every native log frame",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "scient-native-omp-redact-"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const logged: Array<unknown> = [];
          const instanceId = ProviderInstanceId.make("native-omp-redaction");
          let sessionDirectory: string | undefined;
          let ordinal = 0;
          const wire = yield* makeOmpScriptedWire(
            (command) => {
              if (command.type === "new_session") ordinal++;
              if (command.type === "get_available_models")
                return {
                  type: "response",
                  id: command.id,
                  command: command.type,
                  success: true,
                  data: {
                    models: [
                      { provider: "scient-stub", id: "stub-model", input: ["text"] },
                      { provider: "scient-stub", id: "echo-model", input: ["text"] },
                    ],
                  },
                };
              if (command.type === "get_state") {
                if (!sessionDirectory) throw new Error("No native session directory");
                const sessionFile = NodePath.join(sessionDirectory, `redaction-${ordinal}.jsonl`);
                NodeFS.writeFileSync(sessionFile, "{}\n");
                return {
                  type: "response",
                  id: command.id,
                  command: command.type,
                  success: true,
                  data: {
                    sessionFile,
                    sessionId: `redaction-${ordinal}`,
                    model: { provider: "scient-stub", id: "stub-model" },
                    thinkingLevel: "off",
                    isStreaming: false,
                    isCompacting: false,
                    hasPendingAsyncWork: false,
                    isSettled: true,
                  },
                };
              }
              return command.type === "set_model" && command.modelId === "echo-model"
                ? {
                    type: "response",
                    id: command.id,
                    command: command.type,
                    success: false,
                    error: `Model rejected: ${ECHO}`,
                  }
                : undefined;
            },
            (command) =>
              command.type === "prompt"
                ? [
                    ...echoingTurn(String(command.id)),
                    {
                      type: "message_end",
                      message: {
                        role: "toolResult",
                        content: [{ type: "image", data: "B".repeat(2048), mimeType: "image/png" }],
                      },
                    },
                  ]
                : [],
          );
          const session = yield* nativeOmpSession({
            root,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            target: ompTarget,
            binaryPath: "omp",
            instanceId,
            threadId: ThreadId.make("native-redaction-thread"),
            modelSelection: createModelSelection(instanceId, "scient-stub/stub-model"),
            environment: { HOME: "/tmp/home" },
            nativeEventLogger: {
              filePath: "/dev/null",
              write: (event, threadId) => Effect.sync(() => logged.push({ event, threadId })),
              close: () => Effect.void,
            },
            makeProcess: (options) =>
              Effect.gen(function* () {
                sessionDirectory = options.sessionDir;
                const redaction = makeOmpRedaction(options.env, [...(options.secrets ?? []), KEY]);
                const client = yield* makeOmpRpcClient(
                  wire.io,
                  options.onFrame
                    ? {
                        onFrame: (trace) =>
                          options.onFrame!({
                            direction: trace.direction,
                            frame: redaction.log(trace.frame) as typeof trace.frame,
                          }),
                      }
                    : {},
                );
                return {
                  ...client,
                  version: "18.3.1",
                  runtimeVersion: "18.3.1",
                  redaction,
                  shutdown: wire.io.close!.pipe(
                    Effect.as({ code: 0, forced: false, stderrTail: "" }),
                  ),
                };
              }),
          });
          const events: Array<ProviderAdapterV2Event> = [];
          const queue = yield* Queue.unbounded<ProviderAdapterV2Event>();
          yield* session.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
            ),
            Effect.forkScoped,
          );
          const rejected = yield* session
            .start({ text: "Switch." }, createModelSelection(instanceId, "scient-stub/echo-model"))
            .pipe(Effect.flip);
          expect(toJson(rejected)).toContain("Model rejected");
          expect(toJson(rejected)).not.toContain(KEY);
          expect(String(rejected.cause ?? "")).not.toContain(KEY);
          yield* session.start({ text: "Say hello." });
          while (!events.some((event) => event.type === "turn.terminal" && event.runOrdinal === 2))
            yield* Queue.take(queue).pipe(Effect.timeout("5 seconds"));
          yield* Effect.sleep("50 millis");
          const terminal = events.findLast((event) => event.type === "turn.terminal");
          if (terminal?.type !== "turn.terminal") throw new Error("No native redaction terminal");
          expect(terminal.status).toBe("failed");
          expect(terminal.failure?.message).toContain("Incorrect API key provided: [REDACTED]");
          const tools = events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
              ? [event.turnItem]
              : [],
          );
          expect(tools.some((tool) => String(tool.output).includes("retrying"))).toBe(true);
          expect(
            tools.some((tool) => String(tool.output).includes("extension saw [REDACTED]")),
          ).toBe(true);
          expect(tools.some((tool) => String(tool.output).includes("cannot read"))).toBe(false);
          const text = events.findLast((event) => event.type === "message.updated");
          if (text?.type !== "message.updated")
            throw new Error("No native redacted assistant text");
          expect(text.message.text).toBe(
            "The key [REDACTED] lives in /tmp/home/.env next to Bearer placeholders.",
          );
          expect(toJson(events)).not.toContain(KEY);
          expect(toJson(session.runtime.providerSession)).not.toContain(KEY);
          expect(logged.length).toBeGreaterThan(5);
          expect(toJson(logged)).not.toContain(KEY);
          expect(toJson(logged)).not.toContain("B".repeat(2048));
          const encodedLog = toJson(logged);
          for (const kind of ["command", "response", "notification"])
            expect(encodedLog).toContain(`"kind":"${kind}"`);
          expect(encodedLog).toContain('"method":"prompt"');
          expect(encodedLog).toContain('"method":"message_end"');
          yield* session.close;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
