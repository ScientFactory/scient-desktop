/**
 * Central, default-deny authorization for agent gateway tools.
 *
 * Every gateway tool that touches a specific target thread funnels its decision
 * through this module rather than scattering scope checks across handlers. The
 * read slice enforces one rule: a caller may only observe threads in its own
 * project. "Same project" is the security floor, not the whole story — later
 * slices extend this with `authorizeThreadDrive` (runtimeMode/envMode drive
 * caps, thread-type rules) that plug in alongside the read gate here.
 *
 * The gateway is a host-served MCP surface reachable by provider child
 * processes, so a missing/ambiguous target must deny, never fall through.
 *
 * @module agentGateway/authorization
 */
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
