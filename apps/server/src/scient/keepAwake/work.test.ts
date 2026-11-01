import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { summarizeWork, threadWork } from "./work.ts";

const shell = (overrides: Partial<OrchestrationV2ThreadShell>) =>
  ({
    archivedAt: null,
    deletedAt: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const task = (kind: "command" | "monitor" | "subagent") => ({ taskId: kind, kind }) as const;
const request = (
  overrides: Partial<NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>>,
) => ({ kind: "approval", ...overrides }) as OrchestrationV2ThreadShell["pendingRuntimeRequest"];

describe("threadWork", () => {
  it("counts a run and whatever outlives it", () => {
    expect(threadWork(shell({ activityRunStatus: "running" }))).toBe("executing");
    expect(threadWork(shell({ pendingBackgroundTasks: [task("command")] }))).toBe("executing");
    expect(threadWork(shell({ pendingBackgroundTasks: [task("subagent")] }))).toBe("executing");
  });

  it("lets the computer sleep through what only waits", () => {
    expect(threadWork(shell({ pendingBackgroundTasks: [task("monitor")] }))).toBe("waiting");
    expect(
      threadWork(shell({ activityRunStatus: "running", pendingRuntimeRequest: request({}) })),
    ).toBe("waiting");
    expect(threadWork(shell({ status: "queued" }))).toBe("waiting");
    expect(threadWork(shell({ activityRunStatus: "running", blockedOnThreadWait: true }))).toBe(
      "waiting",
    );
    expect(
      threadWork(shell({ limitRecovery: { autoResume: true } as never, status: "failed" })),
    ).toBe("waiting");
  });

  it("keeps going past requests the run doesn't stop for", () => {
    for (const pendingRuntimeRequest of [
      request({ blocking: false }),
      request({ kind: "dynamic_tool_call" }),
    ]) {
      expect(threadWork(shell({ activityRunStatus: "running", pendingRuntimeRequest }))).toBe(
        "executing",
      );
    }
  });

  it("ends with the thread", () => {
    expect(threadWork(shell({}))).toBe("finished");
    expect(threadWork(shell({ activityRunStatus: "running", archivedAt: {} as never }))).toBe(
      "finished",
    );
  });
});

describe("summarizeWork", () => {
  const parent = ThreadId.make("parent");
  const child = ThreadId.make("child");
  const lineages = new Map([
    [child, { relationshipToParent: "subagent", parentThreadId: parent }],
    [parent, { relationshipToParent: null, parentThreadId: null }],
  ]) as unknown as Parameters<typeof summarizeWork>[1];

  it("reports a subagent's work on its parent too", () => {
    expect(summarizeWork([{ threadId: child, work: "working" }], lineages)).toEqual({
      working: [child, parent],
      waiting: [],
    });
  });

  it("survives a lineage that loops", () => {
    const loop = new Map([
      [child, { relationshipToParent: "subagent", parentThreadId: parent }],
      [parent, { relationshipToParent: "subagent", parentThreadId: child }],
    ]) as unknown as Parameters<typeof summarizeWork>[1];
    expect(summarizeWork([{ threadId: child, work: "waiting" }], loop).waiting).toEqual([
      child,
      parent,
    ]);
  });
});
