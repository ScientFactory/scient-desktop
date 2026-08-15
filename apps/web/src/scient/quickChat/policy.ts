import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import type { EnvironmentId, TerminalOpenInput } from "@t3tools/contracts";
import { supportsScientQuickChatCapability } from "@t3tools/client-runtime/scient/quick-chat";

export {
  SCIENT_QUICK_CHAT_CAPABILITIES,
  SCIENT_QUICK_CHAT_LABEL,
  SCIENT_QUICK_CHAT_LEGACY_SEARCH_TERMS,
  SCIENT_QUICK_CHATS_LABEL,
  scientThreadAllowsCapability,
  supportsScientQuickChatCapability,
  supportsScientQuickChat,
} from "@t3tools/client-runtime/scient/quick-chat";

export function shouldAssignScientQuickChatNewThreadShortcut(input: {
  readonly hasQuickChatTarget: boolean;
  readonly hasProjectShortcutTarget: boolean;
}): boolean {
  return input.hasQuickChatTarget && !input.hasProjectShortcutTarget;
}

export function isScientQuickChatRightPanelKindAllowed(
  kind: "diff" | "files" | "file" | "preview" | "terminal" | "pull-request" | "agents" | "scient",
): boolean {
  switch (kind) {
    case "files":
    case "file":
      return supportsScientQuickChatCapability("files");
    case "preview":
      return supportsScientQuickChatCapability("browser");
    case "terminal":
      return supportsScientQuickChatCapability("terminal");
    case "agents":
      return supportsScientQuickChatCapability("agents");
    case "diff":
      return supportsScientQuickChatCapability("diff");
    case "pull-request":
      return supportsScientQuickChatCapability("pullRequests");
    case "scient":
      return false;
  }
}

/** Workspace-relative surfaces cannot be reinterpreted after relocation. */
export function shouldCloseSurfaceAfterScientQuickChatMove(
  kind: "diff" | "files" | "file" | "preview" | "terminal" | "pull-request" | "agents" | "scient",
): boolean {
  return (
    kind === "file" ||
    kind === "files" ||
    kind === "terminal" ||
    kind === "diff" ||
    kind === "pull-request" ||
    kind === "scient"
  );
}

/**
 * Chooses the environment for the dedicated Quick Chat create action.
 * Staying in the current environment preserves the user's context; the
 * primary environment is the predictable fallback when no thread is active.
 */
export function resolveScientQuickChatCreationEnvironment(input: {
  readonly activeEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly capableEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  const capable = new Set(input.capableEnvironmentIds);
  if (input.activeEnvironmentId !== null && capable.has(input.activeEnvironmentId)) {
    return input.activeEnvironmentId;
  }
  if (input.primaryEnvironmentId !== null && capable.has(input.primaryEnvironmentId)) {
    return input.primaryEnvironmentId;
  }
  return input.capableEnvironmentIds.length === 1 ? input.capableEnvironmentIds[0]! : null;
}

export interface ScientThreadTerminalTarget {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env: Record<string, string>;
}

/**
 * Resolves the terminal boundary for both project threads and Quick Chat.
 * Project threads retain T3's project/worktree environment. Quick Chat gets
 * a plain shell at its authoritative environment workspace and never inherits
 * project scripts or worktree metadata.
 */
export function resolveScientThreadTerminalTarget(input: {
  readonly activeWorkspaceRoot: string | null | undefined;
  readonly projectWorkspaceRoot: string | null | undefined;
  readonly gitCwd: string | null | undefined;
  readonly worktreePath: string | null | undefined;
}): ScientThreadTerminalTarget | null {
  if (input.projectWorkspaceRoot) {
    const worktreePath = input.worktreePath ?? null;
    return {
      cwd: input.gitCwd ?? input.projectWorkspaceRoot,
      worktreePath,
      env: projectScriptRuntimeEnv({
        project: { cwd: input.projectWorkspaceRoot },
        worktreePath,
      }),
    };
  }

  if (!input.activeWorkspaceRoot) return null;
  return {
    cwd: input.activeWorkspaceRoot,
    worktreePath: null,
    env: {},
  };
}

export function buildScientThreadTerminalOpenInput(input: {
  readonly target: ScientThreadTerminalTarget;
  readonly threadId: string;
  readonly terminalId: string;
}): TerminalOpenInput {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.target.cwd,
    ...(input.target.worktreePath !== null ? { worktreePath: input.target.worktreePath } : {}),
    env: input.target.env,
  };
}
