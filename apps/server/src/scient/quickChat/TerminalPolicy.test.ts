import {
  ThreadId,
  type OrchestrationThreadShell,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { validateScientQuickChatTerminalOpen } from "./TerminalPolicy.ts";

const thread = {
  id: ThreadId.make("thread-general"),
  projectId: null,
  workspaceRoot: "/workspace/general",
} satisfies Pick<OrchestrationThreadShell, "id" | "projectId" | "workspaceRoot">;

function request(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-general",
    terminalId: "terminal-1",
    cwd: "/workspace/general",
    env: {},
    ...overrides,
  };
}

describe("Scient Quick Chat terminal policy", () => {
  it("accepts a plain terminal at the authoritative workspace", () => {
    expect(
      validateScientQuickChatTerminalOpen({
        thread,
        request: request(),
        environmentWorkspaceRoot: "/workspace/environment",
        resolvePath: (value) => value,
      }),
    ).toBeNull();
  });

  it("rejects another cwd, worktree metadata, or injected project environment", () => {
    for (const candidate of [
      request({ cwd: "/workspace/other" }),
      request({ worktreePath: "/workspace/worktree" }),
      request({ env: { T3CODE_PROJECT_DIR: "/workspace/project" } }),
    ]) {
      expect(
        validateScientQuickChatTerminalOpen({
          thread,
          request: candidate,
          environmentWorkspaceRoot: "/workspace/environment",
          resolvePath: (value) => value,
        }),
      ).toMatchObject({ _tag: "TerminalWorkspaceMismatchError" });
    }
  });
});
