import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import type { EnvironmentId, TerminalOpenInput } from "@t3tools/contracts";
import { supportsScientGeneralChatCapability } from "@t3tools/client-runtime/scient/general-chat";

export {
  SCIENT_GENERAL_CHAT_CAPABILITIES,
  SCIENT_GENERAL_CHAT_LABEL,
  scientThreadAllowsCapability,
  supportsScientGeneralChatCapability,
  supportsScientGeneralChat,
} from "@t3tools/client-runtime/scient/general-chat";

export function shouldAssignScientGeneralChatNewThreadShortcut(input: {
  readonly hasGeneralChatTarget: boolean;
  readonly hasProjectShortcutTarget: boolean;
}): boolean {
  return input.hasGeneralChatTarget && !input.hasProjectShortcutTarget;
}

export function isScientGeneralChatRightPanelKindAllowed(
  kind: "diff" | "files" | "file" | "preview" | "terminal" | "pull-request" | "agents" | "scient",
): boolean {
  switch (kind) {
    case "files":
    case "file":
      return supportsScientGeneralChatCapability("files");
    case "preview":
      return supportsScientGeneralChatCapability("browser");
    case "terminal":
      return supportsScientGeneralChatCapability("terminal");
    case "agents":
      return supportsScientGeneralChatCapability("agents");
    case "diff":
      return supportsScientGeneralChatCapability("diff");
    case "pull-request":
      return supportsScientGeneralChatCapability("pullRequests");
    case "scient":
      return false;
  }
}

/** Workspace-relative surfaces cannot be reinterpreted after relocation. */
export function shouldCloseSurfaceAfterScientGeneralChatMove(
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
 * Chooses the environment for the dedicated General Chat create action.
 * Staying in the current environment preserves the user's context; the
 * primary environment is the predictable fallback when no thread is active.
 */
export function resolveScientGeneralChatCreationEnvironment(input: {
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
 * Resolves the terminal boundary for both project threads and General Chat.
 * Project threads retain T3's project/worktree environment. General Chat gets
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
