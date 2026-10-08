import { describe, expect, it } from "@effect/vitest";

import {
  groupToolLifecycles,
  mergeToolLifecyclePayloads,
  toolLifecycleOutcome,
} from "./toolLifecycle.ts";

const row = (
  id: string,
  kind: string,
  toolCallId: string | null,
  turnId: string | null = "t1",
) => ({
  id,
  kind,
  turnId,
  toolCallId,
});
const ids = (groups: ReadonlyArray<ReadonlyArray<{ readonly id: string }>>) =>
  groups.map((group) => group.map((entry) => entry.id));

describe("groupToolLifecycles", () => {
  it("folds one call's rows and keeps the place of its first row", () => {
    expect(
      ids(
        groupToolLifecycles([
          row("a1", "tool.started", "a"),
          row("b1", "tool.started", "b"),
          row("a2", "tool.updated", "a"),
          row("note", "runtime.warning", null),
          row("b2", "tool.completed", "b"),
          row("a3", "tool.completed", "a"),
        ]),
      ),
    ).toEqual([["a1", "a2", "a3"], ["b1", "b2"], ["note"]]);
  });

  it("starts a new call when an id is reused after completion or in another turn", () => {
    expect(
      ids(
        groupToolLifecycles([
          row("first", "tool.completed", "same"),
          row("again", "tool.updated", "same"),
          row("again-done", "tool.completed", "same"),
          row("other-turn", "tool.completed", "same", "t2"),
          row("no-turn", "tool.completed", "same", null),
        ]),
      ),
    ).toEqual([["first"], ["again", "again-done"], ["other-turn"], ["no-turn"]]);
  });

  it("leaves rows without a call id, denied calls and tasks as they are", () => {
    expect(
      ids(
        groupToolLifecycles([
          row("u1", "tool.updated", null),
          row("u2", "tool.updated", null),
          row("denied", "tool.denied", "d"),
          row("denied-again", "tool.denied", "d"),
          row("task", "task.progress", "x"),
        ]),
      ),
    ).toEqual([["u1"], ["u2"], ["denied"], ["denied-again"], ["task"]]);
  });
});

describe("mergeToolLifecyclePayloads", () => {
  it("keeps the last row and fills fields it does not have from the newest earlier row", () => {
    expect(
      mergeToolLifecyclePayloads([
        { status: "inProgress", title: "Ran command", toolIcon: "terminal", detail: "old" },
        { status: "inProgress", toolIcon: "terminal-2", detail: "newer", agentId: null },
        { status: "completed", title: "Ran command", citationSources: [] },
      ]),
    ).toEqual({
      status: "completed",
      title: "Ran command",
      citationSources: [],
      toolIcon: "terminal-2",
      detail: "newer",
      agentId: null,
    });
  });

  it("keeps a value the last row reports as null, and a null from the newest earlier row", () => {
    expect(
      mergeToolLifecyclePayloads([
        { detail: "old", agentId: "a", data: { command: "ls", exitCode: 1 } },
        { agentId: null, data: { exitCode: null } },
        { detail: null, data: { rawOutput: null } },
      ]),
    ).toEqual({
      detail: null,
      agentId: null,
      data: { rawOutput: null, exitCode: null, command: "ls" },
    });
  });

  it("fills data fields the last row did not repeat, without replacing its own", () => {
    expect(
      mergeToolLifecyclePayloads([
        { data: { command: "ls", startedAtMs: 1 } },
        { data: { command: "ls -la", rawOutput: "partial", files: ["a"] } },
        { data: { toolName: "bash", rawOutput: "final" } },
      ]),
    ).toEqual({
      data: {
        toolName: "bash",
        rawOutput: "final",
        command: "ls -la",
        files: ["a"],
        startedAtMs: 1,
      },
    });
  });

  it("merges every earlier data object when the last row has none", () => {
    expect(
      mergeToolLifecyclePayloads([
        { data: { command: "ls" } },
        { data: { rawOutput: "result" } },
        { status: "completed" },
      ]),
    ).toEqual({ status: "completed", data: { rawOutput: "result", command: "ls" } });
  });

  it("returns a single or non-object payload unchanged", () => {
    const only = { data: { command: "ls" } };
    expect(mergeToolLifecyclePayloads([only])).toBe(only);
    expect(mergeToolLifecyclePayloads([{ a: 1 }, "text"])).toBe("text");
  });
});

describe("toolLifecycleOutcome", () => {
  const at = (kind: string, status?: string) => ({ kind, payload: { status } });
  it("reports how the call ended", () => {
    expect(toolLifecycleOutcome([at("tool.started"), at("tool.completed", "completed")])).toBe(
      "completed",
    );
    expect(toolLifecycleOutcome([at("tool.completed")])).toBe("completed");
    expect(toolLifecycleOutcome([at("tool.started"), at("tool.completed", "failed")])).toBe(
      "failed",
    );
    expect(toolLifecycleOutcome([at("tool.started"), at("tool.updated", "inProgress")])).toBe(
      "interrupted",
    );
    expect(toolLifecycleOutcome([at("tool.updated", "failed"), at("tool.updated")])).toBe("failed");
    // A failure reported while running is not undone by the completion row.
    expect(
      toolLifecycleOutcome([at("tool.updated", "failed"), at("tool.completed", "completed")]),
    ).toBe("failed");
    expect(toolLifecycleOutcome([at("tool.updated", "failed"), at("tool.completed")])).toBe(
      "failed",
    );
  });
});
