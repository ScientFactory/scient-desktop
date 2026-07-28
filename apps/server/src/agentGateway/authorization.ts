/**
 * Central, default-deny authorization for agent gateway tools.
 *
 * Every gateway tool that touches a specific target thread funnels its decision
 * through this module rather than scattering scope checks across handlers. The
 * read slice enforces one rule: a caller may only observe threads in its own
 * project. "Same project" is the security floor, not the whole story — the drive
 * slice adds {@link authorizeThreadDrive} (privilege and worktree caps) that
 * composes on top of the same project-scope floor enforced for reads.
 *
 * The gateway is a host-served MCP surface reachable by provider child
 * processes, so a missing/ambiguous target must deny, never fall through.
 *
 * @module agentGateway/authorization
 */
import type { RuntimeMode, ThreadEnvironmentMode } from "@synara/contracts";

import type { SynaraGatewayErrorCode } from "./contract.ts";

export type GatewayAuthorizationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: SynaraGatewayErrorCode; readonly message: string };

/**
 * Decide whether a caller may read a specific target thread. Cross-project
 * reads are denied. The target project id is resolved from the target thread's
 * own shell/detail before this is called; an absent target is the caller's
 * responsibility to surface as `thread_not_found`.
 */
export function authorizeThreadRead(input: {
  readonly callerProjectId: string;
  readonly targetThreadId: string;
  readonly targetProjectId: string;
}): GatewayAuthorizationDecision {
  if (input.targetProjectId !== input.callerProjectId) {
    return {
      allow: false,
      // Deliberately does not disclose the target's project: the caller is not
      // authorized to learn anything about threads outside its own project.
      code: "thread_not_found",
      message: `Thread "${input.targetThreadId}" was not found.`,
    };
  }
  return { allow: true };
}

/**
 * Decide whether a caller may drive (message/interrupt) a specific target
 * thread. This is the read floor plus two privilege caps lifted from the donor's
 * `assertCallerMayDriveThread`, kept here so every drive tool funnels through one
 * policy:
 *
 * 1. Project scope — a caller can only ever drive threads in its own project.
 *    Cross-project targets deny as `thread_not_found` (same non-disclosure rule
 *    as {@link authorizeThreadRead}); the target's existence is never revealed.
 * 2. Privilege cap — an `approval-required` caller cannot drive a `full-access`
 *    target. Driving a higher-privileged thread would let a sandboxed agent
 *    launder actions through one that can act without approval.
 * 3. Worktree cap — a caller isolated in a worktree cannot drive a thread on the
 *    shared local checkout. A worktree agent must not reach out of its isolation
 *    to mutate the shared working tree via another thread.
 *
 * The caller thread itself is trusted to exist (its shell is verified at
 * ingress); only the target must be resolved and scope-checked here.
 */
export function authorizeThreadDrive(input: {
  readonly callerProjectId: string;
  readonly targetThreadId: string;
  readonly targetProjectId: string;
  readonly callerRuntimeMode: RuntimeMode;
  readonly callerEnvMode: ThreadEnvironmentMode;
  readonly targetRuntimeMode: RuntimeMode;
  readonly targetEnvMode: ThreadEnvironmentMode;
}): GatewayAuthorizationDecision {
  if (input.targetProjectId !== input.callerProjectId) {
    return {
      allow: false,
      code: "thread_not_found",
      message: `Thread "${input.targetThreadId}" was not found.`,
    };
  }
  if (input.targetRuntimeMode === "full-access" && input.callerRuntimeMode !== "full-access") {
    return {
      allow: false,
      code: "capability_denied",
      message: `Thread "${input.targetThreadId}" runs in "full-access" mode but your thread is "approval-required"; you cannot drive higher-privileged threads. Ask the user to do this or to elevate your thread.`,
    };
  }
  if (input.callerEnvMode === "worktree" && input.targetEnvMode === "local") {
    return {
      allow: false,
      code: "capability_denied",
      message: `Thread "${input.targetThreadId}" runs on the shared local checkout but your thread is isolated in a worktree; you cannot drive local-checkout threads. Ask the user to do this from a local thread.`,
    };
  }
  return { allow: true };
}
