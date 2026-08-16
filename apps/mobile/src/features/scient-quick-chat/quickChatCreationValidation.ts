import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class QuickChatTaskRequiredError extends Schema.TaggedErrorClass<QuickChatTaskRequiredError>()(
  "QuickChatTaskRequiredError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return "Enter a task before starting the thread.";
  }
}

export function validateQuickChatCreation(input: {
  readonly environmentId: EnvironmentId;
  readonly initialMessageText: string;
}): QuickChatTaskRequiredError | null {
  return input.initialMessageText.trim().length === 0
    ? new QuickChatTaskRequiredError({ environmentId: input.environmentId })
    : null;
}

/**
 * Workspace fields recorded on a new thread. T3's composer may pass a checkout
 * branch or worktree path; Quick Chat has no project, so those fields stay empty.
 */
export function resolveScientThreadStartTurnWorkspace(input: {
  readonly hasProject: boolean;
  readonly envMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): {
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
} {
  if (!input.hasProject) {
    return { workspaceMode: "local", branch: null, worktreePath: null };
  }
  return {
    workspaceMode: input.envMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
  };
}
