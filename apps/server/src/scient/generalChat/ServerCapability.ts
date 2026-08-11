/**
 * Scient owns the product decision to offer General Chat. The wire field keeps
 * its neutral compatibility name so clients remain forward-compatible with a
 * later official T3 projectless-thread implementation.
 */
export const SCIENT_GENERAL_CHAT_SERVER_CAPABILITIES = {
  projectlessThreads: true,
} as const;

/** Product-facing fallback used by server-originated activity surfaces. */
export const SCIENT_GENERAL_CHAT_SERVER_LABEL = "General chat";
