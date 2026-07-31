/**
 * Shared runtime types for agent gateway MCP tools.
 *
 * Defines the tool-context passed to every handler, the tool-entry shape the
 * transport dispatches on, and the structured error type gateway tools raise.
 * Kept dependency-free so tool modules and the transport share one contract.
 *
 * @module agentGateway/toolRuntime
 */
import type { OrchestrationThreadShell, ProviderKind } from "@synara/contracts";
import type { Effect } from "effect";

import { createLogger } from "../logger.ts";
import type {
  ScientOperationAuthority,
  ScientOperationEffectIdentity,
  ScientOperationId,
  ScientOperationRequestEnvelope,
} from "../scientOperations/authority.ts";
import {
  mcpToolResultError,
  mcpToolResultJson,
  type JsonRpcId,
  type McpToolCallResult,
  type McpToolDefinition,
} from "./protocol.ts";

const log = createLogger("agent-gateway");

export const UNEXPECTED_GATEWAY_TOOL_ERROR_MESSAGE = "The gateway tool failed unexpectedly.";

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export interface ToolContext {
  readonly callerThreadId: string;
  /**
   * Project the caller thread belongs to, captured at ingress. The central
   * authorization policy uses this as the project-scope floor so a read tool
   * cannot reach across projects.
   */
  readonly callerProjectId: string;
  readonly callerSessionKey: string;
  readonly callerProvider: ProviderKind;
  readonly operationAuthority: ScientOperationAuthority;
  readonly operationEnvelope: ScientOperationRequestEnvelope;
  readonly admittedCaller: OrchestrationThreadShell;
  readonly callerTurnId: string | null;
  readonly requireCurrentOperationCaller: () => Effect.Effect<
    OrchestrationThreadShell,
    GatewayToolError
  >;
  readonly requireCurrentCallerTurn: () => Effect.Effect<
    OrchestrationThreadShell,
    GatewayToolError
  >;
  /** Exact-session revocation fence for a protected transactional commit. */
  readonly operationRevocationFence: Effect.Effect<never, GatewayToolError>;
  readonly recordOperationEffect: (effect: ScientOperationEffectIdentity) => void;
  readonly jsonRpcRequestId: JsonRpcId;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<McpToolCallResult>;

export interface ToolEntry {
  readonly definition: McpToolDefinition;
  readonly operation: ScientOperationId;
  /** Decode this wire shape; the Scient operation registry performs domain canonicalization. */
  readonly decodeInput: (args: Record<string, unknown>) => Record<string, unknown>;
  readonly handler: ToolHandler;
}

export class GatewayToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** An authored argument-validation failure whose message is safe for the model. */
export class ToolInputError extends Error {}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\b(sk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/(?:\/Users|\/home)\/[^\s,;]+/g, "[redacted-path]")
    .replace(/[A-Z]:\\Users\\[^\s,;]+/gi, "[redacted-path]")
    .slice(0, 500);
}

function logUnexpectedGatewayFailure(error: unknown, context?: Record<string, unknown>) {
  const errorName = error instanceof Error ? error.name : typeof error;
  const errorMessage =
    error instanceof Error ? redactDiagnostic(error.message) : redactDiagnostic(String(error));
  log.error("unexpected gateway tool failure", {
    ...context,
    errorName,
    errorMessage,
  });
}

export function gatewayToolErrorResult(error: GatewayToolError) {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }),
    isError: true as const,
  };
}

/**
 * Keep authored policy/input failures useful without reflecting arbitrary
 * internal exception text across the provider boundary.
 */
export function gatewayToolFailureResult(error: unknown, context?: Record<string, unknown>) {
  if (error instanceof GatewayToolError) return gatewayToolErrorResult(error);
  if (error instanceof ToolInputError) return mcpToolResultError(error.message);
  logUnexpectedGatewayFailure(error, context);
  return mcpToolResultError(UNEXPECTED_GATEWAY_TOOL_ERROR_MESSAGE);
}

export function unexpectedGatewayToolError(
  cause?: unknown,
  context?: Record<string, unknown>,
): GatewayToolError {
  if (cause !== undefined) logUnexpectedGatewayFailure(cause, context);
  return new GatewayToolError("operation_failed", UNEXPECTED_GATEWAY_TOOL_ERROR_MESSAGE);
}
