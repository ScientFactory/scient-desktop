// FILE: rpcRecoveryPolicy.ts
// Purpose: Defines and enforces the narrow set of RPCs that may replay after reconnection.
// Layer: Web transport recovery policy

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";

export type RpcRecoveryPolicy = "retry-on-new-generation" | "never-replay";

type KnownRpcMethod =
  | (typeof WS_METHODS)[keyof typeof WS_METHODS]
  | (typeof ORCHESTRATION_WS_METHODS)[keyof typeof ORCHESTRATION_WS_METHODS];

// This allowlist is intentionally conservative. A method belongs here only when
// running it twice cannot create, update, delete, launch user-visible work,
// acknowledge, or spend on the user's behalf. New methods inherit
// `never-replay` until reviewed.
const RETRYABLE_READ_METHODS: ReadonlySet<KnownRpcMethod> = new Set([
  WS_METHODS.projectsList,
  WS_METHODS.projectsDiscoverScripts,
  WS_METHODS.projectsListDirectories,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsSearchLocalEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsListDevServers,
  WS_METHODS.filesystemBrowse,
  WS_METHODS.gitGithubRepository,
  WS_METHODS.gitStatus,
  WS_METHODS.gitReadWorkingTreeDiff,
  WS_METHODS.gitListBranches,
  WS_METHODS.gitStashInfo,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverGetEnvironment,
  WS_METHODS.serverGetSettings,
  WS_METHODS.serverListWorktrees,
  WS_METHODS.serverListLocalServers,
  WS_METHODS.serverGetProviderUsageSnapshot,
  WS_METHODS.statsGetProfileStats,
  WS_METHODS.statsGetProfileTokenStats,
  WS_METHODS.serverGetDiagnostics,
  WS_METHODS.automationList,
  ORCHESTRATION_WS_METHODS.getSnapshot,
  ORCHESTRATION_WS_METHODS.getShellSnapshot,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_WS_METHODS.replayEvents,
]);

export function rpcRecoveryPolicyFor(method: string): RpcRecoveryPolicy {
  return RETRYABLE_READ_METHODS.has(method as KnownRpcMethod)
    ? "retry-on-new-generation"
    : "never-replay";
}

export interface RpcRecoverySession {
  readonly generation: number;
}

const SOCKET_ERROR_REASONS = new Set([
  "SocketReadError",
  "SocketWriteError",
  "SocketOpenError",
  "SocketCloseError",
]);

function taggedReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("reason" in value)) return null;
  const reason = value.reason;
  if (!reason || typeof reason !== "object" || !("_tag" in reason)) return null;
  return typeof reason._tag === "string" ? reason._tag : null;
}

/**
 * Recognizes Effect's structured socket failures without guessing from message
 * text. In particular, application and Git timeouts are not transport failures.
 */
export function isRpcTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("_tag" in error)) return false;
  if (error._tag !== "RpcClientError" && error._tag !== "SocketError") return false;
  const reason = taggedReason(error);
  return reason !== null && SOCKET_ERROR_REASONS.has(reason);
}

/**
 * Runs one RPC attempt and, for reviewed reads only, permits exactly one replay
 * when recovery produces a different connection generation.
 */
export async function runRpcWithRecovery<TSession extends RpcRecoverySession, TResult>(input: {
  readonly method: string;
  readonly session: TSession;
  readonly run: (session: TSession) => Promise<TResult>;
  readonly shouldRecover: (error: unknown) => boolean;
  readonly recover: (session: TSession, error: unknown) => Promise<TSession | null>;
}): Promise<TResult> {
  try {
    return await input.run(input.session);
  } catch (error) {
    if (rpcRecoveryPolicyFor(input.method) === "never-replay" || !input.shouldRecover(error)) {
      throw error;
    }
    const replacement = await input.recover(input.session, error);
    if (!replacement || replacement.generation === input.session.generation) throw error;
    return input.run(replacement);
  }
}
