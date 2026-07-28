/**
 * Shared runtime types for agent gateway MCP tools.
 *
 * Defines the tool-context passed to every handler, the tool-entry shape the
 * transport dispatches on, and the structured error type gateway tools raise.
 * Kept dependency-free so tool modules and the transport share one contract.
 *
 * @module agentGateway/toolRuntime
 */
import type { ProviderKind } from "@synara/contracts";
import type { Effect } from "effect";

import {
  mcpToolResultError,
  mcpToolResultJson,
  type JsonRpcId,
  type McpToolCallResult,
  type McpToolDefinition,
} from "./protocol.ts";

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
  readonly callerCapabilities: ReadonlySet<"thread:read" | "thread:write" | "automation:write">;
  readonly callerTurnId: string | null;
  readonly assertCallerTurnActive: () => Effect.Effect<void, GatewayToolError>;
  readonly jsonRpcRequestId: JsonRpcId;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<McpToolCallResult>;

export interface ToolEntry {
  readonly definition: McpToolDefinition;
  readonly handler: ToolHandler;
  readonly requiresActiveTurn?: boolean;
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
export function gatewayToolFailureResult(error: unknown) {
  if (error instanceof GatewayToolError) return gatewayToolErrorResult(error);
  if (error instanceof ToolInputError) return mcpToolResultError(error.message);
  return mcpToolResultError(UNEXPECTED_GATEWAY_TOOL_ERROR_MESSAGE);
}

export function unexpectedGatewayToolError(): GatewayToolError {
  return new GatewayToolError("operation_failed", UNEXPECTED_GATEWAY_TOOL_ERROR_MESSAGE);
}
