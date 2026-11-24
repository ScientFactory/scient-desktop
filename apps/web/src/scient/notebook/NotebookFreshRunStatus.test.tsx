import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComputeSessionId, type NotebookFreshRun } from "@t3tools/contracts";

vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);

import { NotebookFreshRunStatus } from "./NotebookFreshRunStatus";

const runId = ComputeSessionId.make("fresh");
const render = (job: NotebookFreshRun) =>
  renderToStaticMarkup(<NotebookFreshRunStatus job={job} running={false} message={null} />);

describe("fresh run status", () => {
  it("says nothing once a run succeeded", () => {
    expect(render({ runId, outcome: { _tag: "completed", notebookSaved: true } })).toBe("");
    expect(
      render({
        runId,
        outcome: { _tag: "failed", message: "unused" },
        sweepSummary: { total: 2, saved: 2, failures: [] },
      }),
    ).not.toContain("runs saved");
  });

  it("reports a notebook that could not be saved", () => {
    expect(
      render({
        runId,
        outcome: {
          _tag: "completed",
          notebookSaved: false,
          notebookMessage: "The notebook changed during the run.",
        },
      }),
    ).toContain("The notebook changed during the run.");
  });
});
