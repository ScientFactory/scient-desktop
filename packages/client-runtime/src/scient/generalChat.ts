import type { ServerConfig } from "@t3tools/contracts";

export const SCIENT_GENERAL_CHAT_LABEL = "General chat";

/**
 * Scient's product contract for a thread that is not attached to a project.
 * Keep this explicit so every client can make the same allow/deny decision
 * without inferring authority from the presence of a filesystem workspace.
 */
export const SCIENT_GENERAL_CHAT_CAPABILITIES = {
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

export type ScientGeneralChatCapability = keyof typeof SCIENT_GENERAL_CHAT_CAPABILITIES;

export function supportsScientGeneralChatCapability(
  capability: ScientGeneralChatCapability,
): boolean {
  return SCIENT_GENERAL_CHAT_CAPABILITIES[capability];
}

/**
 * Applies the Scient policy only to a known General Chat. Project threads keep
 * the host platform's ordinary capability checks; a missing thread grants no
 * authority.
 */
export function scientThreadAllowsCapability(
  projectId: string | null | undefined,
  capability: ScientGeneralChatCapability,
): boolean {
  if (projectId === undefined) return false;
  return projectId === null ? supportsScientGeneralChatCapability(capability) : true;
}

export function supportsScientGeneralChat(
  config: Pick<ServerConfig, "projectlessThreads"> | null | undefined,
): boolean {
  return config?.projectlessThreads === true;
}
