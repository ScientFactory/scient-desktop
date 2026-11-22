import { describe, expect, it } from "vite-plus/test";

import {
  selectSourcesActivity,
  sourcesResultReducer,
  type SourcesActivityItem,
  type SourcesResultAction,
  type SourcesResultState,
} from "./sourcesFeedback";

const item = (key: string, tone: SourcesActivityItem["tone"]): SourcesActivityItem => ({
  key,
  tone,
  label: key,
  body: key,
});

const reduce = (state: SourcesResultState, ...actions: ReadonlyArray<SourcesResultAction>) =>
  actions.reduce(sourcesResultReducer, state);

const start: SourcesResultState = { context: "project-a", newest: null, shown: null };
const done = (summary: string) => ({ tone: "success" as const, summary });

describe("selectSourcesActivity", () => {
  it("lists running work apart and ranks errors, then choices, then notices", () => {
    const activity = selectSourcesActivity([
      item("notice", "advisory"),
      null,
      item("import", "running"),
      item("choice", "decision"),
      false,
      item("failure", "error"),
      item("backup", "running"),
    ]);
    expect(activity.running.map((entry) => entry.key)).toEqual(["import", "backup"]);
    expect(activity.issues.map((entry) => entry.key)).toEqual(["failure", "choice", "notice"]);
    expect(activity.count).toBe(5);
    expect(activity.summary).toBe("import · backup");
  });
});

describe("the result slot", () => {
  it("keeps a newer operation's result from a late completion of an older one", () => {
    const both = reduce(
      start,
      { type: "begin", context: "project-a", operationId: "older" },
      { type: "begin", context: "project-a", operationId: "newer" },
    );
    const late = sourcesResultReducer(both, {
      type: "settle",
      operationId: "older",
      content: done("6 references imported"),
    });
    expect(late.shown).toBeNull();
    const shown = reduce(
      late,
      { type: "settle", operationId: "newer", content: done("Library backed up") },
      { type: "settle", operationId: "older", content: done("6 references imported") },
    );
    expect(shown.shown).toMatchObject({ operationId: "newer", summary: "Library backed up" });
  });

  it("drops the result and every start on a change of project", () => {
    const shown = reduce(
      start,
      { type: "begin", context: "project-a", operationId: "first" },
      { type: "settle", operationId: "first", content: done("Added 1 source") },
      { type: "begin", context: "project-a", operationId: "running" },
    );
    const moved = sourcesResultReducer(shown, { type: "contextChanged", context: "project-b" });
    expect(moved.shown).toBeNull();
    const late = sourcesResultReducer(moved, {
      type: "settle",
      operationId: "running",
      content: done("6 references imported"),
    });
    expect(late.shown).toBeNull();
  });
});
