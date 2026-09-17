// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeLanguageId,
  ComputeExecutionId,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeToolkitId,
  EnvironmentId,
  type ComputeRuntimeInspection,
  type ComputeSessionRecord,
  type ScopedThreadRef,
} from "@t3tools/contracts";
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    refreshRuntimes: "refresh",
    startSession: "start",
    stopSession: "stop",
    session: "get",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "refresh" | "start" | "stop") => mocks[command],
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.get }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/settings/scientific-computing">{children}</a>
  ),
}));
vi.mock("~/components/ui/contextual-confirmation", () => ({
  ContextualConfirmation: (props: {
    open: boolean;
    description: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }) =>
    props.open ? (
      <div role="alertdialog">
        <p>{props.description}</p>
        <button onClick={() => props.onOpenChange(false)}>Cancel</button>
        <button
          onClick={() => {
            props.onOpenChange(false);
            props.onConfirm();
          }}
        >
          Confirm
        </button>
      </div>
    ) : null,
}));
import { ComputeDependencyRecoveryAction } from "./ComputeDependencyRecoveryAction";
import { ComputeOutputView } from "./ComputeOutputView";
import {
  ComputeContextId,
  ensureComputeContext,
  getComputeContext,
  useComputeContextStore,
} from "./computeContextStore";

const contextId = ComputeContextId.make("test-file-owner");
const environmentId = EnvironmentId.make("remote-host");
const languageId = ComputeLanguageId.make("python");
const session = {
  sessionId: ComputeSessionId.make("system-session"),
  generation: ComputeSessionGeneration.make(1),
  languageId,
  status: "ready",
  activity: "idle",
  runtime: {
    languageId,
    source: "path",
    executable: "/system/python",
    displayName: "Python",
    languageVersion: "3.14",
    architecture: null,
  },
} as ComputeSessionRecord;
const managed = { ...session.runtime!, source: "managed" as const, executable: "/managed/python" };
function inspection(): ComputeRuntimeInspection {
  return {
    contractVersion: 1,
    scope: "project",
    languages: [
      {
        descriptor: {
          languageId,
          displayName: "Python",
          sourceExtensions: [".py"],
          capabilities: [],
        },
        enabled: true,
        configuredExecutable: "/system/python",
        toolkits: [
          {
            toolkitId: ComputeToolkitId.make("python-data-and-figures"),
            languageId,
            displayName: "Scientific Python",
            summary: "Synthetic",
            required: true,
            packageRequirements: [{ name: "pandas", displayName: "pandas", minimumVersion: null }],
          },
        ],
        managedRuntime: {
          installed: true,
          selection: "existing",
          updateAvailable: false,
          runtimeVersion: "3.12",
          toolkitRevision: "synthetic",
          operation: null,
          failureMessage: null,
        },
        runtimes: [
          {
            profile: managed,
            toolkits: [],
            verification: {
              profile: managed,
              readiness: "ready",
              missingRequirements: [],
              message: null,
              packages: [{ name: "pandas", version: "2.3" }],
            },
          },
        ],
      },
    ],
  };
}

describe("confirmed managed-Python recovery action", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onSettled = vi.fn();
  const render = async () => {
    await act(() =>
      root.render(
        <ComputeDependencyRecoveryAction
          contextId={contextId}
          session={session}
          moduleName="pandas"
          executable={managed.executable}
          onSettled={onSettled}
        />,
      ),
    );
  };
  const click = async (text: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    useComputeContextStore.setState({ bindings: {} });
    ensureComputeContext({ contextId, environmentId, cwd: "/remote/project", ownerKey: "file.py" });
    useComputeContextStore
      .getState()
      .reserveSession({ contextId, sessionId: session.sessionId, generation: session.generation });
    useComputeContextStore
      .getState()
      .bindSession({ contextId, sessionId: session.sessionId, generation: session.generation });
    mocks.refresh.mockResolvedValue({ _tag: "Success", value: inspection() });
    mocks.get.mockResolvedValue({ _tag: "Success", value: session });
    mocks.stop.mockImplementation(async ({ input }: { input: { sessionId: string } }) => ({
      _tag: "Success",
      value: { ...session, sessionId: input.sessionId, status: "stopped" },
    }));
    mocks.start.mockImplementation(async ({ input }: { input: { sessionId: string } }) => ({
      _tag: "Success",
      value: { ...session, sessionId: input.sessionId, runtime: managed },
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it("requires confirmation, warns of variable loss, and Cancel performs no commands", async () => {
    await render();
    await click("Start a new session with managed Python…");
    expect(container.textContent).toContain("clears its in-memory variables");
    expect(container.textContent).toContain("Run history is kept");
    expect(container.textContent).toContain("No code is rerun");
    expect(container.textContent).toContain("default Python environment stays unchanged");
    await click("Cancel");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "only an owned error result exposes the recovery action: %s",
    async (owned) => {
      await act(() =>
        root.render(
          <ComputeOutputView
            session={session}
            executionId={ComputeExecutionId.make("failed-run")}
            cwd="/remote/project"
            environmentId={environmentId}
            threadRef={{} as ScopedThreadRef}
            runtimeInspection={inspection()}
            {...(owned ? { dependencyRecovery: { contextId, onSettled } } : {})}
            outputs={[
              {
                _tag: "diagnostic",
                sequence: 1,
                observedAt: "2026-09-17T00:00:00Z",
                diagnostic: {
                  errorName: "ModuleNotFoundError",
                  message: "No module named 'pandas'",
                  traceback: [],
                  frames: [],
                },
              },
            ]}
          />,
        ),
      );
      expect(container.textContent?.includes("Start a new session with managed Python…")).toBe(
        owned,
      );
      expect(container.textContent).toContain("ModuleNotFoundError");
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );
  it("refreshes the owning host and starts the explicit managed executable only after confirmation", async () => {
    await render();
    await click("Start a new session with managed Python…");
    await click("Confirm");
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: "/remote/project", refresh: true },
    });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/remote/project",
        sessionId: expect.any(String),
        languageId,
        executable: "/managed/python",
      },
    });
    expect(getComputeContext(contextId)).toMatchObject({
      lifecycle: "live",
      sessionId: mocks.start.mock.calls[0]![0].input.sessionId,
    });
    expect(onSettled).toHaveBeenCalledOnce();
  });
  it.each(["package removed", "managed generation changed", "session busy", "session restarted"])(
    "does not stop the current session after %s",
    async (change) => {
      if (change === "package removed") {
        const data = inspection();
        mocks.refresh.mockResolvedValue({
          _tag: "Success",
          value: { ...data, languages: [{ ...data.languages[0], runtimes: [] }] },
        });
      } else if (change === "managed generation changed") {
        const data = inspection();
        const language = data.languages[0]!;
        const candidate = language.runtimes[0]!;
        const profile = { ...managed, executable: "/managed/new-generation/python" };
        mocks.refresh.mockResolvedValue({
          _tag: "Success",
          value: {
            ...data,
            languages: [
              {
                ...language,
                runtimes: [
                  { ...candidate, profile, verification: { ...candidate.verification, profile } },
                ],
              },
            ],
          },
        });
      } else {
        mocks.get.mockResolvedValue({
          _tag: "Success",
          value: {
            ...session,
            ...(change === "session busy" ? { activity: "busy" } : { generation: 2 }),
          },
        });
      }
      await render();
      await click("Start a new session with managed Python…");
      await click("Confirm");
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(getComputeContext(contextId)).toMatchObject({
        sessionId: session.sessionId,
        lifecycle: "live",
      });
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    },
  );
  it("immediately shows pending feedback and blocks duplicate confirmation while checking readiness", async () => {
    let resolve!: (value: unknown) => void;
    mocks.refresh.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await render();
    await click("Start a new session with managed Python…");
    await click("Confirm");
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Starting managed Python…");
    expect(button.disabled).toBe(true);
    await act(() => {
      resolve({ _tag: "Success", value: inspection() });
    });
    expect(mocks.start).toHaveBeenCalledOnce();
  });
});
