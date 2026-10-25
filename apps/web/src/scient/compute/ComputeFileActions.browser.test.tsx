import { render as _fixtureRender, act } from "../../../test/render";
import {
  ComputeLanguageId,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeToolkitId,
  EnvironmentId,
  type ComputeLanguageRuntimeInspection,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";
import { createRef, type ReactNode } from "react";

import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  languages: [] as ComputeLanguageRuntimeInspection[],
  managedStatus: null as ComputeManagedRuntimeStatus | null,
  sessions: [] as unknown[],
  markup: "",
  start: vi.fn(),
  stop: vi.fn(),
  submit: vi.fn(),
  refresh: vi.fn(),
  runRequested: vi.fn(),
}));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  useEnvironmentSettings: () => ({ languages: { python: { enabled: true, executable: "" } } }),
}));
vi.mock("~/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
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
vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand: (command: unknown) =>
    command === computeEnvironment.startSession
      ? mocks.start
      : command === computeEnvironment.stopSession
        ? mocks.stop
        : command === computeEnvironment.submitExecution
          ? mocks.submit
          : mocks.refresh,
}));
vi.mock("~/components/ui/button", { spy: true });
vi.mock("~/components/ui/contextual-confirmation", { spy: true });
import { Button } from "~/components/ui/button";
import { ContextualConfirmation } from "~/components/ui/contextual-confirmation";

function buttonProps() {
  return vi.mocked(Button).mock.calls.map(([props]) => props);
}
function confirmation() {
  const calls = vi.mocked(ContextualConfirmation).mock.calls;
  return calls.findLast(([props]) => props.open)?.[0] ?? calls[0]?.[0] ?? null;
}

import { MATLAB_COMPUTE_SOURCE, PYTHON_COMPUTE_SOURCE } from "./computeSourceLanguage";
import { computeEnvironment } from "~/state/compute";

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
function setRuntimeCandidates(candidates = [runtime("managed")], language = PYTHON_COMPUTE_SOURCE) {
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
      managedRuntime: mocks.managedStatus,
      toolkits: [],
      runtimes: candidates,
    },
  ];
}
async function render(
  _fixture: _Fixture,
  candidates = [runtime("managed")],
  contextId: ComputeContextId | undefined = undefined,
  language = PYTHON_COMPUTE_SOURCE,
) {
  setRuntimeCandidates(candidates, language);
  mocks.markup = await _renderMarkup(
    _fixture,
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
  return buttonProps().findLast((button) => button["aria-label"] === "Run file")!;
}

function scientificRuntime(source: "managed" | "path", toolkitReady: boolean) {
  const candidate = runtime(source);
  return {
    ...candidate,
    toolkits: [
      {
        toolkitId: ComputeToolkitId.make("python-data-and-figures"),
        runtime: candidate.profile,
        readiness: toolkitReady ? ("ready" as const) : ("missing-requirement" as const),
        missingRequirements: toolkitReady ? [] : ["scipy"],
      },
    ],
  };
}

describe("Python file run actions", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    for (const [name, value] of [
      ["sessions", "sessions"],
      ["events", "events"],
      ["runtimes", "runtimes"],
      ["managedRuntime", "managed-status"],
    ] as const) {
      const spy = vi.spyOn(computeEnvironment, name).mockReturnValue(value as never);
      _fixture.stack.defer(() => spy.mockRestore());
    }
    _fixture.cleanup.defer(() => {
      vi.mocked(Button).mockClear();
      vi.mocked(ContextualConfirmation).mockClear();
    });
    vi.clearAllMocks();
    mocks.managedStatus = null;
    mocks.sessions = [];
    mocks.markup = "";
    mocks.stop.mockReset();
    mocks.start.mockResolvedValue({
      _tag: "Success",
      value: { sessionId: ComputeSessionId.make("new-session"), generation: 1 },
    });
    mocks.submit.mockResolvedValue({ _tag: "Success", value: {} });
    useComputeContextStore.setState({ bindings: {} });
  }

  it.each(["ready", "unavailable"])(
    "switches only to the confirmed environment, without rerunning code (%s)",
    async (availability) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

      const sessionId = ComputeSessionId.make("system-session");
      const session = {
        sessionId,
        generation: ComputeSessionGeneration.make(1),
        languageId: "python",
        label: "Python",
        workingDirectory: "/project",
        status: "ready",
        activity: "idle",
        runtime: runtime("path").profile,
      };
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
      mocks.sessions = [session];
      const target = runtime("managed");
      setRuntimeCandidates([target, runtime("path")]);
      mocks.stop.mockResolvedValue({ _tag: "Success", value: { ...session, status: "stopped" } });
      mocks.start.mockImplementation(async ({ input }) => ({
        _tag: "Success",
        value: { ...session, sessionId: input.sessionId, runtime: target.profile },
      }));
      // Inspection's default has changed by confirmation time; the captured target must win.
      mocks.refresh.mockResolvedValue({
        _tag: "Success",
        value: {
          languages: [
            {
              ...mocks.languages[0],
              runtimes: availability === "ready" ? [runtime("path"), target] : [runtime("path")],
            },
          ],
        },
      });

      const root = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div") }),
      );
      try {
        await act(
          async () =>
            await root.rerender(
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
        const choose = buttonProps().findLast(
          (button) => button["aria-label"] === "Switch Python environment",
        )!;
        expect(choose).toBeDefined();
        await act(() => choose.onClick?.({} as never));
        const confirm = buttonProps().findLast(
          (button) => Array.isArray(button.children) && button.children.includes("Switch"),
        )!;
        expect(confirm).toBeDefined();
        await act(async () => {
          confirm.onClick?.({} as never);
        });
        if (availability === "ready") {
          expect(mocks.stop).toHaveBeenCalledWith({
            environmentId: testEnvironmentId,
            input: { cwd: "/project", sessionId, expectedGeneration: 1, onlyIfIdle: true },
          });
          expect(mocks.start).toHaveBeenCalledOnce();
          expect(mocks.start.mock.calls[0]![0].input.executable).toBe(target.profile.executable);
        } else {
          expect(mocks.stop).not.toHaveBeenCalled();
          expect(mocks.start).not.toHaveBeenCalled();
        }
        expect(mocks.submit).not.toHaveBeenCalled();
      } finally {
        await act(async () => await root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("resolves the current default on the correct server instead of pinning a cached executable", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const button = await render(_fixture);
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

  it.each([
    { decision: "current", executable: "/path/python" },
    { decision: "managed", executable: "/managed/python" },
  ])(
    "waits for an explicit $decision runtime choice before reserving or running",
    async ({ decision, executable }) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

      mocks.managedStatus = {
        installed: true,
        selection: "existing",
        updateAvailable: false,
        runtimeVersion: "3.12.13",
        toolkitRevision: "scientific-1",
        toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
        operation: null,
        failure: null,
        failureMessage: null,
      };
      mocks.start.mockImplementationOnce(
        ({ input }: { readonly input: { readonly sessionId: ComputeSessionId } }) =>
          Promise.resolve({
            _tag: "Success" as const,
            value: { sessionId: input.sessionId, generation: 1 },
          }),
      );
      setRuntimeCandidates([scientificRuntime("path", false), scientificRuntime("managed", true)]);

      const container = document.createElement("div");
      const root = _fixture.stack.use(await _fixtureRender(null, { container: container }));
      try {
        await act(
          async () =>
            await root.rerender(
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

        await act(() => {
          buttonProps()
            .findLast((button) => button["aria-label"] === "Run file")!
            .onClick?.({} as never);
        });

        expect(confirmation()).toMatchObject({
          open: true,
          title: "Use Scient-managed Python?",
          description: "Python 3.12.13 · System is missing scientific packages.",
          confirmLabel: "Use managed",
          secondaryAction: { label: "Use current" },
        });
        expect(mocks.runRequested).not.toHaveBeenCalled();
        expect(mocks.start).not.toHaveBeenCalled();
        expect(mocks.submit).not.toHaveBeenCalled();
        expect(useComputeContextStore.getState().bindings[testContextId]).toBeUndefined();

        await act(async () => {
          if (decision === "managed") confirmation()!.onConfirm();
          else confirmation()!.secondaryAction!.onSelect();
        });

        await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
        expect(mocks.runRequested).toHaveBeenCalledOnce();
        expect(mocks.start).toHaveBeenCalledWith({
          environmentId: testEnvironmentId,
          input: {
            cwd: "/project",
            sessionId: expect.any(String),
            languageId: "python",
            executable,
          },
        });
      } finally {
        await act(async () => await root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it("reserves a fresh child before its single start-and-run request without replacing the session", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

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
    await render(_fixture, undefined, testContextId);
    await page.getByRole("button", { name: "Choose Python code to run" }).click();
    const fresh = page.getByRole("menuitem", { name: "Run fresh", exact: true });
    await expect.element(fresh).toBeEnabled();
    await fresh.click();
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
    // The exact-owner, exact-generation rule is covered in Node by
    // computeFileSurfaceModel.test.ts; "nonterminal" proves its rejection here.
    "nonterminal",
    "closed-during-stop",
    "changed-before-stop",
  ])(
    "recovers a one-slot fresh rejection only after explicit, exact shutdown (%s)",
    async (outcome) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

      await render(_fixture);
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

      const container = document.createElement("div");
      const root = _fixture.stack.use(await _fixtureRender(null, { container: container }));
      try {
        await act(
          async () =>
            await root.rerender(
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
        await page.getByRole("button", { name: "Choose Python code to run" }).last().click();
        await page.getByRole("menuitem", { name: "Run fresh", exact: true }).click();
        await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
        expect(mocks.start).toHaveBeenCalledTimes(1);
        expect(mocks.stop).not.toHaveBeenCalled();
        await page.getByRole("button", { name: "Choose a compute session to stop" }).click();
        await expect
          .element(page.getByRole("menuitem", { name: "No active sessions in this project" }))
          .not.toBeInTheDocument();
        await page
          .getByRole("menuitem", { name: "Stop this session and run fresh…", exact: true })
          .click();
        expect(confirmation()?.open).toBe(true);
        expect(mocks.stop).not.toHaveBeenCalled();
        if (outcome === "cancel") {
          await act(() => confirmation()!.onOpenChange(false));
          expect(mocks.stop).not.toHaveBeenCalled();
          return;
        }
        if (outcome === "changed-before-stop") {
          useComputeContextStore.setState({ bindings: {} });
        }
        if (outcome === "thrown") mocks.stop.mockRejectedValueOnce(new Error("Disconnected"));
        await act(async () => {
          const confirm = confirmation()!;
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
                    sessionId,
                    generation: 1,
                    status: outcome === "nonterminal" ? "closing" : "stopped",
                  },
                },
          );
        });
        expect(mocks.start).toHaveBeenCalledTimes(outcome === "success" ? 2 : 1);
        expect(mocks.submit).not.toHaveBeenCalled();
      } finally {
        await act(async () => await root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([true, false])(
    "keeps Run file literal and respects runtime availability (%s)",
    async (ready) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

      await render(_fixture, [runtime("managed", ready)]);

      const container = document.createElement("div");
      const root = _fixture.stack.use(await _fixtureRender(null, { container: container }));
      const ref = createRef<ComputeFileActionsHandle>();
      const contents = "# %% First\nprint(1)\n# %% Second\nprint(2)";
      try {
        await act(
          async () =>
            await root.rerender(
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
                editorSelection={{
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 8 },
                }}
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
        await act(async () => await root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["failed", "operating"])(
    "does not block a ready system runtime when managed setup is %s",
    async (state) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

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
      expect((await render(_fixture, [runtime("path")])).disabled).toBe(false);
      expect(mocks.markup).not.toContain("Could not remove managed runtime");
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(state === "operating");
      if (state === "operating") expect(mocks.markup).toContain("Cancel");
    },
  );

  it.each(["managed", "path"] as const)(
    "scopes maintenance failures to the selected %s runtime instead of trusting a cached probe",
    async (source) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

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
      expect((await render(_fixture, [runtime(source)])).disabled).toBe(false);
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(source === "managed");
      // Display filtering must not discard the authoritative Settings failure.
      expect(mocks.managedStatus.failureMessage).toBe("Maintenance failed");
    },
  );

  it("keeps recovery visible when the selected runtime is broken despite an unrelated usable runtime", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

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
    expect((await render(_fixture, [runtime("managed", false), runtime("path")])).disabled).toBe(
      true,
    );
    expect(mocks.markup).toContain('data-compute-notice="toolbar"');
  });

  it.each([
    { ready: true, selection: "existing" as const, notice: false },
    { ready: false, selection: "existing" as const, notice: true },
    { ready: true, selection: "managed" as const, notice: true },
  ])(
    "scopes MATLAB helper failures to its Engine host ($selection, ready=$ready)",
    async ({ ready, selection, notice }) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

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
      await render(
        _fixture,
        [{ ...candidate, profile, verification: { ...candidate.verification, profile } }],
        undefined,
        MATLAB_COMPUTE_SOURCE,
      );
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(notice);
    },
  );

  it("keeps active setup cancellable without displaying an unrelated prior failure", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

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
    await render(_fixture, [runtime("path")]);
    expect(mocks.markup).toContain("Cancel");
    expect(mocks.markup).not.toContain("Previous repair failed");
  });

  it.each(["ready", "error"])(
    "uses the live session's health (%s), not a replacement runtime's health",
    async (status) => {
      await using _fixture = _createFixture();
      await _setupFixture0(_fixture);

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
      await render(_fixture, [runtime("path", status !== "ready")]);
      expect(mocks.markup.includes('data-compute-notice="toolbar"')).toBe(status !== "ready");
    },
  );

  it("disables ordinary Run when selected managed Python is unusable despite another ready Python", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    expect((await render(_fixture, [runtime("managed", false), runtime("path")])).disabled).toBe(
      true,
    );
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
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    ensureComputeContext({
      contextId: testContextId,
      environmentId: testEnvironmentId,
      cwd: "/project",
      ownerKey: "test-owner",
      relativePath: "test.py",
    });
    mocks.start.mockResolvedValueOnce(result);

    const button = await render(_fixture, [runtime("managed")], testContextId);
    button.onClick?.({} as Parameters<NonNullable<typeof button.onClick>>[0]);

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.runRequested).toHaveBeenCalledOnce();
    const binding = useComputeContextStore.getState().bindings[testContextId];
    expect(binding).toMatchObject({ lifecycle: "starting" });
    expect(binding?.sessionId).toEqual(expect.any(String));
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps Run recoverable after typed host capacity rejection", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

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

    const button = await render(_fixture, [runtime("managed")], testContextId);
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
    const retryButton = await render(_fixture, [runtime("managed")], testContextId);
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
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

async function _renderMarkup(_fixture: _Fixture, ui: ReactNode): Promise<string> {
  const screen = _fixture.stack.use(await _fixtureRender(ui, {}));
  return screen.container.innerHTML;
}
