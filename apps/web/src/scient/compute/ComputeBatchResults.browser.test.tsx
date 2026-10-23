import { page, userEvent } from "vitest/browser";
import {
  useComposerDraftStore,
  flushComposerDraftPersistence,
  COMPOSER_DRAFT_STORAGE_KEY,
} from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";
import "../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { StrictMode, useEffect, type ReactNode } from "react";

import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisRunSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

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
  timestampFormat: "24-hour" as "12-hour" | "24-hour" | "locale",
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

vi.mock("~/hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  const getClientSettings = () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    timestampFormat: mocks.timestampFormat,
  });
  return {
    useEnvironmentSettings: () => true,
    getClientSettings,
    useClientSettings: (selector?: (settings: ReturnType<typeof getClientSettings>) => unknown) =>
      selector ? selector(getClientSettings()) : getClientSettings(),
  };
});
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
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

vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
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

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: mocks.toast },
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

function Harness({
  _fixture,
  pending = false,
  controls = true,
  results = true,
  options,
}: {
  pending?: boolean;
  controls?: boolean;
  results?: boolean;
  options?: ComputeBatchRunOptions;
} & { _fixture: _Fixture }) {
  const model = useComputeBatchRun({ ...source, sourcePending: pending }, options);
  useEffect(() => {
    _fixture.publishBatch(model);
  }, [_fixture, model]);
  return results ? <ComputeBatchResults model={model} showRunControls={controls} /> : null;
}
async function render(_fixture: _Fixture, node: ReactNode = <Harness _fixture={_fixture} />) {
  await act(async () => await _fixture.root0.rerender(node));
}
async function click(_fixture: _Fixture, label: string) {
  const button = [..._fixture.container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  const previousDraftState = useComposerDraftStore.getState();
  const previousDraftStorage = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  _fixture.stack.defer(() => {
    useComposerDraftStore.setState(previousDraftState, true);
    flushComposerDraftPersistence();
    if (previousDraftStorage === null) localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    else localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, previousDraftStorage);
  });
  previousDraftState.setPrompt(source.threadRef, "Existing draft");
  _fixture.stack.use(
    vi.spyOn(useComposerDraftStore.getState(), "setPrompt").mockImplementation(mocks.setPrompt),
  );
  _fixture.stack.use(
    vi.spyOn(useRightPanelStore.getState(), "openFile").mockImplementation(mocks.openFile),
  );
  mocks.timestampFormat = "24-hour";
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
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
}

describe("Compute batch lifecycle", () => {
  it.each(["12-hour", "24-hour"] as const)(
    "renders saved batch times using the %s preference",
    async (timestampFormat) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      mocks.timestampFormat = timestampFormat;
      const base = run("first", "succeeded");
      const first = {
        ...base,
        receipt: { ...base.receipt, startedAt: new Date(2026, 8, 15, 17, 4, 3).toISOString() },
      };
      const older = run("older", "failed");
      mocks.values.set("run", AsyncResult.success(first));
      mocks.values.set(
        "runs",
        AsyncResult.success({ runs: [first, older], hasMore: false, nextCursor: null }),
      );
      await render(_fixture);
      const history = await openRunHistory(_fixture);
      const expected = new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: timestampFormat === "12-hour",
      }).format(new Date(first.receipt.startedAt));
      expect(history[0]?.textContent).toContain(expected);
      expect(
        _fixture.container.querySelector('[aria-label="Local MATLAB run history"]')?.textContent,
      ).toContain(expected);
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it("keeps malformed historical batch times out of the visible receipt", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const base = run("malformed", "succeeded");
    const malformed = { ...base, receipt: { ...base.receipt, startedAt: "not-a-date" } };
    mocks.values.set("run", AsyncResult.success(malformed));
    mocks.values.set(
      "runs",
      AsyncResult.success({
        runs: [malformed, run("older", "failed")],
        hasMore: false,
        nextCursor: null,
      }),
    );
    await render(_fixture);
    const history = await openRunHistory(_fixture);
    expect(history[0]?.textContent).toBe("Succeeded · ");
    expect(history.map((item) => item.textContent).join("")).not.toContain("Invalid Date");
  });

  it("stops a reserved run without waiting for the start response", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const pending = deferred<ReturnType<typeof success>>();
    mocks.start.mockReturnValue(pending.promise);
    mocks.cancel.mockImplementation(async ({ input }) => success(run(input.runId, "cancelled")));
    const onRunReserved = vi.fn(() => true);
    await render(_fixture, <Harness _fixture={_fixture} options={{ onRunReserved }} />);
    let started!: ReturnType<ComputeBatchRunModel["start"]>;
    await act(async () => {
      started = _fixture.batch.start();
      expect(await _fixture.batch.cancel()).toBe(true);
    });
    const reservedId = mocks.start.mock.calls[0]![0].input.runId;
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: reservedId, waitForExit: true },
    });
    expect(_fixture.batch.isStarting).toBe(true);
    await act(async () => {
      pending.resolve(success(run(reservedId, "cancelled")));
      await started;
    });
    expect(_fixture.batch.activeRun).toBeNull();
  });

  it("keeps the reserved identity after a disconnected start response without replaying", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onRunReserved = vi.fn(() => true);
    const onStartRejected = vi.fn();
    mocks.start.mockRejectedValue(new Error("connection lost"));
    await render(
      _fixture,
      <Harness _fixture={_fixture} options={{ onRunReserved, onStartRejected }} />,
    );
    await act(async () => {
      expect(await _fixture.batch.start()).toBeNull();
    });
    expect(onRunReserved).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(onStartRejected).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalled();
    expect(_fixture.batch.isStarting).toBe(false);
  });

  it("publishes the accepted run to the parent before resolving start and restores it after remount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onRunStarted = vi.fn();
    await render(_fixture, <Harness _fixture={_fixture} options={{ onRunStarted }} />);
    await act(async () => {
      const started = await _fixture.batch.start();
      expect(onRunStarted).toHaveBeenCalledWith(started);
    });
    const saved = onRunStarted.mock.calls[0]![0] as AnalysisRunSnapshot;
    await render(_fixture, null);
    expect(mocks.cancel).not.toHaveBeenCalled();
    mocks.values.set("run", AsyncResult.success(saved));
    await render(
      _fixture,
      <Harness _fixture={_fixture} options={{ runId: saved.receipt.runId }} />,
    );
    expect(_fixture.batch.activeRun?.receipt.runId).toBe(saved.receipt.runId);
    await act(async () => {
      expect(await _fixture.batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: saved.receipt.runId },
    });
  });

  it("lets the parent close owner cancel a stored run without mounting batch results", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let cancel!: ReturnType<typeof useCancelComputeBatchRun>;
    function CloseOwner() {
      const command = useCancelComputeBatchRun();
      useEffect(() => {
        cancel = command;
      }, [command]);
      return null;
    }
    await render(_fixture, <CloseOwner />);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const old = run("old", "succeeded");
    mocks.values.set("run", AsyncResult.success(old));
    const pending = deferred<ReturnType<typeof success>>();
    mocks.start.mockReturnValue(pending.promise);
    await render(_fixture, <Harness _fixture={_fixture} options={{ runId: old.receipt.runId }} />);
    let cancelled!: Promise<boolean>;
    await act(async () => {
      void _fixture.batch.start();
      cancelled = _fixture.batch.cancel();
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(
      _fixture,
      <StrictMode>
        <Harness _fixture={_fixture} />
      </StrictMode>,
    );
    expect(mocks.start).not.toHaveBeenCalled();
    await act(async () => {
      await _fixture.batch.start();
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
    expect(_fixture.batch.activeRun?.receipt.runId).toBe("batch-1");
    expect(_fixture.batch.canStart).toBe(false);
  });

  it("cancels a just-accepted run before the parent has rendered its new controlled ID", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const old = run("old", "succeeded");
    mocks.values.set("run", AsyncResult.success(old));
    await render(_fixture, <Harness _fixture={_fixture} options={{ runId: old.receipt.runId }} />);
    await act(async () => {
      const current = _fixture.batch;
      await current.start();
      expect(await current.cancel()).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "batch-1" },
    });
  });
  it("coalesces start and cancel and cancels a pending start before subscription delivery", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const pending = deferred<ReturnType<typeof success>>();
    mocks.start.mockReturnValue(pending.promise);
    await render(_fixture, <Harness _fixture={_fixture} results={false} />);
    let started!: ReturnType<ComputeBatchRunModel["start"]>;
    let cancelled!: Promise<boolean>;
    await act(async () => {
      started = _fixture.batch.start();
      expect(_fixture.batch.start()).toBe(started);
      cancelled = _fixture.batch.cancel();
      expect(_fixture.batch.cancel()).toBe(cancelled);
    });
    expect(_fixture.batch.isStarting).toBe(true);
    expect(_fixture.batch.isCancelling).toBe(true);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(async () => {
      const start = _fixture.batch.start;
      await start();
      expect(await start()).toBeNull();
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it("blocks unsaved sources and unavailable runtimes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, <Harness _fixture={_fixture} pending />);
    await act(async () => {
      expect(await _fixture.batch.start()).toBeNull();
    });
    mocks.values.set("runtimes", AsyncResult.success({ runtimes: [] }));
    await render(_fixture);
    await act(async () => {
      expect(await _fixture.batch.start()).toBeNull();
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(_fixture.container.querySelector("a")?.getAttribute("href")).toBe(
      "/settings/scientific-computing?environmentId=remote",
    );
    expect(_fixture.container.querySelector("input")).toBeNull();
    expect(_fixture.container.textContent).not.toMatch(/Use path|Verify again/);
  });
  it("reports cancellation failure to its parent and permits a retry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.values.set("events", AsyncResult.success([run()]));
    mocks.cancel.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("offline")),
    });
    await render(_fixture);
    await act(async () => {
      expect(await _fixture.batch.cancel()).toBe(false);
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to stop batch run", description: "offline" }),
    );
    await act(async () => {
      expect(await _fixture.batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
  });
  it("does not cancel terminal runs and enables a later explicit start", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(async () => {
      await _fixture.batch.start();
    });
    mocks.values.set("events", AsyncResult.success([run("batch-1", "succeeded")]));
    await render(_fixture);
    expect(_fixture.batch.canStart).toBe(true);
    await act(async () => {
      expect(await _fixture.batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => {
      await _fixture.batch.start();
    });
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a finished run when the bounded event stream evicts it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await act(async () => {
      await _fixture.batch.start();
    });
    mocks.values.set("events", AsyncResult.success([run("batch-1", "succeeded")]));
    await render(_fixture);
    mocks.values.set("events", AsyncResult.success([]));
    await render(_fixture);
    expect(_fixture.batch.activeRun).toBeNull();
    expect(_fixture.batch.canStart).toBe(true);
    await act(async () => {
      expect(await _fixture.batch.cancel()).toBe(true);
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("settles a rejected pending start without issuing a phantom cancellation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const pending = deferred<unknown>();
    mocks.start.mockReturnValue(pending.promise);
    await render(_fixture);
    let cancelled!: Promise<boolean>;
    await act(async () => {
      void _fixture.batch.start();
      cancelled = _fixture.batch.cancel();
    });
    await act(async () => {
      pending.resolve({ _tag: "Failure", cause: Cause.fail(new Error("Source changed")) });
      expect(await cancelled).toBe(true);
    });
    expect(_fixture.batch.isStarting).toBe(false);
    expect(_fixture.batch.isCancelling).toBe(false);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Source changed" }),
    );
  });
});

describe("Compute batch results", () => {
  it("keeps Stop available in embedded results and targets the controlled run", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const owned = run("owned");
    mocks.values.set("events", AsyncResult.success([owned, run("other")]));
    await render(
      _fixture,
      <Harness
        _fixture={_fixture}
        controls={false}
        options={{ runId: owned.receipt.runId, onRunReserved: () => true }}
      />,
    );
    await click(_fixture, "Stop");
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: owned.receipt.runId },
    });
  });

  it("does not substitute another run's output while restoring the owned run", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const other = run("other", "succeeded");
    mocks.values.set(
      "events",
      AsyncResult.success([
        {
          ...other,
          artifacts: [{ artifactId: "other-figure", kind: "figure", representations: [] }],
          receipt: {
            ...other.receipt,
            output: [{ sequence: 1, stream: "stdout", text: "OTHER_RUN_OUTPUT" }],
          },
        },
      ]),
    );
    await render(
      _fixture,
      <Harness
        _fixture={_fixture}
        controls={false}
        options={{ runId: run("pending").receipt.runId, onRunReserved: () => true }}
      />,
    );
    expect(_fixture.container.textContent).not.toContain("OTHER_RUN_OUTPUT");
    expect(mocks.artifacts).not.toHaveBeenCalled();
    expect(_fixture.container.querySelector('[aria-label="Local MATLAB run history"]')).toBeNull();
    expect(_fixture.container.textContent).toContain("Waiting for this batch run");
    expect(_fixture.container.textContent).not.toContain("Run MATLAB batch to see output");
    await click(_fixture, "Stop");
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "pending" },
    });
  });

  it("hides its own execution controls by default", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    function DefaultResults() {
      const model = useComputeBatchRun(source);
      return <ComputeBatchResults model={model} />;
    }
    await render(_fixture, <DefaultResults />);
    expect(
      [..._fixture.container.querySelectorAll("button")].some(
        (button) => button.textContent === "Run MATLAB batch",
      ),
    ).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("passes AnalysisRun artifacts to the existing artifact strip", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture);
    expect(mocks.artifacts).toHaveBeenLastCalledWith({
      environmentId: source.environmentId,
      threadRef: source.threadRef,
      run: completed,
      status: "current",
    });
    expect(_fixture.container.textContent).toContain("Batch figures");
  });
  it("retains diagnostics, raw output, truncation and Save to project without run controls", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await render(_fixture, <Harness _fixture={_fixture} controls={false} />);
    expect(_fixture.container.textContent).toContain("Bad input");
    expect(_fixture.container.textContent).toContain("raw failure");
    expect(_fixture.container.textContent).toContain("Output was truncated");
    expect(_fixture.container.textContent).not.toContain("Run fresh");
    await click(_fixture, "analysis.m:4");
    expect(mocks.openFile).toHaveBeenCalledWith(source.threadRef, "analysis.m", 4);
    await click(_fixture, "Ask agent");
    expect(mocks.setPrompt).toHaveBeenCalledWith(
      source.threadRef,
      expect.stringContaining("Existing draft\n\nPlease diagnose"),
    );
    await click(_fixture, "Save to project");
    expect(mocks.promote).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, runId: "batch-1" },
    });
    expect(mocks.openFile).toHaveBeenCalledWith(source.threadRef, "results/batch/README.md");
  });
  it("loads saved history even when MATLAB is unavailable and never starts on history selection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const first = run("first", "succeeded");
    const older = run("older", "failed");
    mocks.values.set("runtimes", AsyncResult.success({ runtimes: [] }));
    mocks.values.set(
      "runs",
      AsyncResult.success({ runs: [first, older], hasMore: true, nextCursor: "page-2" }),
    );
    mocks.values.set("run", AsyncResult.success(older));
    await render(_fixture);
    const history = await openRunHistory(_fixture);
    expect(history[1]?.textContent).toContain("Failed");
    await page.elementLocator(history[1]!).click();
    expect(history[1]?.getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[role="menu"]')).toBeNull();
    await click(_fixture, "Save to project");
    expect(mocks.promote).toHaveBeenCalledWith(
      expect.objectContaining({ input: { cwd: source.cwd, runId: "older" } }),
    );
    await click(_fixture, "Load older runs");
    expect(mocks.runs).toHaveBeenLastCalledWith({
      environmentId: source.environmentId,
      input: { cwd: source.cwd, relativePath: source.relativePath, limit: 30, cursor: "page-2" },
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("keeps removed output metadata and hides Save to project", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const removed = {
      ...run("removed", "succeeded"),
      localStorage: { ...run().localStorage, status: "metadata-only", totalBytes: 0 },
    };
    mocks.values.set("events", AsyncResult.success([removed]));
    await render(_fixture);
    expect(_fixture.container.textContent).toContain(
      "Local output and artifact files were removed",
    );
    expect(_fixture.container.textContent).not.toContain("Save to project");
  });
  it("allows an explicit run control without requiring another file panel", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(
      _fixture.container.querySelector('section[aria-label="MATLAB batch Results"]'),
    ).not.toBeNull();
    await click(_fixture, "Run MATLAB batch");
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});

function _createFixture() {
  let _published_batch = undefined! as ComputeBatchRunModel;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get batch() {
      return _published_batch;
    },
    publishBatch(next: typeof _published_batch) {
      _published_batch = next;
      return next;
    },

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

async function openRunHistory(_fixture: _Fixture) {
  const trigger = _fixture.container.querySelector<HTMLButtonElement>(
    '[aria-label="Local MATLAB run history"]',
  )!;
  expect(trigger).not.toBeNull();
  await page.elementLocator(trigger).click();
  return await vi.waitFor(() => {
    const choices = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(choices).toHaveLength(2);
    return choices;
  });
}
