import { AuthOrchestrationOperateScope, type AuthSessionState } from "@t3tools/contracts";

/** Whether the current session may change provider state on an environment. */
export type ProviderOperateAccess = "granted" | "denied" | "pending";

/**
 * Resolve operate access from an environment's `/api/auth/session` answer.
 * Cached session data wins over an in-flight SWR revalidation so a usable
 * surface does not flicker back to loading while permissions refresh.
 */
function resolveSessionOperateAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly missingScopesAccess: "granted" | "denied";
}): ProviderOperateAccess {
  if (input.session === null) {
    if (input.isPending) return "pending";
    // Transport failure is not a permission decision. The RPC boundary still
    // rejects unauthorized writes, so remain optimistic rather than lying.
    return input.hasError ? "granted" : "denied";
  }
  if (!input.session.authenticated) return "denied";
  if (input.session.scopes === undefined) return input.missingScopesAccess;
  return input.session.scopes.includes(AuthOrchestrationOperateScope) ? "granted" : "denied";
}

/** Operate access for the primary environment's own browser session. */
export function resolvePrimaryOperateAccess(input: {
  readonly isPrimary: boolean;
  readonly hasDesktopBridge: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  if (!input.isPrimary || input.hasDesktopBridge) return "granted";
  return resolveSessionOperateAccess({
    session: input.session,
    isPending: input.isPending,
    hasError: input.hasError,
    missingScopesAccess: "denied",
  });
}

/** Operate access reported by a non-primary environment. */
export function resolveRemoteOperateAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  return resolveSessionOperateAccess({
    ...input,
    // Older remote servers predate scope reporting. Their RPC boundary
    // remains authoritative, so absence is not treated as denial.
    missingScopesAccess: "granted",
  });
}
