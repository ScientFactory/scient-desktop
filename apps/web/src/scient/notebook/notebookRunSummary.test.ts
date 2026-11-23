import {
  ComputeExecutionId,
  ComputeSessionId,
  type ComputeExecutionRecord,
  type NotebookCellView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  extractUndefinedName,
  notebookBatchFailureSummary,
  notebookDefiningCell,
  notebookNeedsSetup,
} from "./notebookRunSummary";

const makeCell = (
  id: string,
  source: string,
  cellType: "code" | "markdown" = "code",
): NotebookCellView => ({
  id,
  cellType,
  source,
  executionCount: null,
  run: null,
  pendingExecution: null,
  outputs: [],
});

function makeBatchExecution(input: {
  readonly id: string;
  readonly cellId: string;
  readonly batchId: string;
  readonly index: number;
  readonly count: number;
  readonly status: NonNullable<ComputeExecutionRecord["result"]>["status"];
  readonly startedAt?: string | null;
  readonly generation?: number;
  readonly submittedAt?: string;
}): ComputeExecutionRecord {
  return {
    request: {
      executionId: ComputeExecutionId.make(input.id),
      sessionId: ComputeSessionId.make("session-1"),
      generation: (input.generation ?? 1) as never,
      code: "x = 1",
      codeHash: "h",
      source: {
        _tag: "document",
        origin: "cell",
        path: "analysis.ipynb",
        bufferState: "saved",
        revision: null,
        range: null,
        cell: input.cellId,
        notebookBatch: {
          id: ComputeExecutionId.make(input.batchId),
          mode: "all",
          index: input.index,
          count: input.count,
        },
      },
      submittedAt: input.submittedAt ?? "2026-11-23T20:00:00.000Z",
      environmentFingerprint: null,
    },
    result: {
      executionId: ComputeExecutionId.make(input.id),
      status: input.status,
      outcome:
        input.status === "succeeded" || input.status === "failed" || input.status === "cancelled"
          ? input.status
          : null,
      queuePosition: null,
      startedAt: input.startedAt === undefined ? "2026-11-23T20:00:01.000Z" : input.startedAt,
      finishedAt: "2026-11-23T20:00:02.000Z",
      diagnostics: [],
      outputCount: 0,
      imageCount: 0,
      outputBytes: 0,
      truncated: false,
      failureReason: null,
    },
  };
}

describe("notebookBatchFailureSummary", () => {
  const order = ["intro", "setup", "compute", "plot"];
  const cells: Record<string, NotebookCellView> = {
    intro: makeCell("intro", "# Analysis", "markdown"),
    setup: makeCell("setup", "run_date = '20261123'"),
    compute: makeCell("compute", "print(run_date)"),
    plot: makeCell("plot", "print('done')"),
  };

  it("locates the first failure when only skipped cells remain in the recent feed", () => {
    const skipped = makeBatchExecution({
      id: "last",
      cellId: "plot",
      batchId: "long-batch",
      index: 399,
      count: 400,
      status: "cancelled",
      startedAt: null,
    });
    const lastNotebookBatch = {
      id: ComputeExecutionId.make("long-batch"),
      mode: "all" as const,
      status: "failed" as const,
      failedCell: 1,
      count: 400,
      notRun: 399,
      firstFailure: {
        path: "analysis.ipynb",
        cell: "setup",
        generation: skipped.request.generation,
      },
    };
    expect(
      notebookBatchFailureSummary({
        executions: [skipped],
        cellRuns: new Map([["plot", skipped]]),
        path: "analysis.ipynb",
        order,
        cells,
        lastNotebookBatch,
        liveSessionGeneration: 1,
      }),
    ).toEqual({ batchId: "long-batch", cellId: "setup", cellNumber: 1, skippedCount: 399 });
  });

  it("reports the first failed code cell and skipped cell count, then clears once fixed or restarted", () => {
    const e1 = makeBatchExecution({
      id: "e1",
      cellId: "setup",
      batchId: "b1",
      index: 0,
      count: 3,
      status: "failed",
    });
    const e2 = makeBatchExecution({
      id: "e2",
      cellId: "compute",
      batchId: "b1",
      index: 1,
      count: 3,
      status: "cancelled",
      startedAt: null,
    });
    const e3 = makeBatchExecution({
      id: "e3",
      cellId: "plot",
      batchId: "b1",
      index: 2,
      count: 3,
      status: "cancelled",
      startedAt: null,
    });
    const executions = [e1, e2, e3];
    const cellRuns = new Map([
      ["setup", e1],
      ["compute", e2],
      ["plot", e3],
    ]);

    expect(
      notebookBatchFailureSummary({
        executions,
        cellRuns,
        path: "analysis.ipynb",
        order,
        cells,
        liveSessionGeneration: 1,
      }),
    ).toEqual({
      batchId: "b1",
      cellId: "setup",
      cellNumber: 1,
      skippedCount: 2,
    });

    // Clears after kernel restart (generation increments to 2).
    expect(
      notebookBatchFailureSummary({
        executions,
        cellRuns,
        path: "analysis.ipynb",
        order,
        cells,
        liveSessionGeneration: 2,
      }),
    ).toBeNull();

    // Clears once the failed cell later succeeds.
    const fixed = makeBatchExecution({
      id: "e4",
      cellId: "setup",
      batchId: "b2",
      index: 0,
      count: 1,
      status: "succeeded",
      submittedAt: "2026-11-23T20:01:00.000Z",
    });
    expect(
      notebookBatchFailureSummary({
        executions: [...executions, fixed],
        cellRuns: new Map([
          ["setup", fixed],
          ["compute", e2],
          ["plot", e3],
        ]),
        path: "analysis.ipynb",
        order,
        cells,
        liveSessionGeneration: 1,
      }),
    ).toBeNull();
  });
});

describe("notebookDefiningCell", () => {
  const order = ["intro", "setup", "target"];
  const cells: Record<string, NotebookCellView> = {
    intro: makeCell("intro", "# Intro", "markdown"),
    setup: makeCell("setup", "import os\nrun_date = '20261123'"),
    target: makeCell("target", "print(os.path.join(run_date))"),
  };

  it("extracts Python undefined names and classifies the earlier defining cell from live session state", () => {
    expect(extractUndefinedName("NameError", "name 'run_date' is not defined")).toBe("run_date");
    expect(extractUndefinedName("ValueError", "name 'run_date' is not defined")).toBeNull();

    // Before setup has run in the current session.
    expect(
      notebookDefiningCell({
        order,
        cells,
        targetCellId: "target",
        name: "run_date",
        cellRuns: new Map(),
        liveSessionGeneration: 1,
      }),
    ).toEqual({ name: "run_date", cellId: "setup", cellNumber: 1, status: "not-run" });

    // When setup failed in the current session.
    const failedSetup = makeBatchExecution({
      id: "e1",
      cellId: "setup",
      batchId: "b1",
      index: 0,
      count: 2,
      status: "failed",
      generation: 1,
    });
    expect(
      notebookDefiningCell({
        order,
        cells,
        targetCellId: "target",
        name: "os",
        cellRuns: new Map([["setup", failedSetup]]),
        liveSessionGeneration: 1,
      }),
    ).toEqual({ name: "os", cellId: "setup", cellNumber: 1, status: "failed" });
  });
});

describe("notebookNeedsSetup", () => {
  const order = ["setup", "target", "local"];
  const cells: Record<string, NotebookCellView> = {
    setup: makeCell("setup", "run_date = '20261123'"),
    target: makeCell("target", "print(run_date)"),
    local: makeCell("local", "x = 2\nprint(x)"),
  };
  const ranSetup = makeBatchExecution({
    id: "e1",
    cellId: "setup",
    batchId: "b1",
    index: 0,
    count: 1,
    status: "succeeded",
    generation: 2,
  });
  const needs = (cellRuns: Map<string, ComputeExecutionRecord>, generation: number | null) =>
    notebookNeedsSetup({
      order,
      cells,
      targetCellId: "target",
      cellRuns,
      liveSessionGeneration: generation,
    });

  it("asks for setup until the defining cell has run in this session", () => {
    expect(needs(new Map(), 2)).toBe(true);
    expect(needs(new Map([["setup", ranSetup]]), 2)).toBe(false);
    // A run from an earlier session, or no session at all, leaves the name undefined.
    expect(needs(new Map([["setup", ranSetup]]), 3)).toBe(true);
    expect(needs(new Map([["setup", ranSetup]]), null)).toBe(true);
    // Names the cell defines itself need nothing above.
    expect(
      notebookNeedsSetup({
        order,
        cells,
        targetCellId: "local",
        cellRuns: new Map(),
        liveSessionGeneration: 2,
      }),
    ).toBe(false);
  });
});
