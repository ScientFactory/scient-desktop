import type { ServerConfig } from "@t3tools/contracts";

export const SCIENT_QUICK_CHAT_LABEL = "Quick chat";
export const SCIENT_QUICK_CHATS_LABEL = "Quick chats";
export const SCIENT_QUICK_CHAT_LEGACY_SEARCH_TERMS = ["general chat"] as const;

/**
 * Scient's product contract for a thread that is not attached to a project.
 * Keep this explicit so every client can make the same allow/deny decision
 * without inferring authority from the presence of a filesystem workspace.
 */
export const SCIENT_QUICK_CHAT_CAPABILITIES = {
  agents: true,
  browser: true,
  files: true,
  pdfs: true,
  search: true,
  moveToProject: true,
  terminal: true,
  checkpoints: false,
  diff: false,
  git: false,
  projectSettings: false,
  pullRequests: false,
  revert: false,
  scripts: false,
  worktrees: false,
} as const;

export type ScientQuickChatCapability = keyof typeof SCIENT_QUICK_CHAT_CAPABILITIES;

export function supportsScientQuickChatCapability(capability: ScientQuickChatCapability): boolean {
  return SCIENT_QUICK_CHAT_CAPABILITIES[capability];
}

/**
 * Applies the Scient policy only to a known Quick Chat. Project threads keep
 * the host platform's ordinary capability checks; a missing thread grants no
 * authority.
 */
export function scientThreadAllowsCapability(
  projectId: string | null | undefined,
  capability: ScientQuickChatCapability,
): boolean {
  if (projectId === undefined) return false;
  return projectId === null ? supportsScientQuickChatCapability(capability) : true;
}

export function supportsScientQuickChat(
  config: Pick<ServerConfig, "projectlessThreads"> | null | undefined,
): boolean {
  return config?.projectlessThreads === true;
}
