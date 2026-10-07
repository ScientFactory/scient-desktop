#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CompatAgentRpcs } from "effect-acp/rpc";
import * as AcpProtocol from "effect-acp/protocol";
import type * as AcpCompat from "effect-acp/compat";
import type * as AcpSchema from "effect-acp/schema";
import { beginAcpMockPrompt } from "./acpMockCancellationState.ts";

// The selected Grok tests exercise its V1 model/load/plan contract. Other
// protocol-neutral scenarios retain the generic V2 peer.
const rpcs = CompatAgentRpcs.omit(
  "auth/login",
  "auth/logout",
  "logout",
  "session/set_mode",
  "session/list",
  "session/fork",
  "session/resume",
  "session/close",
  "session/delete",
  "providers/list",
  "providers/set",
  "providers/disable",
);
const sessionId = "mock-session-1";
const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const pidLogPath = process.env.T3_ACP_PID_LOG_PATH;
const emptyPromptAcknowledgement: AcpSchema.PromptResponse = {};
const nativeV2 = process.env.T3_ACP_GROK_MOCK_GENERATION === "2";
if (pidLogPath) NodeFS.writeFileSync(pidLogPath, String(process.pid));

const program = Effect.gen(function* () {
  let modelId = "grok-4.6";
  let reasoningEffort = "high";
  const cancelledSessions = new Set<string>();
  let cancelled = yield* Deferred.make<void>();
  const modelState = (): AcpCompat.SessionModelState => ({
    currentModelId: modelId,
    availableModels: [
      { modelId: "grok-4.6", name: "Grok 4.6", _meta: { reasoningEffort } },
      { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
    ],
  });
  const configOptions = () => [
    {
      configId: "native-model-choice",
      type: "select" as const,
      name: "Model",
      category: "model",
      currentValue: modelId,
      options: [
        { value: "grok-4.6", name: "Grok 4.6" },
        { value: "grok-mock-alt", name: "Alternate" },
      ],
    },
    ...(process.env.T3_ACP_GROK_EFFORT_UNAVAILABLE === "1"
      ? []
      : [
          {
            configId: "native-effort-choice",
            type: "select" as const,
            name: "Effort",
            category: "thought_level",
            currentValue: reasoningEffort,
            options: [
              { value: "high", name: "High" },
              { value: "low", name: "Low" },
            ],
          },
        ]),
  ];
  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio: yield* Stdio.Stdio,
    serverRequestMethods: new Set(rpcs.requests.keys()),
    logIncoming: requestLogPath !== undefined,
    logger: (event) =>
      Effect.sync(() => {
        if (
          requestLogPath &&
          event.direction === "incoming" &&
          event.stage === "raw" &&
          typeof event.payload === "string"
        ) {
          NodeFS.appendFileSync(
            requestLogPath,
            event.payload.endsWith("\n") ? event.payload : `${event.payload}\n`,
          );
        }
      }),
    onNotification: (notification) =>
      notification._tag === "ExtNotification" && notification.method === "session/cancel"
        ? Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)
        : Effect.void,
  });
  const notify = (method: string, params: unknown) =>
    transport.notify(method, params).pipe(Effect.orDie);
  const update = (value: AcpCompat.SessionNotification["update"]) =>
    notify("session/update", { sessionId, update: value });
  const handlers = rpcs.toLayer(
    rpcs.of({
      initialize: () =>
        Effect.succeed(
          nativeV2
            ? {
                protocolVersion: 2,
                info: { name: "grok-v2-native-fixture", version: "fixture" },
                capabilities: {},
              }
            : {
                // A V1 response can advertise 2; response shape decides generation.
                protocolVersion: 2,
                agentInfo: { name: "grok-v1-native-fixture", version: "fixture" },
                agentCapabilities: { loadSession: true },
              },
        ),
      authenticate: () => Effect.succeed({}),
      "session/new": () =>
        Effect.succeed(
          nativeV2
            ? { sessionId, configOptions: configOptions() }
            : process.env.T3_ACP_GROK_MODEL_UNAVAILABLE === "1"
              ? { sessionId }
              : { sessionId, models: modelState() },
        ),
      "session/load": () => Effect.succeed({ models: modelState() }),
      "session/set_model": (request) =>
        Effect.sync(() => {
          modelId = request.modelId;
          if (typeof request._meta?.reasoningEffort === "string")
            reasoningEffort = request._meta.reasoningEffort;
          return {};
        }),
      "session/set_config_option": (request) =>
        Effect.sync(() => {
          if (request.configId === "native-model-choice" && typeof request.value === "string")
            modelId = request.value;
          if (request.configId === "native-effort-choice" && typeof request.value === "string") {
            reasoningEffort =
              process.env.T3_ACP_GROK_EFFORT_MISMATCH === "1" ? "high" : request.value;
          }
          return { configOptions: configOptions() };
        }),
      "session/prompt": (request) =>
        Effect.gen(function* () {
          beginAcpMockPrompt(cancelledSessions, request.sessionId);
          cancelled = yield* Deferred.make<void>();
          if (
            process.env.T3_ACP_CRASH_PROMPT === "1" &&
            request.prompt.some((part) => part.type === "text" && part.text === "crash now")
          ) {
            return yield* Effect.sync(() => process.exit(23));
          }
          const promptId =
            typeof request._meta?.promptId === "string"
              ? request._meta.promptId
              : "mock-xai-prompt-1";
          if (process.env.T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG === "1") {
            yield* notify("_x.ai/session/prompt_complete", {
              sessionId,
              promptId,
              stopReason: "rate_limit",
              agentResult: null,
            });
            return yield* Deferred.await(cancelled).pipe(
              Effect.as({ stopReason: "cancelled" as const }),
            );
          }
          if (process.env.T3_ACP_EMIT_PLAN_THEN_HANG === "1") {
            yield* update({
              sessionUpdate: "plan",
              entries: [
                { content: "Wait for more ACP progress", priority: "high", status: "in_progress" },
              ],
            });
            return yield* Deferred.await(cancelled).pipe(
              Effect.as({ stopReason: "cancelled" as const }),
            );
          }
          if (process.env.T3_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL === "1") {
            const taskId = "01a05f41-5107-7550-821e-79e8d1cd7687";
            const description = "Watch count-sheet Typst unit until done";
            yield* update({
              sessionUpdate: "tool_call",
              toolCallId: "call-monitor-1",
              title: "monitor",
              kind: "other",
              status: "pending",
              rawInput: { description },
              _meta: {
                "x.ai/tool": { version: 1, name: "monitor", kind: "task", namespace: "grok_build" },
              },
            });
            yield* update({
              sessionUpdate: "tool_call_update",
              toolCallId: "call-monitor-1",
              status: "completed",
              rawInput: { description },
              rawOutput: { type: "Monitor", taskId, timeoutMs: 36_000_000 },
            });
            yield* notify("_x.ai/session/prompt_complete", {
              sessionId,
              promptId,
              stopReason: "end_turn",
              agentResult: null,
            });
            yield* Effect.sleep("120 millis");
            yield* update({
              sessionUpdate: "tool_call",
              toolCallId: "call-monitor-poll-1",
              title: "get_command_or_subagent_output",
              kind: "other",
              status: "completed",
              rawInput: { variant: "TaskOutput", task_ids: [taskId], timeout_ms: 0 },
              rawOutput: {
                type: "TaskOutput",
                Result: {
                  task_id: taskId,
                  command: `[monitor] ${description}`,
                  status: "completed",
                  exit_code: 0,
                  output: "Monitor finished.",
                },
              },
            });
            return yield* Deferred.await(cancelled).pipe(
              Effect.as({ stopReason: "cancelled" as const }),
            );
          }
          yield* update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from mock" },
          });
          if (nativeV2) {
            yield* notify("session/update", {
              sessionId,
              update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
            });
            return emptyPromptAcknowledgement;
          }
          return { stopReason: "end_turn" as const };
        }),
    }),
  );
  yield* RpcServer.make(rpcs).pipe(
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(handlers),
    Effect.forkScoped,
  );
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
