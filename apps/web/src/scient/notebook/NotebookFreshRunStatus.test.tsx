import { describe, expect, it } from "vite-plus/test";
import { ComputeSessionId } from "@t3tools/contracts";

import { notebookFreshRunProblems } from "./NotebookFreshRunStatus";

const runId = ComputeSessionId.make("fresh");

describe("fresh run problems", () => {
  it("has nothing to say once a run succeeded or while one runs", () => {
    expect(
      notebookFreshRunProblems(
        { runId, outcome: { _tag: "completed", notebookSaved: true } },
        false,
        null,
      ),
    ).toBeNull();
    expect(
      notebookFreshRunProblems(
        {
          runId,
          outcome: { _tag: "completed", notebookSaved: true },
          sweepSummary: { total: 2, saved: 2, failures: [] },
        },
        false,
        null,
      ),
    ).toBeNull();
    expect(notebookFreshRunProblems({ runId }, true, "stale error")).toBeNull();
  });

  it("reports a notebook that could not be saved, keyed to its run", () => {
    const problems = notebookFreshRunProblems(
      {
        runId,
        outcome: {
          _tag: "completed",
          notebookSaved: false,
          notebookMessage: "The notebook changed during the run.",
        },
      },
      false,
      null,
    );
    expect(problems?.message).toBe("The notebook changed during the run.");
    expect(problems?.key).toContain("fresh");
  });
});
