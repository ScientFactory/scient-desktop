import { describe, expect, it } from "vite-plus/test";

import { type RestartThread, threadBlocksUpdateRestart } from "./restartWhenIdle.logic";

function thread(overrides: Partial<RestartThread> = {}): RestartThread {
  return {
    runtime: null,
    blockedOnThreadWait: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
    ...overrides,
  };
}

const runtime = (status: NonNullable<RestartThread["runtime"]>["status"]) =>
  ({
    status,
    activeRunId: null,
    providerInstanceId: "codex" as never,
    providerName: null,
    lastError: null,
    updatedAt: "2026-11-14T00:00:00.000Z",
  }) satisfies RestartThread["runtime"];

const task = (
  kind: RestartThread["pendingBackgroundTasks"][number]["kind"],
  overrides: Partial<RestartThread["pendingBackgroundTasks"][number]> = {},
) => ({ taskId: `task-${kind}`, description: kind, kind, ...overrides }) as never;

describe("threadBlocksUpdateRestart", () => {
  it("does not block for a thread with nothing running", () => {
    expect(threadBlocksUpdateRestart(thread())).toBe(false);
    expect(threadBlocksUpdateRestart(thread({ runtime: runtime("idle") }))).toBe(false);
    expect(threadBlocksUpdateRestart(thread({ runtime: runtime("completed") }))).toBe(false);
  });

  it("blocks while an agent's turn is starting or running", () => {
    for (const status of ["preparing", "queued", "starting", "running"] as const) {
      expect(threadBlocksUpdateRestart(thread({ runtime: runtime(status) }))).toBe(true);
    }
  });

  it("does not block for an agent waiting on the user or another thread", () => {
    const running = runtime("running");
    expect(threadBlocksUpdateRestart(thread({ runtime: running, hasPendingApprovals: true }))).toBe(
      false,
    );
    expect(threadBlocksUpdateRestart(thread({ runtime: running, hasPendingUserInput: true }))).toBe(
      false,
    );
    expect(threadBlocksUpdateRestart(thread({ runtime: running, blockedOnThreadWait: true }))).toBe(
      false,
    );
  });

  it("blocks for a running turn whose subagent or side chat asks something", () => {
    // The shell copies a child's request onto its parent; the parent's own turn keeps going.
    const parent = {
      ...thread({ runtime: runtime("running") }),
      pendingSubagentRequest: "approval",
    };
    expect(threadBlocksUpdateRestart(parent as RestartThread)).toBe(true);
  });

  it("blocks for awaited work even while a question is open", () => {
    expect(
      threadBlocksUpdateRestart(
        thread({
          runtime: runtime("idle"),
          hasPendingUserInput: true,
          pendingBackgroundTasks: [task("command", { awaited: true })],
        }),
      ),
    ).toBe(true);
  });

  it("does not block for a pull request watch or a monitor", () => {
    expect(
      threadBlocksUpdateRestart(
        thread({
          runtime: runtime("idle"),
          pendingBackgroundTasks: [
            task("background_task", { taskId: "pull-request-watch:42", awaited: true }),
            task("monitor", { awaited: true }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("blocks for a command the agent waits on, a subagent or a background task", () => {
    for (const pending of [
      task("command", { awaited: true }),
      task("subagent"),
      task("background_task"),
    ]) {
      expect(
        threadBlocksUpdateRestart(
          thread({ runtime: runtime("idle"), pendingBackgroundTasks: [pending] }),
        ),
      ).toBe(true);
    }
  });

  it("does not block for a command left running that the agent is not waiting on", () => {
    expect(
      threadBlocksUpdateRestart(
        thread({ runtime: runtime("idle"), pendingBackgroundTasks: [task("command")] }),
      ),
    ).toBe(false);
  });
});
