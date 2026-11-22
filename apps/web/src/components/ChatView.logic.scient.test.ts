import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldOpenProactivePullRequest, shouldOpenProactiveTurnDiff } from "./ChatView.logic";

// T3 dropped the case that exercised these triggers; they still decide when Scient opens the
// PR and diff panels on its own.
describe("proactive panel triggers", () => {
  it.each([
    { previous: undefined, next: "owner/repo:2", opens: true },
    { previous: "owner/repo:1", next: "owner/repo:2", opens: true },
    { previous: "owner/repo:2", next: "owner/repo:2", opens: false },
    { previous: "owner/repo:2", next: null, opens: false },
  ])("opens a PR panel for $previous → $next: $opens", ({ previous, next, opens }) => {
    expect(shouldOpenProactivePullRequest(previous, next)).toBe(opens);
  });

  const run = RunId.make("run-1");
  const other = RunId.make("run-2");
  it.each([
    { name: "a completed turn first seen settled", previous: undefined, opens: true },
    { name: "the completed turn that was running", previous: run, opens: true },
    { name: "a different turn than the one running", previous: other, opens: false },
    { name: "a turn still running", previous: run, running: run, opens: false },
    { name: "a turn that has not completed", previous: run, completed: false, opens: false },
    { name: "no settled turn", previous: run, settled: null, opens: false },
  ])("opens the diff for $name: $opens", (row) => {
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: row.previous,
        runningTurnId: row.running ?? null,
        settledTurnId: row.settled === null ? null : run,
        turnCompleted: row.completed ?? true,
      }),
    ).toBe(row.opens);
  });
});
