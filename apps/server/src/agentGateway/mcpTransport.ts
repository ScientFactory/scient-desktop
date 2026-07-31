/**
 * MCP streamable-HTTP transport for the Scient agent gateway.
 *
 * Owns the per-request auth spine: verify the bearer session, re-check that the
 * caller thread still exists and is still owned by the same provider, pin write
 * authority to the running turn observed at ingress, build the tool context,
 * then dispatch each JSON-RPC message in the batch. Every request re-checks
 * authorization; no grant is cached across requests.
 *
 * @module agentGateway/mcpTransport
 */
import { ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeScientOperationAuthority,
  SCIENT_OPERATION_DEFINITIONS,
  ScientOperationInputError,
  type ScientOperationAuthority,
} from "../scientOperations/authority.ts";
import type { ScientOperationExecutorShape } from "../scientOperations/Services/ScientOperationExecutor.ts";
import type { AgentGatewayShape } from "./Services/AgentGateway.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import { extractBearerToken } from "./bearerToken.ts";
import {
  buildMcpInitializeResult,
  jsonRpcError,
  jsonRpcResult,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  parseMcpMessage,
  type JsonRpcRequest,
  type McpToolCallResult,
} from "./protocol.ts";
import { errorText } from "./toolInput.ts";
import {
  GatewayToolError,
  gatewayToolFailureResult,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
  ToolInputError,
} from "./toolRuntime.ts";

const MCP_MAX_BATCH_MESSAGES = 50;

type ToolRequestBaseContext = Omit<
  ToolContext,
  | "admittedCaller"
  | "jsonRpcRequestId"
  | "operationEnvelope"
  | "operationRevocationFence"
  | "recordOperationEffect"
> & {
  readonly revocationFence: Effect.Effect<never, GatewayToolError>;
  readonly runTransactionalWrite: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | GatewayToolError>;
};

function toolResultErrorCode(result: {
  readonly content: ReadonlyArray<{ readonly text: string }>;
  readonly isError?: boolean;
}): string | null {
  if (!result.isError) return null;
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? "null") as {
      readonly error?: { readonly code?: unknown };
    };
    return typeof parsed.error?.code === "string" ? parsed.error.code : "tool_error";
  } catch {
    return "tool_error";
  }
}

export function makeAgentGatewayMcpTransport(input: {
  readonly credentials: AgentGatewayCredentialsShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly instructions: string;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
  readonly operationExecutor: ScientOperationExecutorShape;
}): AgentGatewayShape["handleMcpPost"] {
  const operationExecutor = input.operationExecutor;
  const toolsByName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));

  const handleRequest = (request: JsonRpcRequest, context: ToolRequestBaseContext) =>
    Effect.gen(function* () {
      switch (request.method) {
        case "initialize":
          return jsonRpcResult(
            request.id,
            buildMcpInitializeResult({
              requestedProtocolVersion: request.params.protocolVersion,
              serverVersion: "1.0.0",
              instructions: input.instructions,
            }),
          );
        case "ping":
          return jsonRpcResult(request.id, {});
        case "tools/list":
          return jsonRpcResult(request.id, {
            tools: input.tools.map((tool) => tool.definition),
          });
        case "tools/call": {
          const toolName = request.params.name;
          if (typeof toolName !== "string") {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
          }
          const tool = toolsByName.get(toolName);
          if (!tool) {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, `Unknown tool "${toolName}".`);
          }
          const rawArgs = request.params.arguments;
          const args =
            typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          const operation = SCIENT_OPERATION_DEFINITIONS[tool.operation];
          const canonicalizeDomainInput = operation.canonicalizeInput;
          if (canonicalizeDomainInput === null) {
            return jsonRpcResult(
              request.id,
              gatewayToolErrorResult(
                new GatewayToolError(
                  "operation_not_available",
                  "This Scient operation does not yet have an executable domain-input contract.",
                ),
              ),
            );
          }
          const decoded = yield* Effect.try({
            try: () => tool.decodeInput(args),
            catch: (error) => error,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          );
          if (!decoded.ok) {
            return jsonRpcResult(
              request.id,
              gatewayToolFailureResult(decoded.error, {
                operation: "decode_tool_input",
                toolName,
              }),
            );
          }
          const admissionEffect =
            operation.admission === "write-authority"
              ? context.requireCurrentCallerTurn()
              : context.requireCurrentOperationCaller();
          const outcome = yield* operationExecutor.execute<
            McpToolCallResult,
            OrchestrationThreadShell,
            GatewayToolError
          >({
            authority: context.operationAuthority,
            operation: tool.operation,
            projectId: context.callerProjectId,
            ingress: "provider-gateway",
            domainInput: decoded.value,
            admit: admissionEffect,
            execute: (canonicalInput, executionContext) => {
              const invocationContext: ToolContext = {
                ...context,
                admittedCaller: executionContext.admission,
                operationEnvelope: executionContext.envelope,
                operationRevocationFence: context.revocationFence,
                recordOperationEffect: executionContext.recordEffect,
                jsonRpcRequestId: request.id,
              };
              return Effect.suspend(() => tool.handler(canonicalInput, invocationContext)).pipe(
                Effect.catchDefect((defect) =>
                  Effect.succeed(
                    gatewayToolFailureResult(defect, {
                      operation: "tool_handler_defect",
                      toolName,
                    }),
                  ),
                ),
              );
            },
            releaseRead: () => context.requireCurrentOperationCaller().pipe(Effect.asVoid),
            runTransactionalWrite: (effect) => context.runTransactionalWrite(effect),
            revocationFence: context.revocationFence,
            resultErrorCode: toolResultErrorCode,
          });

          switch (outcome.kind) {
            case "input-rejected":
              return jsonRpcResult(
                request.id,
                gatewayToolFailureResult(
                  outcome.error instanceof ScientOperationInputError
                    ? new ToolInputError(outcome.error.message)
                    : outcome.error,
                  { operation: "canonicalize_tool_input", toolName },
                ),
              );
            case "authority-rejected":
              return jsonRpcResult(
                request.id,
                gatewayToolErrorResult(
                  new GatewayToolError(
                    outcome.decision.code,
                    outcome.decision.message,
                    outcome.decision.details,
                  ),
                ),
              );
            case "admission-rejected":
              return jsonRpcResult(request.id, gatewayToolErrorResult(outcome.error));
            case "execution-rejected":
              return jsonRpcResult(
                request.id,
                gatewayToolErrorResult(new GatewayToolError(outcome.code, outcome.message)),
              );
            case "finished":
              return jsonRpcResult(
                request.id,
                outcome.error === null ? outcome.result : gatewayToolFailureResult(outcome.error),
              );
          }
        }
        default:
          return jsonRpcError(
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Method "${request.method}" is not supported.`,
          );
      }
    });

  return (requestInput) =>
    Effect.gen(function* () {
      const token = extractBearerToken(requestInput.authorizationHeader);
      const callerSession = token ? input.credentials.verifySession(token) : null;
      if (!token || !callerSession) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
          ),
        };
      }
      const callerThreadId = callerSession.threadId;
      const callerThread = yield* input.snapshotQuery
        .getThreadShellById(ThreadId.makeUnsafe(callerThreadId))
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(callerThread)) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "Bearer token refers to a thread that no longer exists.",
          ),
        };
      }
      const liveProvider = callerThread.value.session?.providerName;
      if ((liveProvider ?? callerThread.value.modelSelection.provider) !== callerSession.provider) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Provider session no longer owns this thread.",
          ),
        };
      }
      const callerProjectId = callerThread.value.projectId;
      const operationAuthority: ScientOperationAuthority = makeScientOperationAuthority({
        authorityId: callerSession.sessionKey,
        generation: callerSession.sessionKey,
        actor: {
          kind: "provider-thread",
          threadId: callerThreadId,
          provider: callerSession.provider,
          sessionKey: callerSession.sessionKey,
        },
        projectIds: [callerProjectId],
        capabilities: callerSession.capabilities,
        issuedAt: callerSession.issuedAt,
        expiresAt: null,
        revokedAt: null,
      });
      const callerWriteAuthority =
        callerThread.value.latestTurn?.state === "running"
          ? input.credentials.bindWriteAuthority(token, callerThread.value.latestTurn.turnId)
          : null;
      const requireCurrentOperationCaller = () =>
        Effect.gen(function* () {
          const liveSession = input.credentials.verifySession(token);
          if (
            liveSession === null ||
            liveSession.sessionKey !== operationAuthority.generation ||
            liveSession.threadId !== callerSession.threadId ||
            liveSession.provider !== callerSession.provider
          ) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_session_inactive",
                "This Scient operation was rejected because its provider-session authority is no longer active.",
                { callerThreadId },
              ),
            );
          }
          const liveCaller = yield* input
            .requireThreadShell(callerThreadId)
            .pipe(
              Effect.mapError(
                () =>
                  new GatewayToolError(
                    "caller_session_inactive",
                    "This Scient operation was rejected because its caller thread could no longer be verified.",
                    { callerThreadId },
                  ),
              ),
            );
          const liveProvider =
            liveCaller.session?.providerName ?? liveCaller.modelSelection.provider;
          if (liveCaller.projectId !== callerProjectId || liveProvider !== callerSession.provider) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_session_inactive",
                "This Scient operation was rejected because its caller scope or provider ownership changed.",
                { callerThreadId },
              ),
            );
          }
          return liveCaller;
        });
      const requireCurrentCallerTurn = () =>
        Effect.gen(function* () {
          const caller = yield* requireCurrentOperationCaller();
          if (callerWriteAuthority === null) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Scient write was rejected because no caller turn was active when the MCP request arrived.",
                { callerThreadId },
              ),
            );
          }
          if (!input.credentials.verifyWriteAuthority(callerWriteAuthority)) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_session_inactive",
                "This Scient write was rejected because its provider-session authority is no longer active.",
                { callerThreadId },
              ),
            );
          }
          if (
            caller.latestTurn?.state !== "running" ||
            caller.latestTurn.turnId !== callerWriteAuthority.turnId
          ) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Scient write was rejected because the turn that received this MCP request is no longer active. In-flight requests cannot inherit authority from a later turn.",
                {
                  callerThreadId,
                  authorizedTurnId: callerWriteAuthority.turnId,
                  latestTurnId: caller.latestTurn?.turnId ?? null,
                  latestTurnState: caller.latestTurn?.state ?? null,
                },
              ),
            );
          }
          return caller;
        });
      const runTransactionalWrite = <A, E>(
        effect: Effect.Effect<A, E>,
      ): Effect.Effect<A, E | GatewayToolError> =>
        Effect.suspend((): Effect.Effect<A, E | GatewayToolError> => {
          if (callerWriteAuthority === null) {
            return Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Scient write was rejected because no caller turn was active when the MCP request arrived.",
                { callerThreadId },
              ),
            );
          }
          const lease = input.credentials.acquireWriteLease(callerWriteAuthority);
          if (lease === null) {
            return Effect.fail(
              new GatewayToolError(
                "caller_session_inactive",
                "This Scient write was rejected because its provider-session authority was revoked before the authoritative write began.",
                { callerThreadId },
              ),
            );
          }
          return Effect.uninterruptible(effect).pipe(Effect.ensuring(Effect.sync(lease.release)));
        });
      const revocationFence = Effect.callback<never, GatewayToolError>((resume) => {
        const cancelled = () =>
          Effect.fail(
            new GatewayToolError(
              "caller_session_inactive",
              "This Scient operation was cancelled because its provider-session authority was revoked.",
              { callerThreadId },
            ),
          );
        let unsubscribe: (() => void) | null = null;
        unsubscribe = input.credentials.subscribeSessionRevocations((identity) => {
          if (identity.sessionKey !== callerSession.sessionKey) return;
          unsubscribe?.();
          resume(cancelled());
        });
        // Subscribe before re-verifying so revocation cannot slip between the
        // initial bearer check and installation of the in-flight fence.
        const live = input.credentials.verifySession(token);
        if (live === null || live.sessionKey !== callerSession.sessionKey) {
          unsubscribe();
          resume(cancelled());
        }
        return Effect.sync(() => unsubscribe?.());
      });
      const context: ToolRequestBaseContext = {
        callerThreadId,
        callerProjectId,
        callerSessionKey: callerSession.sessionKey,
        callerProvider: callerSession.provider,
        operationAuthority,
        callerTurnId: callerWriteAuthority?.turnId ?? null,
        requireCurrentOperationCaller,
        requireCurrentCallerTurn,
        runTransactionalWrite,
        revocationFence,
      };

      const rawMessages = Array.isArray(requestInput.body)
        ? requestInput.body
        : [requestInput.body];
      if (rawMessages.length === 0) {
        return {
          status: 400,
          body: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Empty JSON-RPC batch."),
        };
      }
      if (rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return {
          status: 400,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
          ),
        };
      }
      const parsedMessages = rawMessages.map(parseMcpMessage);
      const requestIds = new Set<string>();
      for (const parsed of parsedMessages) {
        if (parsed.kind !== "request") continue;
        const key = `${typeof parsed.request.id}:${String(parsed.request.id)}`;
        if (requestIds.has(key)) {
          return {
            status: 400,
            body: jsonRpcError(
              parsed.request.id,
              JSON_RPC_INVALID_REQUEST,
              `Duplicate JSON-RPC request id ${JSON.stringify(parsed.request.id)} in one batch.`,
            ),
          };
        }
        requestIds.add(key);
      }
      const responses: Array<Record<string, unknown>> = [];
      for (const parsed of parsedMessages) {
        switch (parsed.kind) {
          case "request":
            responses.push(
              yield* handleRequest(parsed.request, context).pipe(
                Effect.catch((error) =>
                  Effect.succeed(jsonRpcResult(parsed.request.id, gatewayToolFailureResult(error))),
                ),
              ),
            );
            break;
          case "notification":
          case "response":
            break;
          case "invalid":
            responses.push(
              jsonRpcError(parsed.id, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC message."),
            );
            break;
        }
      }
      if (responses.length === 0) return { status: 202 };
      return {
        status: 200,
        body: Array.isArray(requestInput.body) ? responses : responses[0],
      };
    }).pipe(
      // The ingress pipeline above (bearer verify, thread/provider rechecks,
      // batch parsing) folds every typed failure into a JSON-RPC/HTTP result,
      // but a synchronous throw inside `Effect.gen` becomes a defect that those
      // `Effect.catch`es do not cover. Honor the documented "the effect never
      // fails" contract on `handleMcpPost` with a final defect net that returns
      // a generic 500 (detail logged server-side, never disclosed in the body).
      Effect.catchDefect((defect) =>
        Effect.logError("agent gateway request handling defected", {
          cause: errorText(defect),
        }).pipe(
          Effect.as({
            status: 500,
            body: jsonRpcError(
              null,
              JSON_RPC_INTERNAL_ERROR,
              "internal_error: The agent gateway failed to process the request.",
            ),
          }),
        ),
      ),
    );
}
