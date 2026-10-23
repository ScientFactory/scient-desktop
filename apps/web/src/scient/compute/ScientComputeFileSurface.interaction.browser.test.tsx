import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ComponentProps, type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), runPrimary: vi.fn() }));
vi.mock("~/components/files/FilePreviewPanel", () => ({
  EditableFileSurface: () => <div data-testid="code">Code editor</div>,
}));
vi.mock("~/scient/layout/useScientSplit", () => ({ useScientSplit: () => ({}) }));
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./ComputePanel", () => ({
  ComputePanel: (props: ComponentProps<typeof import("./ComputePanel").ComputePanel>) => (
    <div data-testid="results" data-view={props.panelView}>
      <button onClick={() => props.onPanelViewChange?.("variables")}>Variables</button>
      <button onClick={props.onRunSource}>Run file</button>
    </div>
  ),
}));
vi.mock("./ComputeFileActions", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    ComputeFileActions: forwardRef((props: { onRunRequested: () => void }, ref) => {
      useImperativeHandle(ref, () => ({
        runFile: () => {
          mocks.runFile();
          props.onRunRequested();
        },
        runPrimary: mocks.runPrimary,
      }));
      return <button onClick={props.onRunRequested}>Execute</button>;
    }),
  };
});

import { ScientComputeFileSurface } from "./ScientComputeFileSurface";
import { ComputeContextId } from "./computeContextStore";
import { useComputeFilePresentationStore } from "./computeFilePresentationStore";
import { MATLAB_COMPUTE_SOURCE, PYTHON_COMPUTE_SOURCE } from "./computeSourceLanguage";

describe("Compute file navigation", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    vi.clearAllMocks();
    localStorage.clear();
    useComputeFilePresentationStore.setState({ presentations: {} });
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }
  const render = async (_fixture: _Fixture, language = PYTHON_COMPUTE_SOURCE, key = "first") => {
    const threadRef = {
      environmentId: EnvironmentId.make("server"),
      threadId: "thread",
    } as ScopedThreadRef;
    await act(
      async () =>
        await _fixture.root0.rerender(
          <ScientComputeFileSurface
            key={key}
            language={language}
            environmentId={EnvironmentId.make("server")}
            threadRef={threadRef}
            composerDraftTarget={threadRef}
            contextId={ComputeContextId.make(key)}
            cwd="/project"
            relativePath={`example${language.extensions[0]}`}
            contents="print(1)"
            initialSource="print(1)"
            revision="r1"
            resolvedTheme="light"
            revealRequestId={0}
            wordWrap={false}
            sourcePending={false}
            onPostRender={vi.fn()}
            onPendingChange={vi.fn()}
            onSaveFailure={vi.fn()}
            onSaveConfirmed={vi.fn()}
            onSaveResolutionApplied={vi.fn()}
            saveResolution={null}
          />,
        ),
    );
  };
  const click = async (_fixture: _Fixture, label: string) => {
    const button = [..._fixture.container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  it.each([PYTHON_COMPUTE_SOURCE, MATLAB_COMPUTE_SOURCE])(
    "restores $displayName views after actual unmount and return",
    async (language) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await render(_fixture, language);
      expect(_fixture.container.querySelector('[data-testid="code"]')).not.toBeNull();
      expect(_fixture.container.querySelector('[data-testid="results"]')).toBeNull();
      await click(_fixture, "Results");
      await click(_fixture, "Variables");
      await act(async () => await _fixture.root0.rerender(null));
      await render(_fixture, language, "other");
      expect(_fixture.container.querySelector('[data-testid="results"]')).toBeNull();
      await render(_fixture, language);
      expect(_fixture.container.querySelector('[data-testid="code"]')).toBeNull();
      expect(
        _fixture.container.querySelector('[data-testid="results"]')?.getAttribute("data-view"),
      ).toBe("variables");
      expect(mocks.runFile).not.toHaveBeenCalled();
      expect(mocks.runPrimary).not.toHaveBeenCalled();
    },
  );
  it("executes the whole file from empty results and retains a chosen split", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    await click(_fixture, "Split");
    await click(_fixture, "Run file");
    expect(mocks.runFile).toHaveBeenCalledOnce();
    expect(mocks.runPrimary).not.toHaveBeenCalled();
    expect(_fixture.container.querySelector('[data-testid="code"]')).not.toBeNull();
    expect(_fixture.container.querySelector('[data-testid="results"]')).not.toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
