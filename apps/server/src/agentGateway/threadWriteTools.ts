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
import { defineScientOperation } from "../scientOperations/authority.ts";
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
 * retry windows while bounding memory. Completed claims live for the exact
 * provider session and are cleared on credential revocation; they are never
 * evicted while that session remains live, preserving request-id semantics.
 */
const SEND_DEDUP_MAX_ENTRIES = 512;
const SEND_MAX_PENDING_PER_SESSION = 16;
const SEND_MAX_PENDING_BYTES_PER_SESSION = 4 * 1024 * 1024;
const SEND_REQUEST_ID_MAX_UTF8_BYTES = 256;
const SEND_MESSAGE_MAX_UTF8_BYTES = 512 * 1024;
const PROVIDER_THREAD_ACTOR = ["provider-thread"] as const;
const SEND_MESSAGE_OPERATION = defineScientOperation({
  id: "thread.message.send",
  capability: "thread:drive",
  allowedActorKinds: PROVIDER_THREAD_ACTOR,
  idempotencyInputField: "requestId",
});
const INTERRUPT_THREAD_OPERATION = defineScientOperation({
  id: "thread.interrupt",
  capability: "thread:drive",
  allowedActorKinds: PROVIDER_THREAD_ACTOR,
});

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
  /** Injectable clock (ISO-8601). Defaults to the wall clock. */
  readonly now?: () => string;
  /** Injectable id source for non-idempotent commands. Defaults to a UUID. */
  readonly randomId?: () => string;
  readonly subscribeSessionRevocations?: (
    listener: (identity: { readonly sessionKey: string }) => void,
  ) => () => void;
}

function protectedThreadOperationState(thread: OrchestrationThreadShell) {
  return {
    projectId: thread.projectId,
    runtimeMode: thread.runtimeMode,
    envMode: thread.envMode ?? "local",
    interactionMode: thread.interactionMode,
    provider: thread.session?.providerName ?? thread.modelSelection.provider,
    sessionStatus: thread.session?.status ?? null,
    activeTurnId: thread.session?.activeTurnId ?? null,
    latestTurnId: thread.latestTurn?.turnId ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
  };
}

export function makeThreadWriteTools(input: ThreadWriteToolsInput): ReadonlyArray<ToolEntry> {
  const { snapshotQuery, orchestrationEngine } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const randomId = input.randomId ?? randomUUID;

  const sendDedupBySession = new Map<string, Map<string, SendDedupEntry>>();
  const pendingBySession = new Map<string, { count: number; bytes: number }>();
  const getSessionDedup = (sessionKey: string) => {
    const existing = sendDedupBySession.get(sessionKey);
    if (existing !== undefined) return existing;
    const created = new Map<string, SendDedupEntry>();
    sendDedupBySession.set(sessionKey, created);
    return created;
  };
  void input.subscribeSessionRevocations?.((identity) => {
    sendDedupBySession.delete(identity.sessionKey);
    pendingBySession.delete(identity.sessionKey);
  });

  const reserveSend = (
    sessionDedup: Map<string, SendDedupEntry>,
    key: string,
    fingerprint: string,
  ): PendingSendDedupEntry | null => {
    if (sessionDedup.size >= SEND_DEDUP_MAX_ENTRIES) return null;
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
    sessionDedup.set(key, entry);
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

  const operationPrecondition = (
    actor: OrchestrationThreadShell,
    target: OrchestrationThreadShell,
  ) => ({
    actorThreadId: actor.id,
    actor: protectedThreadOperationState(actor),
    target: protectedThreadOperationState(target),
  });

  const sendMessage: ToolEntry = {
    operation: SEND_MESSAGE_OPERATION,
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
      Effect.suspend(() => {
        const pendingBytes =
          typeof args.message === "string" ? Buffer.byteLength(args.message, "utf8") : 0;
        const pending = pendingBySession.get(context.callerSessionKey) ?? { count: 0, bytes: 0 };
        if (
          pending.count >= SEND_MAX_PENDING_PER_SESSION ||
          pending.bytes + pendingBytes > SEND_MAX_PENDING_BYTES_PER_SESSION
        ) {
          return Effect.succeed(
            gatewayToolErrorResult(
              new GatewayToolError(
                "gateway_busy",
                "Too many send operations are currently pending. Retry shortly.",
              ),
            ),
          );
        }
        pending.count += 1;
        pending.bytes += pendingBytes;
        pendingBySession.set(context.callerSessionKey, pending);

        return Effect.gen(function* () {
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
            requestId === undefined
              ? null
              : idempotencyIdentity(context.callerSessionKey, requestId);
          const sessionDedup = getSessionDedup(context.callerSessionKey);
          let reservation: PendingSendDedupEntry | null = null;
          if (dedupKey !== null) {
            const prior = sessionDedup.get(dedupKey);
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
            reservation = reserveSend(sessionDedup, dedupKey, fingerprint);
            if (reservation === null) {
              return gatewayToolErrorResult(
                new GatewayToolError(
                  "gateway_busy",
                  "This provider session has reached its idempotency-history limit.",
                ),
              );
            }
          }

          const attempt = yield* Effect.gen(function* () {
            const caller = yield* context.requireCurrentCallerTurn();
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
            const commandId = CommandId.makeUnsafe(`agent:${commandSuffix}:send`);
            yield* orchestrationEngine
              .dispatch({
                type: "thread.turn.start",
                commandId,
                threadId: target.id,
                message: {
                  messageId: MessageId.makeUnsafe(`agent:${commandSuffix}:message`),
                  role: "user",
                  text: message,
                  attachments: [],
                },
                dispatchMode,
                dispatchSource: "agent",
                runtimeMode: target.runtimeMode,
                interactionMode: target.interactionMode,
                operationPrecondition: operationPrecondition(caller, target),
                createdAt: now(),
              })
              .pipe(
                Effect.mapError((error) =>
                  unexpectedGatewayToolError(error, { operation: "send_message_dispatch" }),
                ),
              );
            context.recordOperationEffect({
              kind: "orchestration-command",
              identity: commandId,
            });

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
              sessionDedup.get(dedupKey) === reservation
            ) {
              sessionDedup.delete(dedupKey);
              reservation.resolve(attempt);
            }
            return attempt.failure;
          }

          const payload = attempt.payload!;
          if (dedupKey !== null && reservation !== null) {
            sessionDedup.set(dedupKey, { state: "completed", fingerprint, payload });
            reservation.resolve(attempt);
          }
          return mcpToolResultJson({ ...payload, deduplicated: false });
        }).pipe(
          Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error))),
          Effect.ensuring(
            Effect.sync(() => {
              pending.count -= 1;
              pending.bytes -= pendingBytes;
              if (pending.count === 0) pendingBySession.delete(context.callerSessionKey);
            }),
          ),
        );
      }),
  };

  const interruptThread: ToolEntry = {
    operation: INTERRUPT_THREAD_OPERATION,
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
        const caller = yield* context.requireCurrentCallerTurn();
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
        const commandId = CommandId.makeUnsafe(`agent:${target.id}:${runningTurnId}:interrupt`);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            // Pin to the observed turn so a retry (or a turn that ends first) can
            // never interrupt a different, later turn; the id is deterministic so
            // the receipt layer collapses duplicate interrupts of the same turn.
            commandId,
            threadId: target.id,
            turnId: runningTurnId,
            operationPrecondition: operationPrecondition(caller, target),
            createdAt: now(),
          })
          .pipe(
            Effect.mapError((error) =>
              unexpectedGatewayToolError(error, { operation: "interrupt_thread_dispatch" }),
            ),
          );
        context.recordOperationEffect({ kind: "orchestration-command", identity: commandId });
        return mcpToolResultJson({
          threadId: target.id,
          interrupted: true,
          turnId: runningTurnId,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error)))),
  };

  return [sendMessage, interruptThread];
}
