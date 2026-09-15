// @vitest-environment happy-dom
import {
  ComputeLanguageId,
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
  type ComputeLanguageRuntimeInspection,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";
import { act, createRef, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  languages: [] as ComputeLanguageRuntimeInspection[],
  managedStatus: null as ComputeManagedRuntimeStatus | null,
  sessions: [] as unknown[],
  markup: "",
  buttons: [] as Array<ComponentProps<"button">>,
  menuItems: [] as Array<ComponentProps<"button">>,
  start: vi.fn(),
  stop: vi.fn(),
  confirmation: null as null | {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  },
  submit: vi.fn(),
  refresh: vi.fn(),
  runRequested: vi.fn(),
}));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    sessions: () => "sessions",
    events: () => "events",
    runtimes: () => "runtimes",
    startSession: "start",
    submitExecution: "submit",
    refreshRuntimes: "refresh",
    stopSession: "stop",
    manageRuntime: "manage",
    cancelManagedRuntime: "cancel",
    managedRuntime: () => "managed-status",
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ languages: { python: { enabled: true, executable: "" } } }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateSettings: "update" },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data:
      query === "runtimes"
        ? { languages: mocks.languages }
        : query === "sessions"
          ? mocks.sessions
          : query === "managed-status"
            ? mocks.managedStatus
            : null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "start"
      ? mocks.start
      : command === "stop"
        ? mocks.stop
        : command === "submit"
          ? mocks.submit
          : mocks.refresh,
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    mocks.buttons.push(props);
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));
vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialog: () => null,
  AlertDialogClose: () => null,
  AlertDialogDescription: () => null,
  AlertDialogFooter: () => null,
  AlertDialogHeader: () => null,
  AlertDialogPopup: () => null,
  AlertDialogTitle: () => null,
}));
vi.mock("~/components/ui/contextual-confirmation", () => ({
  ContextualConfirmation: (props: NonNullable<typeof mocks.confirmation>) => {
    mocks.confirmation = props;
    return null;
  },
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuItem: (props: ComponentProps<"button">) => {
    mocks.menuItems.push(props);
    return null;
  },
  MenuSeparator: () => null,
}));

import { MATLAB_COMPUTE_SOURCE, PYTHON_COMPUTE_SOURCE } from "./computeSourceLanguage";

import { ComputeFileActions, type ComputeFileActionsHandle } from "./ComputeFileActions";
import {
  ensureComputeContext,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";

const testEnvironmentId = EnvironmentId.make("remote-server");
const testContextId = "compute-file-test" as ComputeContextId;

function runtime(
  source: "managed" | "path",
  ready = true,
): ComputeLanguageRuntimeInspection["runtimes"][number] {
  const profile = {
    languageId: ComputeLanguageId.make("python"),
    executable: `/${source}/python`,
    languageVersion: "3.12.13",
    architecture: null,
    displayName: "Python",
    source,
  };
  return {
    profile,
    verification: {
      profile,
      readiness: ready ? "ready" : "missing-requirement",
      missingRequirements: ready ? [] : ["ipykernel"],
      message: null,
      packages: [],
    },
    toolkits: [],
  };
}
function render(
  candidates = [runtime("managed")],
  contextId: ComputeContextId | undefined = undefined,
  language = PYTHON_COMPUTE_SOURCE,
) {
  mocks.languages = [
    {
      descriptor: {
        languageId: language.languageId,
        displayName: language.displayName,
        sourceExtensions: [],
        capabilities: [],
      },
      enabled: true,
      configuredExecutable: null,
      managedRuntime: null,
      toolkits: [],
      runtimes: candidates,
    },
  ];
  mocks.markup = renderToStaticMarkup(
    <ComputeFileActions
      language={language}
      environmentId={testEnvironmentId}
      cwd="/project"
      relativePath="test.py"
      contents="print(1)"
      sourceRevision="revision-1"
      sourcePending={false}
      selection={null}
      editorSelection={null}
      {...(contextId === undefined ? {} : { contextId })}
      onRunRequested={mocks.runRequested}
      onShowMatlabOneShot={vi.fn()}
      onExecutionSubmitted={vi.fn()}
    />,
  );
  return mocks.buttons.findLast((button) => button["aria-label"] === "Run file")!;
}

describe("Python file run actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buttons = [];
    mocks.menuItems = [];
    mocks.managedStatus = null;
    mocks.sessions = [];
    mocks.markup = "";
    mocks.confirmation = null;
    mocks.stop.mockReset();
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { sessionId: ComputeSessionId.make("new-session"), generation: 1 },
    });
    mocks.submit.mockResolvedValue({ _tag: "Success", value: {} });
    useComputeContextStore.setState({ bindings: {} });
  });

  it("resolves the current default on the correct server instead of pinning a cached executable", async () => {
    const button = render();
    expect(button.disabled).toBe(false);
    // Invoke the real event handler without launching a browser or executing Python.
    button.onClick?.({} as Parameters<NonNullable<typeof button.onClick>>[0]);
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.runRequested).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId: "remote-server",
      input: {
        cwd: "/project",
        sessionId: expect.any(String),
        languageId: "python",
        executable: null,
      },
    });
    expect(mocks.submit.mock.calls[0]?.[0].input).toMatchObject({
      sessionId: "new-session",
      code: "print(1)",
    });
  });

  it("reserves a fresh child before its single start-and-run request without replacing the session", async () => {
    ensureComputeContext({
      contextId: testContextId,
      environmentId: testEnvironmentId,
      cwd: "/project",
      ownerKey: "file",
    });
    const persistent = ComputeSessionId.make("persistent");
    useComputeContextStore
      .getState()
      .reserveSession({ contextId: testContextId, sessionId: persistent });
    mocks.start.mockImplementation(
      async ({ input }: { input: { sessionId: ComputeSessionId } }) => {
        expect(
          Object.values(useComputeContextStore.getState().bindings).some(
            (binding) =>
              binding.parentContextId === testContextId && binding.sessionId === input.sessionId,
          ),
        ).toBe(true);
        return {
          _tag: "Success",
          value: { sessionId: input.sessionId, generation: 1, status: "starting" },
        };
      },
    );
    render(undefined, testContextId);
    const fresh = mocks.menuItems.findLast((item) => item.children === "Run fresh")!;
    expect(fresh.disabled).toBe(false);
    fresh.onClick?.({} as Parameters<NonNullable<typeof fresh.onClick>>[0]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.start.mock.calls[0]?.[0].input.runOnce).toMatchObject({
      code: "print(1)",
      source: { origin: "file", path: "test.py", bufferState: "saved" },
    });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(useComputeContextStore.getState().bindings[testContextId]?.sessionId).toBe(persistent);
  });

  it.each([
    "success",
    "cancel",
    "failed",
    "thrown",
    "nonterminal",
    "wrong-owner",
    "wrong-generation",
    "closed-during-stop",
    "changed-before-stop",
  ])(
    "recovers a one-slot fresh rejection only after explicit, exact shutdown (%s)",
    async (outcome) => {
      render();
      const sessionId = ComputeSessionId.make("retained-session");
      ensureComputeContext({
        contextId: testContextId,
        environmentId: testEnvironmentId,
        cwd: "/project",
        ownerKey: "file",
      });
      useComputeContextStore.getState().reserveSession({ contextId: testContextId, sessionId });
      useComputeContextStore.getState().bindSession({
        contextId: testContextId,
        sessionId,
        generation: ComputeSessionGeneration.make(1),
      });
      mocks.sessions = [
        {
          sessionId,
          generation: 1,
          languageId: "python",
          label: "Python",
          workingDirectory: "/project",
          status: "ready",
          activity: "idle",
          runtime: runtime("managed").profile,
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ];
      mocks.start.mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail({ reason: "capacity-reached", message: "One slot in use" }),
      });
      mocks.start.mockImplementation(async ({ input }) => ({
        _tag: "Success",
        value: { sessionId: input.sessionId, generation: 1, status: "starting" },
      }));
      let finishStop: ((value: unknown) => void) | undefined;
      mocks.stop.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishStop = resolve;
          }),
      );
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(() =>
          root.render(
            <ComputeFileActions
              language={PYTHON_COMPUTE_SOURCE}
              environmentId={testEnvironmentId}
              cwd="/project"
              relativePath="test.py"
              contents="print(1)"
              sourceRevision="revision-1"
              sourcePending={false}
              selection={null}
              editorSelection={null}
              contextId={testContextId}
              onRunRequested={mocks.runRequested}
              onShowMatlabOneShot={vi.fn()}
              onExecutionSubmitted={vi.fn()}
            />,
          ),
        );
        await act(async () => {
          mocks.menuItems.findLast((item) => item.children === "Run fresh")!.onClick?.({} as never);
        });
        expect(mocks.start).toHaveBeenCalledTimes(1);
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(
          mocks.menuItems.some((item) => item.children === "No active sessions in this project"),
        ).toBe(false);
        await act(() => {
          mocks.menuItems
            .findLast((item) => item.children === "Stop this session and run fresh…")!
            .onClick?.({} as never);
        });
        expect(mocks.confirmation?.open).toBe(true);
        expect(mocks.stop).not.toHaveBeenCalled();
        if (outcome === "cancel") {
          await act(() => mocks.confirmation!.onOpenChange(false));
          expect(mocks.stop).not.toHaveBeenCalled();
          return;
        }
        if (outcome === "changed-before-stop") {
          useComputeContextStore.setState({ bindings: {} });
        }
        if (outcome === "thrown") mocks.stop.mockRejectedValueOnce(new Error("Disconnected"));
        await act(async () => {
          const confirm = mocks.confirmation!;
          confirm.onOpenChange(false);
          confirm.onConfirm();
          if (outcome === "success") confirm.onConfirm();
        });
        expect(mocks.start).toHaveBeenCalledTimes(1);
        if (outcome === "changed-before-stop") {
          expect(mocks.stop).not.toHaveBeenCalled();
          return;
        }
        expect(mocks.stop).toHaveBeenCalledWith({
          environmentId: testEnvironmentId,
          input: { cwd: "/project", sessionId, expectedGeneration: 1 },
        });
        expect(mocks.stop).toHaveBeenCalledTimes(1);
        if (outcome === "thrown") return;
        if (outcome === "closed-during-stop") useComputeContextStore.setState({ bindings: {} });
        await act(async () => {
          finishStop!(
            outcome === "failed"
              ? { _tag: "Failure", cause: Cause.fail(new Error("Cleanup failed")) }
              : {
                  _tag: "Success",
                  value: {
                    sessionId: outcome === "wrong-owner" ? "another-session" : sessionId,
                    generation: outcome === "wrong-generation" ? 2 : 1,
                    status: outcome === "nonterminal" ? "closing" : "stopped",
                  },
                },
          );
        });
        expect(mocks.start).toHaveBeenCalledTimes(outcome === "success" ? 2 : 1);
        expect(mocks.submit).not.toHaveBeenCalled();
      } finally {
        await act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([true, false])(
    "keeps Run file literal and respects runtime availability (%s)",
    async (ready) => {
      render([runtime("managed", ready)]);
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      const ref = createRef<ComputeFileActionsHandle>();
      const contents = "# %% First\nprint(1)\n# %% Second\nprint(2)";
      try {
        await act(() =>
          root.render(
            <ComputeFileActions
              ref={ref}
              language={PYTHON_COMPUTE_SOURCE}
              environmentId={testEnvironmentId}
              cwd="/project"
              relativePath="test.py"
              contents={contents}
              sourceRevision="revision-1"
              sourcePending={false}
              selection={{ start: 2, end: 2 }}
              editorSelection={{ start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }}
              onRunRequested={mocks.runRequested}
              onShowMatlabOneShot={vi.fn()}
              onExecutionSubmitted={vi.fn()}
            />,
          ),
        );
        await act(async () => {
          ref.current!.runFile();
        });
        if (ready) {
          expect(mocks.submit).toHaveBeenCalledOnce();
          expect(mocks.submit.mock.calls[0]?.[0].input).toMatchObject({
            code: contents,
            source: { origin: "file" },
          });
        } else {
          expect(mocks.start).not.toHaveBeenCalled();
          expect(mocks.submit).not.toHaveBeenCalled();
          expect(mocks.runRequested).not.toHaveBeenCalled();
        }
      } finally {
        await act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["failed", "operating"])(
    "does not block a ready system runtime when managed setup is %s",
    (state) => {
      mocks.managedStatus = {
        installed: true,
        selection: "existing",
        updateAvailable: false,
        runtimeVersion: null,
        toolkitRevision: null,
        generationId: "g1",
        operation:
          state === "operating"
            ? {
                operationId: "operation-1",
                action: "repair",
                phase: "verifying",
                startedAt: "2026-09-14T12:00:00.000Z",
                downloadedBytes: null,
                totalBytes: null,
              }
            : null,
        failureMessage: state === "failed" ? "Could not remove managed runtime" : null,
      };
      expect(render([runtime("path")]).disabled).toBe(false);
      expect(mocks.markup).not.toContain("Could not remove managed runtime");
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(state === "operating");
      if (state === "operating") expect(mocks.markup).toContain("Cancel");
    },
  );

  it.each(["managed", "path"] as const)(
    "scopes maintenance failures to the selected %s runtime instead of trusting a cached probe",
    (source) => {
      mocks.managedStatus = {
        installed: true,
        selection: "managed",
        updateAvailable: false,
        runtimeVersion: null,
        toolkitRevision: null,
        generationId: "g1",
        operation: null,
        failureMessage: "Maintenance failed",
      };
      expect(render([runtime(source)]).disabled).toBe(false);
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(source === "managed");
      // Display filtering must not discard the authoritative Settings failure.
      expect(mocks.managedStatus.failureMessage).toBe("Maintenance failed");
    },
  );

  it("keeps recovery visible when the selected runtime is broken despite an unrelated usable runtime", () => {
    mocks.managedStatus = {
      installed: true,
      selection: "managed",
      updateAvailable: false,
      runtimeVersion: null,
      toolkitRevision: null,
      generationId: "g1",
      operation: null,
      failureMessage: "Setup failed",
    };
    expect(render([runtime("managed", false), runtime("path")]).disabled).toBe(true);
    expect(mocks.markup).toContain('data-compute-notice="toolbar"');
  });

  it.each([
    { ready: true, selection: "existing" as const, notice: false },
    { ready: false, selection: "existing" as const, notice: true },
    { ready: true, selection: "managed" as const, notice: true },
    { ready: false, selection: "managed" as const, notice: true },
  ])(
    "scopes MATLAB helper failures to its Engine host ($selection, ready=$ready)",
    ({ ready, selection, notice }) => {
      mocks.managedStatus = {
        installed: true,
        selection,
        updateAvailable: false,
        runtimeVersion: null,
        toolkitRevision: null,
        generationId: "helper-1",
        operation: null,
        failureMessage: "Helper repair failed",
      };
      const candidate = runtime("path", ready);
      const profile = { ...candidate.profile, languageId: MATLAB_COMPUTE_SOURCE.languageId };
      render(
        [{ ...candidate, profile, verification: { ...candidate.verification, profile } }],
        undefined,
        MATLAB_COMPUTE_SOURCE,
      );
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(notice);
    },
  );

  it("keeps active setup cancellable without displaying an unrelated prior failure", () => {
    mocks.managedStatus = {
      installed: true,
      selection: "managed",
      updateAvailable: false,
      runtimeVersion: null,
      toolkitRevision: null,
      generationId: "g1",
      failureMessage: "Previous repair failed",
      operation: {
        operationId: "new-repair",
        action: "repair",
        phase: "verifying",
        startedAt: "2026-09-15T12:00:00.000Z",
        downloadedBytes: null,
        totalBytes: null,
      },
    };
    render([runtime("path")]);
    expect(mocks.markup).toContain("Cancel");
    expect(mocks.markup).not.toContain("Previous repair failed");
  });

  it.each(["ready", "error"])(
    "uses the live session's health (%s), not a replacement runtime's health",
    (status) => {
      mocks.managedStatus = {
        installed: true,
        selection: "managed",
        updateAvailable: false,
        runtimeVersion: null,
        toolkitRevision: null,
        generationId: "g1",
        operation: null,
        failureMessage: "Repair failed",
      };
      mocks.sessions = [
        {
          sessionId: "live",
          languageId: "python",
          label: "Python",
          status,
          activity: "idle",
          runtime: runtime("managed").profile,
        },
      ];
      render([runtime("path", status !== "ready")]);
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(status !== "ready");
    },
  );

  it("disables ordinary Run when selected managed Python is unusable despite another ready Python", () => {
    expect(render([runtime("managed", false), runtime("path")]).disabled).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.runRequested).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "failed",
      result: { _tag: "Failure", cause: Cause.fail(new Error("start failed")) },
    },
    {
      label: "interrupted",
      result: { _tag: "Failure", cause: Cause.interrupt() },
    },
  ])("retains the reserved owner after a $label start response", async ({ result }) => {
    ensureComputeContext({
      contextId: testContextId,
      environmentId: testEnvironmentId,
      cwd: "/project",
      ownerKey: "test-owner",
      relativePath: "test.py",
    });
    mocks.start.mockResolvedValueOnce(result);

    const button = render([runtime("managed")], testContextId);
    button.onClick?.({} as Parameters<NonNullable<typeof button.onClick>>[0]);

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.runRequested).toHaveBeenCalledOnce();
    const binding = useComputeContextStore.getState().bindings[testContextId];
    expect(binding).toMatchObject({ lifecycle: "starting" });
    expect(binding?.sessionId).toEqual(expect.any(String));
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps Run recoverable after typed host capacity rejection", async () => {
    ensureComputeContext({
      contextId: testContextId,
      environmentId: testEnvironmentId,
      cwd: "/project",
      ownerKey: "test-owner",
      relativePath: "test.py",
    });
    mocks.start.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail({ reason: "capacity-reached", message: "host capacity" }),
    });

    const button = render([runtime("managed")], testContextId);
    button.onClick?.({} as Parameters<NonNullable<typeof button.onClick>>[0]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());

    expect(button.disabled).toBe(false);
    expect(useComputeContextStore.getState().bindings[testContextId]).toMatchObject({
      lifecycle: "unbound",
      sessionId: null,
      generation: null,
    });

    mocks.start.mockImplementationOnce(
      ({ input }: { readonly input: { readonly sessionId: ComputeSessionId } }) =>
        Promise.resolve({
          _tag: "Success" as const,
          value: { sessionId: input.sessionId, generation: 1 },
        }),
    );
    const retryButton = render([runtime("managed")], testContextId);
    expect(retryButton.disabled).toBe(false);
    retryButton.onClick?.({} as Parameters<NonNullable<typeof retryButton.onClick>>[0]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(useComputeContextStore.getState().bindings[testContextId]).toMatchObject({
        lifecycle: "live",
      }),
    );
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.start.mock.calls[1]?.[0].input.sessionId).not.toBe(
      mocks.start.mock.calls[0]?.[0].input.sessionId,
    );
  });
});
