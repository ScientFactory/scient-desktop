// @vitest-environment happy-dom
import {
  act,
  cloneElement,
  isValidElement,
  StrictMode,
  useEffect,
  type ReactNode,
  type ComponentProps,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisRunSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  start: vi.fn(),
  cancel: vi.fn(),
  promote: vi.fn(),
  cleanup: vi.fn(),
  refresh: vi.fn(),
  openFile: vi.fn(),
  toast: vi.fn(),
  setPrompt: vi.fn(),
  artifacts: vi.fn(),
  runs: vi.fn(),
}));
vi.mock("~/state/analysis", () => ({
  analysisEnvironment: {
    runtimes: () => "runtimes",
    runEvents: () => "events",
    storage: () => "storage",
    runs: (input: unknown) => {
      mocks.runs(input);
      return "runs";
    },
    run: () => "run",
    startRun: "start",
    cancelRun: "cancel",
    promoteRun: "promote",
    cleanupRun: "cleanup",
    cleanupProject: "cleanup",
  },
}));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => mocks.values.get(atom),
  useAtomRefresh: () => mocks.refresh,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "start" | "cancel" | "promote" | "cleanup") => mocks[command],
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data:
      atom === null
        ? null
        : ((mocks.values.get(atom) as { value?: unknown } | undefined)?.value ?? null),
  }),
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ render, children, ...props }: ComponentProps<"button"> & { render?: ReactNode }) =>
    isValidElement(render) ? (
      cloneElement(render, {}, children)
    ) : (
      <button {...props}>{children}</button>
    ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search: { environmentId: string };
    children: ReactNode;
  }) => <a href={`${to}?environmentId=${search.environmentId}`}>{children}</a>,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuRadioGroup: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => (
    <div
      onClick={(event) => {
        const value = (event.target as HTMLElement).getAttribute("data-run");
        if (value) onValueChange(value);
      }}
    >
      {children}
    </div>
  ),
  MenuRadioItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <button data-run={value}>{children}</button>
  ),
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: mocks.toast },
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: mocks.openFile }) },
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: () => ({ prompt: "Existing draft" }),
      setPrompt: mocks.setPrompt,
    }),
  },
}));
vi.mock("../analysis/AnalysisArtifactStrip", () => ({
  AnalysisArtifactStrip: (props: unknown) => {
    mocks.artifacts(props);
    return <div>Batch figures</div>;
  },
}));

import {
  ComputeBatchResults,
  useComputeBatchRun,
  type ComputeBatchRunOptions,
  type ComputeBatchRunModel,
  type ComputeBatchSource,
} from "./ComputeBatchResults";
import { useCancelComputeBatchRun } from "./useCancelComputeBatchRun";

const source: ComputeBatchSource = {
  environmentId: EnvironmentId.make("remote"),
  threadRef: { environmentId: "remote", threadId: "thread" } as ScopedThreadRef,
  cwd: "/project",
  relativePath: "analysis.m",
  sourceRevision: "sha256:saved",
  sourcePending: false,
  runtimeKind: "matlab",
  runtimeLabel: "MATLAB",
};
function run(
  id = "batch-1",
  status: AnalysisRunSnapshot["receipt"]["status"] = "running",
): AnalysisRunSnapshot {
  return {
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
      version: "R2026a",
      detail: null,
      capabilities: ["run-file"],
      inspectedAt: "2026-09-15T00:00:00.000Z",
      verification: null,
    },
    source: {
      cwd: source.cwd,
      relativePath: source.relativePath,
      revision: AnalysisSourceRevision.make(source.sourceRevision),
    },
    phase: status === "running" ? "running" : "finished",
    queuePosition: null,
    diagnostics: [],
    artifacts: [],
    artifactReceipt: { status: "succeeded", failureMessage: null },
    localStorage: {
      status: "retained",
      outputBytes: 12,
      artifactBytes: 0,
      totalBytes: 12,
      removedAt: null,
    },
    receipt: {
      runId: id as AnalysisRunSnapshot["receipt"]["runId"],
      status,
      startedAt: "2026-09-15T00:00:00.000Z",
      finishedAt: status === "running" ? null : "2026-09-15T00:01:00.000Z",
      exitCode: status === "succeeded" ? 0 : null,
      failureMessage: null,
      cancellationRequested: false,
      outputTruncated: false,
      outputByteLength: 12,
      outputContentHash: null,
      output: [],
    },
  };
}
function success(value: unknown) {
  return { _tag: "Success", value };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
let batch: ComputeBatchRunModel;
function Harness({
  pending = false,
  controls = true,
  results = true,
  options,
}: {
  pending?: boolean;
  controls?: boolean;
  results?: boolean;
  options?: ComputeBatchRunOptions;
}) {
  const model = useComputeBatchRun({ ...source, sourcePending: pending }, options);
  useEffect(() => {
    batch = model;
  }, [model]);
  return results ? <ComputeBatchResults model={model} showRunControls={controls} /> : null;
}
async function render(node: ReactNode = <Harness />) {
  await act(async () => root.render(node));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.values.clear();
  mocks.values.set("runtimes", AsyncResult.success({ runtimes: [run().runtime] }));
  mocks.values.set("events", AsyncResult.success([]));
  mocks.values.set("runs", AsyncResult.success({ runs: [], hasMore: false, nextCursor: null }));
  mocks.values.set("storage", AsyncResult.success({ totalBytes: 0, retainedRunCount: 0 }));
  mocks.start.mockResolvedValue(success(run()));
  mocks.cancel.mockResolvedValue(success(run("batch-1", "cancelled")));
  mocks.promote.mockResolvedValue(
    success({
      reused: false,
      readmeRelativePath: "results/batch/README.md",
      directoryRelativePath: "results/batch",
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Compute batch lifecycle", () => {
  it("keeps the reserved identity after a disconnected start response without replaying", async () => {
    const onRunReserved = vi.fn(() => true);
    const onStartRejected = vi.fn();
    mocks.start.mockRejectedValue(new Error("connection lost"));
    await render(<Harness options={{ onRunReserved, onStartRejected }} />);
    await act(async () => {
      expect(await batch.start()).toBeNull();
    });
    expect(onRunReserved).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(onStartRejected).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalled();
    expect(batch.isStarting).toBe(false);
  });

  it("publishes the accepted run to the parent before resolving start and restores it after remount", async () => {
    const onRunStarted = vi.fn();
    await render(<Harness options={{ onRunStarted }} />);
    await act(async () => {
      const started = await batch.start();
      expect(onRunStarted).toHaveBeenCalledWith(started);
    });
    const saved = onRunStarted.mock.calls[0]![0] as AnalysisRunSnapshot;
    await render(null);
    expect(mocks.cancel).not.toHaveBeenCalled();
    mocks.values.set("run", AsyncResult.success(saved));
    await render(<Harness options={{ runId: saved.receipt.runId }} />);
    expect(batch.activeRun?.receipt.runId).toBe(saved.receipt.runId);
    await act(async () => {
      expect(await batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: saved.receipt.runId },
    });
  });

  it("lets the parent close owner cancel a stored run without mounting batch results", async () => {
    let cancel!: ReturnType<typeof useCancelComputeBatchRun>;
    function CloseOwner() {
      const command = useCancelComputeBatchRun();
      useEffect(() => {
        cancel = command;
      }, [command]);
      return null;
    }
    await render(<CloseOwner />);
    expect(mocks.start).not.toHaveBeenCalled();
    await act(async () => {
      expect(
        await cancel({
          environmentId: source.environmentId,
          cwd: source.cwd,
          runId: run("stored").receipt.runId,
        }),
      ).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "stored" },
    });
    // A terminal response for another identity cannot dismiss this owner.
    await act(async () => {
      expect(
        await cancel({
          environmentId: source.environmentId,
          cwd: source.cwd,
          runId: run("stored").receipt.runId,
          waitForExit: true,
        }),
      ).toBe(false);
    });
    mocks.cancel.mockResolvedValue(success(run("stored", "cancelled")));
    await act(async () => {
      expect(
        await cancel({
          environmentId: source.environmentId,
          cwd: source.cwd,
          runId: run("stored").receipt.runId,
          waitForExit: true,
        }),
      ).toBe(true);
    });
  });

  it("cancels the pending new run even when the controlled ID still names its predecessor", async () => {
    const old = run("old", "succeeded");
    mocks.values.set("run", AsyncResult.success(old));
    const pending = deferred<ReturnType<typeof success>>();
    mocks.start.mockReturnValue(pending.promise);
    await render(<Harness options={{ runId: old.receipt.runId }} />);
    let cancelled!: Promise<boolean>;
    await act(async () => {
      void batch.start();
      cancelled = batch.cancel();
    });
    await act(async () => {
      pending.resolve(success(run("new")));
      expect(await cancelled).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "new" },
    });
  });

  it("mounts passively and uses the direct batch request with the saved revision", async () => {
    await render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    expect(mocks.start).not.toHaveBeenCalled();
    await act(async () => {
      await batch.start();
    });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: {
        runId: expect.any(String),
        cwd: source.cwd,
        relativePath: source.relativePath,
        sourceRevision: source.sourceRevision,
        runtimeId: "matlab:local",
      },
    });
    expect(batch.activeRun?.receipt.runId).toBe("batch-1");
    expect(batch.canStart).toBe(false);
  });

  it("cancels a just-accepted run before the parent has rendered its new controlled ID", async () => {
    const old = run("old", "succeeded");
    mocks.values.set("run", AsyncResult.success(old));
    await render(<Harness options={{ runId: old.receipt.runId }} />);
    await act(async () => {
      const current = batch;
      await current.start();
      expect(await current.cancel()).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "batch-1" },
    });
  });
  it("coalesces start and cancel and cancels a pending start before subscription delivery", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    mocks.start.mockReturnValue(pending.promise);
    await render(<Harness results={false} />);
    let started!: ReturnType<ComputeBatchRunModel["start"]>;
    let cancelled!: Promise<boolean>;
    await act(async () => {
      started = batch.start();
      expect(batch.start()).toBe(started);
      cancelled = batch.cancel();
      expect(batch.cancel()).toBe(cancelled);
    });
    expect(batch.isStarting).toBe(true);
    expect(batch.isCancelling).toBe(true);
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(success(run()));
      await started;
      expect(await cancelled).toBe(true);
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "batch-1" },
    });
  });
  it("rejects a second start while the accepted run has not reached the stream", async () => {
    await render();
    await act(async () => {
      const start = batch.start;
      await start();
      expect(await start()).toBeNull();
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it("blocks unsaved sources and unavailable runtimes", async () => {
    await render(<Harness pending />);
    await act(async () => {
      expect(await batch.start()).toBeNull();
    });
    mocks.values.set("runtimes", AsyncResult.success({ runtimes: [] }));
    await render();
    await act(async () => {
      expect(await batch.start()).toBeNull();
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/settings/scientific-computing?environmentId=remote",
    );
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toMatch(/Use path|Verify again/);
  });
  it("reports cancellation failure to its parent and permits a retry", async () => {
    mocks.values.set("events", AsyncResult.success([run()]));
    mocks.cancel.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("offline")),
    });
    await render();
    await act(async () => {
      expect(await batch.cancel()).toBe(false);
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to stop batch run", description: "offline" }),
    );
    await act(async () => {
      expect(await batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
  });
  it("does not cancel terminal runs and enables a later explicit start", async () => {
    await render();
    await act(async () => {
      await batch.start();
    });
    mocks.values.set("events", AsyncResult.success([run("batch-1", "succeeded")]));
    await render();
    expect(batch.canStart).toBe(true);
    await act(async () => {
      expect(await batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => {
      await batch.start();
    });
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a finished run when the bounded event stream evicts it", async () => {
    await render();
    await act(async () => {
      await batch.start();
    });
    mocks.values.set("events", AsyncResult.success([run("batch-1", "succeeded")]));
    await render();
    mocks.values.set("events", AsyncResult.success([]));
    await render();
    expect(batch.activeRun).toBeNull();
    expect(batch.canStart).toBe(true);
    await act(async () => {
      expect(await batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("settles a rejected pending start without issuing a phantom cancellation", async () => {
    const pending = deferred<unknown>();
    mocks.start.mockReturnValue(pending.promise);
    await render();
    let cancelled!: Promise<boolean>;
    await act(async () => {
      void batch.start();
      cancelled = batch.cancel();
    });
    await act(async () => {
      pending.resolve({ _tag: "Failure", cause: Cause.fail(new Error("Source changed")) });
      expect(await cancelled).toBe(true);
    });
    expect(batch.isStarting).toBe(false);
    expect(batch.isCancelling).toBe(false);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Source changed" }),
    );
  });
});

describe("Compute batch results", () => {
  it("hides its own execution controls by default", async () => {
    function DefaultResults() {
      const model = useComputeBatchRun(source);
      return <ComputeBatchResults model={model} />;
    }
    await render(<DefaultResults />);
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Run MATLAB batch",
      ),
    ).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("passes AnalysisRun artifacts to the existing artifact strip", async () => {
    const completed = {
      ...run("figures", "succeeded"),
      artifacts: [
        {
          artifactId: "figure-1",
          kind: "figure",
          label: "Figure 1",
          createdAt: "2026-09-15T00:00:00.000Z",
          representations: [
            {
              representationId: "png",
              fileName: "figure.png",
              mediaType: "image/png",
              presentation: "static",
              requiresNetworkForFullExperience: false,
              contentHash: `sha256:${"0".repeat(64)}`,
              byteLength: 12,
            },
          ],
        },
      ],
    };
    mocks.values.set("events", AsyncResult.success([completed]));
    await render();
    expect(mocks.artifacts).toHaveBeenLastCalledWith({
      environmentId: source.environmentId,
      threadRef: source.threadRef,
      run: completed,
      status: "current",
    });
    expect(container.textContent).toContain("Batch figures");
  });
  it("retains diagnostics, raw output, truncation and Save to project without run controls", async () => {
    const completed = run("batch-1", "failed");
    const diagnostic = {
      diagnosticId: "diag-1",
      code: "MATLAB:error",
      message: "Bad input",
      relativePath: "analysis.m",
      line: 4,
      frames: [],
      related: [],
    };
    mocks.values.set(
      "events",
      AsyncResult.success([
        {
          ...completed,
          diagnostics: [diagnostic],
          receipt: {
            ...completed.receipt,
            outputTruncated: true,
            output: [{ sequence: 1, stream: "stderr", text: "raw failure" }],
          },
        },
      ]),
    );
    await render(<Harness controls={false} />);
    expect(container.textContent).toContain("Bad input");
    expect(container.textContent).toContain("raw failure");
    expect(container.textContent).toContain("Output was truncated");
    expect(container.textContent).not.toContain("Run fresh");
    await click("analysis.m:4");
    expect(mocks.openFile).toHaveBeenCalledWith(source.threadRef, "analysis.m", 4);
    await click("Ask agent");
    expect(mocks.setPrompt).toHaveBeenCalledWith(
      source.threadRef,
      expect.stringContaining("Existing draft\n\nPlease diagnose"),
    );
    await click("Save to project");
    expect(mocks.promote).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "batch-1" },
    });
    expect(mocks.openFile).toHaveBeenCalledWith(source.threadRef, "results/batch/README.md");
  });
  it("loads saved history even when MATLAB is unavailable and never starts on history selection", async () => {
    const first = run("first", "succeeded"),
      older = run("older", "failed");
    mocks.values.set("runtimes", AsyncResult.success({ runtimes: [] }));
    mocks.values.set(
      "runs",
      AsyncResult.success({ runs: [first, older], hasMore: true, nextCursor: "page-2" }),
    );
    mocks.values.set("run", AsyncResult.success(older));
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-run="older"]')!.click(),
    );
    await click("Save to project");
    expect(mocks.promote).toHaveBeenCalledWith(
      expect.objectContaining({ input: { cwd: source.cwd, runId: "older" } }),
    );
    await click("Load older runs");
    expect(mocks.runs).toHaveBeenLastCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, relativePath: source.relativePath, limit: 30, cursor: "page-2" },
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("keeps removed output metadata and hides Save to project", async () => {
    const removed = {
      ...run("removed", "succeeded"),
      localStorage: { ...run().localStorage, status: "metadata-only", totalBytes: 0 },
    };
    mocks.values.set("events", AsyncResult.success([removed]));
    await render();
    expect(container.textContent).toContain("Local output and artifact files were removed");
    expect(container.textContent).not.toContain("Save to project");
  });
  it("allows an explicit run control without requiring another file panel", async () => {
    await render();
    expect(container.querySelector('section[aria-label="MATLAB batch Results"]')).not.toBeNull();
    await click("Run MATLAB batch");
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
