// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    localStorage.clear();
    useComputeFilePresentationStore.setState({ presentations: {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async (language = PYTHON_COMPUTE_SOURCE, key = "first") => {
    const threadRef = {
      environmentId: EnvironmentId.make("server"),
      threadId: "thread",
    } as ScopedThreadRef;
    await act(() =>
      root.render(
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
          onShowMatlabOneShot={vi.fn()}
        />,
      ),
    );
  };
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label,
    );
    expect(button).toBeDefined();
    await act(() => button!.click());
  };
  it.each([PYTHON_COMPUTE_SOURCE, MATLAB_COMPUTE_SOURCE])(
    "restores $displayName views after actual unmount and return",
    async (language) => {
      await render(language);
      expect(container.querySelector('[data-testid="code"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="results"]')).toBeNull();
      await click("Results");
      await click("Variables");
      await act(() => root.render(null));
      await render(language, "other");
      expect(container.querySelector('[data-testid="results"]')).toBeNull();
      await render(language);
      expect(container.querySelector('[data-testid="code"]')).toBeNull();
      expect(container.querySelector('[data-testid="results"]')?.getAttribute("data-view")).toBe(
        "variables",
      );
      expect(mocks.runFile).not.toHaveBeenCalled();
      expect(mocks.runPrimary).not.toHaveBeenCalled();
    },
  );
  it("executes the whole file from empty results and retains a chosen split", async () => {
    await render();
    await click("Split");
    await click("Run file");
    expect(mocks.runFile).toHaveBeenCalledOnce();
    expect(mocks.runPrimary).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="code"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results"]')).not.toBeNull();
  });
});
