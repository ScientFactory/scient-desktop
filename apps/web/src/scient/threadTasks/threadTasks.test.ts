import { describe, expect, it } from "vite-plus/test";

import { selectThreadTaskList } from "./threadTasks";

type Projection = NonNullable<Parameters<typeof selectThreadTaskList>[0]>;

const steps = (...statuses: readonly string[]) =>
  statuses.map((status, index) => ({ id: `step-${index}`, text: `Step ${index}`, status }));

const projection = (input: {
  readonly plans: readonly object[];
  readonly runs?: readonly object[];
}) =>
  ({
    plans: input.plans,
    runs: input.runs ?? [
      { id: "run-1", ordinal: 1, startedAt: "2026-11-01T10:00:00Z", providerThreadId: "claude" },
      { id: "run-2", ordinal: 2, startedAt: "2026-11-01T11:00:00Z", providerThreadId: "claude" },
    ],
  }) as unknown as Projection;

const list = (id: string, runId: string, ...statuses: readonly string[]) => ({
  id,
  runId,
  kind: "todo_list",
  status: "active",
  steps: steps(...statuses),
});

describe("selectThreadTaskList", () => {
  it("keeps an unfinished list after its run ends", () => {
    const open = list("open", "run-1", "completed", "pending");
    expect(selectThreadTaskList(projection({ plans: [open] }))).toBe(open);
  });

  it("shows the latest list, not an older unfinished one", () => {
    const older = list("older", "run-1", "pending");
    const latest = list("latest", "run-2", "running", "pending");
    expect(selectThreadTaskList(projection({ plans: [latest, older] }))).toBe(latest);
  });

  it("has nothing to show once every step is done", () => {
    const older = list("older", "run-1", "pending");
    const done = list("done", "run-2", "completed");
    expect(selectThreadTaskList(projection({ plans: [older, done] }))).toBeNull();
  });

  it("drops a list when another agent session takes over the thread", () => {
    const runs = [
      { id: "run-1", ordinal: 1, startedAt: "2026-11-01T10:00:00Z", providerThreadId: "claude" },
      { id: "run-2", ordinal: 2, startedAt: "2026-11-01T11:00:00Z", providerThreadId: "codex" },
    ];
    expect(
      selectThreadTaskList(projection({ plans: [list("open", "run-1", "pending")], runs })),
    ).toBeNull();
  });

  it("ignores superseded lists and proposed plans", () => {
    const superseded = { ...list("old", "run-2", "pending"), status: "superseded" };
    const proposed = { ...list("plan", "run-2", "pending"), kind: "proposed_plan" };
    expect(selectThreadTaskList(projection({ plans: [superseded, proposed] }))).toBeNull();
  });
});
