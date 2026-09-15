// @vitest-environment happy-dom
import {
  ComputeLanguageId,
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
  buttons: [] as Array<ComponentProps<"button">>,
  menuItems: [] as Array<ComponentProps<"button">>,
  start: vi.fn(),
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
          ? []
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
    command === "start" ? mocks.start : command === "submit" ? mocks.submit : mocks.refresh,
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

import { PYTHON_COMPUTE_SOURCE } from "./computeSourceLanguage";

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
) {
  mocks.languages = [
    {
      descriptor: {
        languageId: ComputeLanguageId.make("python"),
        displayName: "Python",
        sourceExtensions: [".py"],
        capabilities: [],
      },
      enabled: true,
      configuredExecutable: null,
      managedRuntime: null,
      toolkits: [],
      runtimes: candidates,
    },
  ];
  renderToStaticMarkup(
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
