/**
 * Drive MCP tools for the Scient agent gateway.
 *
 * Serves the two coordination *writes* an agent uses to drive a sibling thread
 * in its own project: `scient_send_message` (queue or steer a turn) and
 * `scient_interrupt_thread` (stop the running turn). Both funnel through the
 * central {@link authorizeThreadDrive} policy (project scope + privilege and
 * worktree caps) and both are flagged `requiresActiveTurn`, so the transport
 * only admits them while the caller's own turn is live (see
 * {@link makeAgentGatewayMcpTransport}). Cross-project and higher-privilege
 * drives are denied.
 *
 * `scient_send_message` accepts an optional `requestId` for idempotency: a
 * transport retry carrying the same id returns the prior outcome without
 * dispatching a second turn. The dedup is a bounded in-memory map (this slice's
 * right-sized guard, not the durable creation saga), backed up by a
 * deterministic command id derived from the request id so the orchestration
 * command-receipt layer also collapses a duplicate that races past the map.
 *
 * @module agentGateway/threadWriteTools
 */
import { createHash, randomUUID } from "node:crypto";

import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
  type TurnDispatchMode,
} from "@synara/contracts";
import { Cause, Effect, Option } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { authorizeThreadDrive } from "./authorization.ts";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import { readStringArg, ToolInputError } from "./toolInput.ts";
import {
  gatewayToolFailureResult,
  gatewayToolErrorResult,
  GatewayToolError,
  unexpectedGatewayToolError,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

/**
 * Cap on the idempotency map. Each provider runtime is short-lived and drives at
 * human pace, so a few hundred remembered sends comfortably covers realistic
 * retry windows while bounding memory. Eviction is insertion-order (oldest
 * first), which for a retry burst keeps the most recently issued ids.
 */
const SEND_DEDUP_MAX_ENTRIES = 512;
const SEND_REQUEST_ID_MAX_UTF8_BYTES = 256;
const SEND_MESSAGE_MAX_UTF8_BYTES = 512 * 1024;

interface SendResultPayload {
  readonly threadId: string;
  readonly dispatched: TurnDispatchMode;
  readonly requestId: string | null;
}

interface CompletedSendDedupEntry {
  readonly state: "completed";
  readonly fingerprint: string;
  readonly payload: SendResultPayload;
}

interface PendingSendResolution {
  readonly payload?: SendResultPayload;
  readonly failure?: McpToolCallResult;
}

interface PendingSendDedupEntry {
  readonly state: "pending";
  readonly fingerprint: string;
  readonly resolution: Promise<PendingSendResolution>;
  readonly resolve: (resolution: PendingSendResolution) => void;
}

type SendDedupEntry = CompletedSendDedupEntry | PendingSendDedupEntry;

function idempotencyIdentity(sessionKey: string, requestId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionKey, requestId]))
    .digest("hex")
    .slice(0, 32);
}

export interface ThreadWriteToolsInput {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
  /** Injectable clock (ISO-8601). Defaults to the wall clock. */
  readonly now?: () => string;
  /** Injectable id source for non-idempotent commands. Defaults to a UUID. */
  readonly randomId?: () => string;
}

export function makeThreadWriteTools(input: ThreadWriteToolsInput): ReadonlyArray<ToolEntry> {
  const { snapshotQuery, orchestrationEngine, requireThreadShell } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const randomId = input.randomId ?? randomUUID;

  const sendDedup = new Map<string, SendDedupEntry>();
  const rememberSend = (key: string, entry: SendDedupEntry) => {
    sendDedup.set(key, entry);
    while (sendDedup.size > SEND_DEDUP_MAX_ENTRIES) {
      const oldestCompleted = [...sendDedup].find(
        ([, candidate]) => candidate.state === "completed",
      );
      if (oldestCompleted === undefined) break;
      sendDedup.delete(oldestCompleted[0]);
    }
  };

  const reserveSend = (key: string, fingerprint: string): PendingSendDedupEntry | null => {
    if (sendDedup.size >= SEND_DEDUP_MAX_ENTRIES) {
      const oldestCompleted = [...sendDedup].find(
        ([, candidate]) => candidate.state === "completed",
      );
      if (oldestCompleted === undefined) return null;
      sendDedup.delete(oldestCompleted[0]);
    }
    let resolve!: (resolution: PendingSendResolution) => void;
    const resolution = new Promise<PendingSendResolution>((complete) => {
      resolve = complete;
    });
    const entry: PendingSendDedupEntry = {
      state: "pending",
      fingerprint,
      resolution,
      resolve,
    };
    sendDedup.set(key, entry);
    return entry;
  };

  // Resolve a target thread by id. A missing target denies as thread_not_found;
  // a cross-project (but existing) target resolves here and is denied by the
  // drive policy with the same code, so the caller cannot distinguish the two.
  const resolveTarget = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.mapError((error) =>
        unexpectedGatewayToolError(error, { operation: "resolve_drive_target" }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new GatewayToolError("thread_not_found", `Thread "${threadId}" was not found.`),
            ),
          onSome: (shell) => Effect.succeed(shell),
        }),
      ),
    );

  const authorizeDrive = (
    context: { readonly callerProjectId: string },
    caller: OrchestrationThreadShell,
    target: OrchestrationThreadShell,
    targetThreadId: string,
  ) =>
    authorizeThreadDrive({
      callerProjectId: context.callerProjectId,
      targetThreadId,
      targetProjectId: target.projectId,
      callerRuntimeMode: caller.runtimeMode,
      // envMode carries a "local" decoding default, but its decoded type still
      // admits undefined, so coalesce to the same default the schema applies.
      callerEnvMode: caller.envMode ?? "local",
      targetRuntimeMode: target.runtimeMode,
      targetEnvMode: target.envMode ?? "local",
    });

  const sendMessage: ToolEntry = {
    requiresActiveTurn: true,
    definition: {
      name: "scient_send_message",
      description:
        'Send a follow-up message to another Scient thread in your project. mode "queue" (default) appends the message to run after the thread\'s current turn; mode "steer" redirects a running turn where the provider supports it (otherwise the host queues it). Pass a stable requestId to make retries idempotent (the same id never sends twice). You can only drive threads in your own project, and not ones running at a higher privilege than yours.',
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Target thread to message." },
          message: { type: "string", description: "Message text to deliver." },
          mode: {
            type: "string",
            enum: ["queue", "steer"],
            description: 'Dispatch mode; defaults to "queue".',
          },
          requestId: {
            type: "string",
            description: "Optional idempotency key; a retry with the same id will not send twice.",
          },
        },
        required: ["threadId", "message"],
        additionalProperties: false,
      },
      annotations: { title: "Send a Scient message", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const message = readStringArg(args, "message", {
          required: true,
          maxUtf8Bytes: SEND_MESSAGE_MAX_UTF8_BYTES,
        })!;
        const modeArg = readStringArg(args, "mode") ?? "queue";
        if (modeArg !== "queue" && modeArg !== "steer") {
          throw new ToolInputError('Argument "mode" must be "queue" or "steer".');
        }
        const requestId = readStringArg(args, "requestId", {
          maxUtf8Bytes: SEND_REQUEST_ID_MAX_UTF8_BYTES,
        });

        const dispatchMode: TurnDispatchMode = modeArg;
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([threadId, message, dispatchMode]))
          .digest("hex");
        // Replay identity belongs to the concrete provider session, not merely
        // its thread: a replacement runtime must never inherit stale success.
        const dedupKey =
          requestId === undefined ? null : idempotencyIdentity(context.callerSessionKey, requestId);
        let reservation: PendingSendDedupEntry | null = null;
        if (dedupKey !== null) {
          const prior = sendDedup.get(dedupKey);
          if (prior !== undefined) {
            if (prior.fingerprint !== fingerprint) {
              return gatewayToolErrorResult(
                new GatewayToolError(
                  "idempotency_conflict",
                  "This requestId was already used for a different send operation in this provider session.",
                ),
              );
            }
            if (prior.state === "completed") {
              return mcpToolResultJson({ ...prior.payload, deduplicated: true });
            }
            const concurrent = yield* Effect.promise(() => prior.resolution);
            if (concurrent.failure !== undefined) return concurrent.failure;
            return mcpToolResultJson({ ...concurrent.payload!, deduplicated: true });
          }
          reservation = reserveSend(dedupKey, fingerprint);
          if (reservation === null) {
            return gatewayToolErrorResult(
              new GatewayToolError(
                "gateway_busy",
                "Too many send operations are currently pending. Retry shortly.",
              ),
            );
          }
        }

        const attempt = yield* Effect.gen(function* () {
          const caller = yield* requireThreadShell(context.callerThreadId);
          const target = yield* resolveTarget(threadId);
          const decision = authorizeDrive(context, caller, target, threadId);
          if (!decision.allow) {
            return {
              failure: gatewayToolErrorResult(
                new GatewayToolError(decision.code, decision.message),
              ),
            } satisfies PendingSendResolution;
          }

          const commandSuffix =
            requestId === undefined
              ? randomId()
              : idempotencyIdentity(context.callerSessionKey, requestId);
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`agent:${commandSuffix}:send`),
              threadId: target.id,
              message: {
                messageId: MessageId.makeUnsafe(`agent:${commandSuffix}:message`),
                role: "user",
                text: message,
                attachments: [],
              },
              dispatchMode,
              dispatchOrigin: "agent",
              runtimeMode: target.runtimeMode,
              interactionMode: target.interactionMode,
              createdAt: now(),
            })
            .pipe(
              Effect.mapError((error) =>
                unexpectedGatewayToolError(error, { operation: "send_message_dispatch" }),
              ),
            );

          return {
            payload: {
              threadId: target.id,
              dispatched: dispatchMode,
              requestId: requestId ?? null,
            },
          } satisfies PendingSendResolution;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              failure: gatewayToolFailureResult(Cause.squash(cause)),
            } satisfies PendingSendResolution),
          ),
        );

        if (attempt.failure !== undefined) {
          if (
            dedupKey !== null &&
            reservation !== null &&
            sendDedup.get(dedupKey) === reservation
          ) {
            sendDedup.delete(dedupKey);
            reservation.resolve(attempt);
          }
          return attempt.failure;
        }

        const payload = attempt.payload!;
        if (dedupKey !== null && reservation !== null) {
          rememberSend(dedupKey, { state: "completed", fingerprint, payload });
          reservation.resolve(attempt);
        }
        return mcpToolResultJson({ ...payload, deduplicated: false });
      }).pipe(Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error)))),
  };

  const interruptThread: ToolEntry = {
    requiresActiveTurn: true,
    definition: {
      name: "scient_interrupt_thread",
      description:
        "Interrupt the currently running turn of another Scient thread in your project. If the thread has no running turn this is a no-op and reports interrupted: false. You can only drive threads in your own project, and not ones running at a higher privilege than yours.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread whose running turn should be stopped." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Interrupt a Scient thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* resolveTarget(threadId);
        const decision = authorizeDrive(context, caller, target, threadId);
        if (!decision.allow) {
          return gatewayToolErrorResult(new GatewayToolError(decision.code, decision.message));
        }

        const runningTurnId =
          target.latestTurn?.state === "running" ? target.latestTurn.turnId : null;
        if (runningTurnId === null) {
          // Nothing to interrupt. Deliberately do not dispatch an unpinned
          // interrupt: it could catch a later turn that starts after this read.
          return mcpToolResultJson({
            threadId: target.id,
            interrupted: false,
            reason: "no_active_turn",
          });
        }
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            // Pin to the observed turn so a retry (or a turn that ends first) can
            // never interrupt a different, later turn; the id is deterministic so
            // the receipt layer collapses duplicate interrupts of the same turn.
            commandId: CommandId.makeUnsafe(`agent:${target.id}:${runningTurnId}:interrupt`),
            threadId: target.id,
            turnId: runningTurnId,
            createdAt: now(),
          })
          .pipe(
            Effect.mapError((error) =>
              unexpectedGatewayToolError(error, { operation: "interrupt_thread_dispatch" }),
            ),
          );
        return mcpToolResultJson({
          threadId: target.id,
          interrupted: true,
          turnId: runningTurnId,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error)))),
  };

  return [sendMessage, interruptThread];
}
