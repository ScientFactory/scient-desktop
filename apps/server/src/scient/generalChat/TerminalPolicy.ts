import { type OrchestrationThreadShell, TerminalWorkspaceMismatchError } from "@t3tools/contracts";

/**
 * General Chat terminal requests must resolve to the thread's authoritative
 * environment workspace and may not smuggle project/worktree environment.
 */
export function validateScientGeneralChatTerminalOpen(input: {
  readonly thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "workspaceRoot">;
  readonly request: {
    readonly threadId: string;
    readonly cwd?: string | undefined;
    readonly worktreePath?: string | null | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
  };
  readonly environmentWorkspaceRoot: string;
  readonly resolvePath: (path: string) => string;
}): TerminalWorkspaceMismatchError | null {
  if (input.thread.projectId !== null) return null;

  const expectedCwd = input.resolvePath(
    input.thread.workspaceRoot ?? input.environmentWorkspaceRoot,
  );
  const requestedCwd = input.resolvePath(input.request.cwd ?? expectedCwd);
  if (
    (input.request.cwd === undefined || requestedCwd === expectedCwd) &&
    input.request.worktreePath == null &&
    Object.keys(input.request.env ?? {}).length === 0
  ) {
    return null;
  }
  return new TerminalWorkspaceMismatchError({
    threadId: input.request.threadId,
    requestedCwd,
    expectedCwd,
  });
}
