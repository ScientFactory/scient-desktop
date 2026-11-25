import "../../index.css";

import {
  AnalysisRunId,
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
  ThreadId,
  type AnalysisRunSnapshot,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";

import { computeEnvironment } from "~/state/compute";
import { analysisEnvironment } from "~/state/analysis";
import { ComputeToolActivity } from "./ComputeToolActivity";
import { ComputeProjectHistory } from "./ComputeProjectHistory";
import { cancelComputeQuoteReveal, requestComputeQuoteReveal } from "./computeQuoteReveal";
import { ComputeResultsFeed } from "./ComputeResultsFeed";

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), query: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.cancel }));
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: mocks.query,
}));

const environmentId = EnvironmentId.make("compute-history");
const threadRef = { environmentId, threadId: ThreadId.make("researcher-chat") };
const sessionId = ComputeSessionId.make("agent-session");
const generation = ComputeSessionGeneration.make(1);
const executionId = ComputeExecutionId.make("active-run");
const session = { sessionId, generation, label: "Python" } as ComputeSessionRecord;
const cwd = "/project";

function renderHistory(
  entries: Parameters<typeof ComputeResultsFeed>[0]["entries"],
  container?: HTMLElement,
  projectHistory = true,
) {
  return render(
    <ComputeResultsFeed
      environmentId={environmentId}
      cwd={cwd}
      threadRef={threadRef}
      entries={entries}
      events={null}
      rehydrationToken={null}
      includeSourcePath
      projectHistory={projectHistory}
      runtimeInspection={null}
      dependencyRecoveryFor={() => undefined}
      followRequest={null}
      empty={null}
    />,
    container ? { container } : undefined,
  );
}

const execution: ComputeExecutionRecord = {
  request: {
    executionId,
    sessionId,
    generation,
    code: "while True: pass",
    codeHash: "a".repeat(64),
    source: { _tag: "console" },
    actor: { _tag: "agent", threadId: ThreadId.make("agent-chat") },
    submittedAt: "2026-11-23T01:00:00.000Z",
    environmentFingerprint: null,
  },
  result: {
    executionId,
    status: "running",
    outcome: null,
    startedAt: null,
    finishedAt: null,
    queuePosition: null,
    diagnostics: [],
    outputCount: 0,
    imageCount: 0,
    outputBytes: 0,
    truncated: false,
    failureReason: null,
  },
};

it("shows the history affordance on hover, keyboard focus and expansion, and only tooltips clipped titles", async () => {
  mocks.query
    .mockReset()
    .mockReturnValue({ data: null, error: null, isPending: false, refresh: vi.fn() });
  const short = "analysis.py";
  const long = "results/archived-models/sensitivity-analysis-for-the-extended-cohort.py";
  const method = '"stratified-bootstrap-for-the-extended-follow-up-cohort"';
  const parameters = `threshold = 0.7 · resample = true · method = ${method}`;
  const container = document.createElement("div");
  container.style.cssText = "width: 360px; display: flex; flex-direction: column;";
  await using screen = await renderHistory(
    [short, long].map((path) => {
      const id = ComputeExecutionId.make(path);
      return {
        kind: "run",
        key: id,
        session,
        execution: {
          request: {
            ...execution.request,
            executionId: id,
            actor: undefined,
            ...(path === short
              ? { parameters: { threshold: "0.7", resample: "true", method } }
              : {}),
            source: {
              _tag: "document",
              origin: "file",
              path,
              bufferState: "saved",
              revision: null,
              range: null,
            },
          },
          result: { ...execution.result!, executionId: id, status: "succeeded" },
        },
      };
    }),
    container,
  );
  const parameterLine = screen.getByText(parameters, { exact: true });
  await expect.element(parameterLine).toBeVisible();
  const shortLabel = screen.getByText(short, { exact: true });
  const longLabel = screen.getByText(long, { exact: true });
  const shortRow = screen.getByRole("button", { name: /analysis\.py/ });
  const indicator = (await shortRow.element()).querySelector(".lucide-chevron-right")!;
  const visible = () => getComputedStyle(indicator).visibility;
  const tooltip = () => document.querySelector('[data-slot="tooltip-popup"]')?.textContent;

  expect(visible()).toBe("hidden");
  {
    using _timers = fakeTimers();
    await userEvent.hover(shortLabel);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(visible()).toBe("visible");
    expect(tooltip()).toBeUndefined();
  }

  await userEvent.hover(parameterLine);
  await expect.poll(tooltip).toBe(parameters);
  await userEvent.hover(longLabel);
  await expect.poll(tooltip).toBe(long);
  container.style.width = "850px";
  await expect.poll(tooltip).toBeUndefined();
  expect(visible()).toBe("hidden");

  await userEvent.tab();
  await expect.element(shortRow).toHaveFocus();
  expect(visible()).toBe("visible");
  await userEvent.keyboard("{Enter}");
  await expect.element(shortRow).toHaveAttribute("aria-expanded", "true");
  ((await shortRow.element()) as HTMLElement).blur();
  expect(visible()).toBe("visible");
});

it("names snippets from the first code line and keeps comments in the code disclosure", async () => {
  mocks.query
    .mockReset()
    .mockReturnValue({ data: null, error: null, isPending: false, refresh: vi.fn() });
  const julia = { ...session, languageId: ComputeLanguageId.make("julia"), label: "Julia" };
  const comments =
    "\r\n # %%\r\n#%%\r\n# In[ ]\r\n## ----\r\n# Average the values\r\n#=\r\n  #= nested =#\r\n  Descriptive notes\r\n=#";
  const code = `${comments}\r\n  mean(values) # Keep the inline comment`;
  const commentsOnlyId = ComputeExecutionId.make("comments-only");
  await using screen = await renderHistory([
    {
      kind: "run",
      key: executionId,
      session: julia,
      execution: {
        request: { ...execution.request, code },
        result: { ...execution.result!, status: "succeeded" },
      },
    },
    {
      kind: "run",
      key: commentsOnlyId,
      session: julia,
      execution: {
        request: { ...execution.request, executionId: commentsOnlyId, code: comments },
        result: { ...execution.result!, executionId: commentsOnlyId, status: "succeeded" },
      },
    },
  ]);
  const title = screen.getByText("mean(values) # Keep the inline comment", { exact: true });
  await expect.element(title).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^Snippet/ })).toBeVisible();
  await title.click();
  await screen.getByRole("button", { name: "Code", exact: true }).click();
  expect(screen.container.querySelector("pre")?.textContent).toBe(code);
});

it("stops a collapsed history run and allows an unresolved quote to be collapsed", async () => {
  const stopRequest = Promise.withResolvers<{ _tag: "Success" }>();
  mocks.cancel.mockReset().mockReturnValue(stopRequest.promise);
  mocks.query.mockReset().mockReturnValue({ data: null, error: null, isPending: true });
  await using _screen = await renderHistory([
    { kind: "run", key: executionId, session, execution },
  ]);
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(cancelComputeQuoteReveal);
  const row = page.getByRole("button", { name: /while True: pass/ });
  await expect.element(row).toHaveAttribute("aria-expanded", "false");
  const stop = page.getByRole("button", { name: "Stop run" });
  await stop.click();
  await expect.element(stop).toBeDisabled();
  await act(() => stopRequest.resolve({ _tag: "Success" }));
  expect(mocks.cancel).toHaveBeenCalledWith({
    environmentId,
    input: { cwd, sessionId, executionId, expectedGeneration: generation },
  });

  await act(async () =>
    requestComputeQuoteReveal({
      ...threadRef,
      kind: "compute",
      version: 1,
      cwd,
      place: { _tag: "run", sessionId, executionId, path: null },
      text: "while True: pass",
      start: 0,
      end: 16,
      prefix: "",
      suffix: "",
    }),
  );
  await expect.element(row).toHaveAttribute("aria-expanded", "true");
  await row.click();
  await expect.element(row).toHaveAttribute("aria-expanded", "false");
});

it("shows one Run All row and fetches its cell list only when expanded", async () => {
  const notebookSource = {
    _tag: "document",
    origin: "cell",
    path: "notebook.ipynb",
    bufferState: "saved",
    revision: null,
    range: null,
    cell: "first-cell",
    notebookBatch: { id: executionId, mode: "all", index: 0, count: 400 },
  } as const;
  const notebookCell: ComputeExecutionRecord = {
    request: { ...execution.request, source: notebookSource },
    result: execution.result,
  };
  const skippedId = ComputeExecutionId.make("second-run");
  const skippedCell: ComputeExecutionRecord = {
    request: {
      ...notebookCell.request,
      executionId: skippedId,
      source: {
        ...notebookSource,
        cell: "second-cell",
        notebookBatch: { ...notebookSource.notebookBatch, index: 1 },
      },
    },
    result: { ...execution.result!, executionId: skippedId, status: "cancelled", startedAt: null },
  };
  mocks.query.mockReset().mockReturnValue({
    data: {
      runs: [{ session, execution: skippedCell }],
      next: null,
    },
    error: null,
    isPending: false,
  });
  await using _screen = await renderHistory([
    {
      kind: "run",
      key: executionId,
      session,
      execution: notebookCell,
      notebookBatch: {
        id: executionId,
        mode: "all",
        count: 400,
        failedCell: 1,
        notRun: 399,
        status: "failed",
      },
    },
  ]);
  const summary = page.getByRole("button", { name: /notebook.ipynb.*Run all/ });
  await expect.element(summary).toHaveAttribute("aria-expanded", "false");
  expect(mocks.query).not.toHaveBeenCalled();
  expect(page.getByRole("button", { name: "Stop run" }).query()).toBeNull();
  expect((await summary.element()).textContent).toContain("Failed at cell 1 of 400 · 399 not run");
  await summary.click();
  const skipped = page.getByRole("button", { name: /Cell 2/ });
  await expect.element(skipped).toBeVisible();
  expect((await skipped.element()).textContent).toContain("Not run");

  mocks.query.mockReset().mockReturnValue({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  });
  await using sessions = await renderHistory(
    [{ kind: "run", key: skippedId, session, execution: skippedCell }],
    undefined,
    false,
  );
  await expect.element(sessions.getByText("Not run", { exact: true })).toBeVisible();
  expect(sessions.getByText("Stopped", { exact: true }).query()).toBeNull();
});

it("keeps Run All progress steady between cells and settles before the next history read", async () => {
  const liveCell = (
    index: number,
    status: NonNullable<ComputeExecutionRecord["result"]>["status"],
  ): ComputeExecutionRecord => {
    const id = index === 0 ? executionId : ComputeExecutionId.make(`cell-${index}`);
    return {
      request: {
        ...execution.request,
        executionId: id,
        source: {
          _tag: "document",
          origin: "cell",
          path: "analysis.ipynb",
          bufferState: "saved",
          revision: null,
          range: null,
          cell: `cell-${index}`,
          notebookBatch: { id: executionId, mode: "all", index, count: 200 },
        },
      },
      result: {
        ...execution.result!,
        executionId: id,
        status,
        startedAt: status === "succeeded" ? execution.request.submittedAt : null,
      },
    };
  };
  const historyData = {
    runs: [
      {
        session,
        execution: liveCell(0, "queued"),
        notebookBatch: { id: executionId, mode: "all", count: 200, status: "queued" },
      },
    ],
    fileRuns: [],
    next: null,
  };
  let eventsData = {
    sessions: new Map([[sessionId, session]]),
    executions: new Map<string, Map<string, ComputeExecutionRecord>>(),
  };
  const historyAtom = computeEnvironment.runHistory({
    environmentId,
    input: { cwd, limit: 30, filter: "" },
  });
  const eventsAtom = computeEnvironment.events({ environmentId, input: { cwd } });
  const refresh = vi.fn();
  mocks.query.mockReset().mockImplementation((atom) => ({
    data: atom === historyAtom ? historyData : atom === eventsAtom ? eventsData : null,
    refresh,
    error: null,
    isPending: false,
  }));
  const view = () => <ComputeProjectHistory cwd={cwd} threadRef={threadRef} />;
  await using screen = await render(view());
  const row = screen.getByRole("button", { name: /analysis\.ipynb.*Run all/ });
  const expectSummary = (text: string) =>
    expect.poll(() => row.query()?.textContent).toContain(text);
  await expectSummary("Queued");
  const progress = async (...cells: ComputeExecutionRecord[]) => {
    eventsData = {
      ...eventsData,
      executions: new Map([
        [sessionId, new Map(cells.map((cell) => [cell.request.executionId, cell]))],
      ]),
    };
    await screen.rerender(view());
  };
  await progress(liveCell(0, "submitting"));
  await expectSummary("Running · cell 1 of 200");
  await progress(liveCell(0, "succeeded"), liveCell(1, "queued"));
  await expectSummary("Running · cell 1 of 200");
  await progress(liveCell(0, "succeeded"), liveCell(1, "submitting"));
  await expectSummary("Running · cell 2 of 200");

  eventsData = {
    ...eventsData,
    sessions: new Map([
      [
        sessionId,
        {
          ...session,
          lastNotebookBatch: { id: executionId, mode: "all", count: 200, status: "succeeded" },
        },
      ],
    ]),
  };
  await screen.rerender(view());
  await expectSummary("200 code cells");
  await expectSummary("Succeeded");
  expect(refresh).toHaveBeenCalled();
});

it("restores the filtered page, scroll and disclosure after visiting Sessions", async () => {
  const filter = "threshold.R";
  const filteredHistory = computeEnvironment.runHistory({
    environmentId,
    input: { cwd, limit: 30, filter },
  });
  const executions = Array.from({ length: 12 }, (_, index): ComputeExecutionRecord => {
    const id = ComputeExecutionId.make(`filter-${index}`);
    return {
      request: {
        ...execution.request,
        executionId: id,
        source: {
          _tag: "document",
          origin: "file",
          path: `runs-${index}/${filter}`,
          bufferState: "saved",
          revision: null,
          range: null,
        },
      },
      result: { ...execution.result!, executionId: id },
    };
  });
  mocks.query.mockReset().mockImplementation((atom) => ({
    data:
      atom === filteredHistory
        ? {
            runs: executions.map((execution) => ({ session, execution })),
            fileRuns: [],
            next: null,
          }
        : null,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }));
  const container = document.createElement("div");
  container.style.cssText = "width: 360px; height: 270px; display: flex; flex-direction: column;";
  await using screen = await render(<ComputeProjectHistory cwd={cwd} threadRef={threadRef} />, {
    container,
  });
  const history = screen.getByRole("region", { name: "Compute history" });
  const search = screen.getByRole("searchbox", { name: "Filter by file" });
  await search.fill(filter);
  const row = history.getByRole("button", { name: /runs-6\/threshold.R/ });
  await row.getByText(`runs-6/${filter}`, { exact: true }).click();
  await expect.element(row).toHaveAttribute("aria-expanded", "true");
  const viewport = container.querySelector<HTMLElement>("[data-assistant-citation-viewport]")!;
  viewport.scrollTop = 130;
  const scrolled = viewport.scrollTop;
  expect(scrolled).toBeGreaterThan(0);
  await screen.getByRole("button", { name: "Sessions", exact: true }).click();
  await expect.element(screen.getByRole("region", { name: "Compute sessions" })).toBeVisible();
  await screen.getByRole("button", { name: "History", exact: true }).click();
  await expect.element(search).toHaveValue(filter);
  await expect.element(row).toHaveAttribute("aria-expanded", "true");
  expect(viewport.scrollTop).toBe(scrolled);
  await screen.getByRole("button", { name: "Clear file filter" }).click();
  await expect.element(search).toHaveValue("");
});

it("opens the exact history receipt from chat even when the run is outside its current page", async () => {
  const targetThread = { ...threadRef, threadId: ThreadId.make("open-run-from-chat") };
  const exact = computeEnvironment.runHistory({
    environmentId,
    input: { cwd, limit: 1, sessionId, executionId },
  });
  mocks.query.mockReset().mockImplementation((atom) => ({
    data: atom === exact ? { runs: [{ session, execution }], fileRuns: [], next: null } : null,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }));
  await using screen = await render(
    <>
      <ComputeToolActivity
        cwd={cwd}
        threadRef={targetThread}
        input={{ code: execution.request.code }}
        output={{ session: { session: sessionId }, run: { run: executionId } }}
        status="completed"
      />
      <ComputeProjectHistory cwd={cwd} threadRef={targetThread} />
    </>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Code", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await screen.getByRole("button", { name: "Open in Compute history" }).click();
  const row = screen
    .getByRole("region", { name: "Compute history" })
    .getByRole("button", { name: /while True: pass/ });
  await expect.element(row).toHaveAttribute("aria-expanded", "true");
});

it("opens a retained one-shot file run from chat", async () => {
  const targetThread = { ...threadRef, threadId: ThreadId.make("open-file-run-from-chat") };
  const runId = AnalysisRunId.make("one-shot-run");
  const snapshot: AnalysisRunSnapshot = {
    contractVersion: 1,
    projectId: "project",
    action: "run-file",
    runtime: {
      id: AnalysisRuntimeId.make("matlab:local"),
      kind: "matlab",
      label: "MATLAB",
      availability: "available",
      source: "custom",
      executablePath: "/matlab",
      version: null,
      detail: null,
      capabilities: ["run-file"],
      inspectedAt: execution.request.submittedAt,
      verification: null,
    },
    source: {
      cwd,
      relativePath: "analysis.m",
      revision: AnalysisSourceRevision.make("source-revision"),
    },
    phase: "finished",
    queuePosition: null,
    diagnostics: [],
    artifacts: [],
    artifactReceipt: { status: "succeeded", failureMessage: null },
    localStorage: {
      status: "retained",
      outputBytes: 0,
      artifactBytes: 0,
      totalBytes: 0,
      removedAt: null,
    },
    receipt: {
      runId,
      status: "succeeded",
      startedAt: execution.request.submittedAt,
      finishedAt: execution.request.submittedAt,
      exitCode: 0,
      failureMessage: null,
      cancellationRequested: false,
      outputTruncated: false,
      outputByteLength: 0,
      outputContentHash: null,
      output: [],
    },
  };
  const exact = analysisEnvironment.run({ environmentId, input: { cwd, runId } });
  mocks.query.mockReset().mockImplementation((atom) => ({
    data: atom === exact ? snapshot : null,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }));
  await using screen = await render(
    <>
      <ComputeToolActivity
        cwd={cwd}
        threadRef={targetThread}
        input={{ path: snapshot.source.relativePath }}
        output={{ run: { run: runId, status: "succeeded", source: "agent: analysis.m" } }}
        status="completed"
      />
      <ComputeProjectHistory cwd={cwd} threadRef={targetThread} />
    </>,
  );
  await screen.getByRole("button", { name: "Open in Compute history" }).click();
  const row = screen
    .getByRole("region", { name: "Compute history" })
    .getByRole("button", { name: /analysis\.m/ });
  await expect.element(row).toHaveAttribute("aria-expanded", "true");
});
