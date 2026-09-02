// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderMermaidDiagram } from "~/scient/diagrams/mermaidRuntime";
import { ScientEditableRichFence } from "./ScientEditableRichFence";

vi.mock("~/scient/diagrams/mermaidRuntime", () => ({ renderMermaidDiagram: vi.fn() }));
vi.mock("~/scient/presentation/ScientRichFence", () => ({
  ScientRichFence: ({
    authoringActions,
    source,
  }: {
    readonly authoringActions: { readonly onEditSource: () => void };
    readonly source: string;
  }) => (
    <div>
      <pre data-rendered-source>{source}</pre>
      <button data-edit-source onClick={authoringActions.onEditSource} type="button">
        Edit source
      </button>
    </div>
  ),
}));

const renderedDiagram = { svg: "<svg />", diagramType: "flowchart" };
const validate = vi.mocked(renderMermaidDiagram);
const observers: TestIntersectionObserver[] = [];
const cleanups: Array<() => Promise<void>> = [];

class TestIntersectionObserver {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observers.push(this);
  }

  enter() {
    this.callback([{ isIntersecting: true }]);
  }
}

function deferredRender() {
  let resolve!: (value: typeof renderedDiagram) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<typeof renderedDiagram>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function fixture(source = "graph LR\n A --> B") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => {
    if (mounted) await act(() => root.unmount());
    mounted = false;
  };
  cleanups.push(unmount);
  const onEditSource = vi.fn();
  const authoringActions = { onEditSource };
  const render = async (nextSource: string, theme: "light" | "dark" = "light") => {
    await act(() =>
      root.render(
        <ScientEditableRichFence
          authoringActions={authoringActions}
          kind="mermaid"
          language="mermaid"
          source={nextSource}
          theme={theme}
          title={null}
        />,
      ),
    );
  };
  await render(source);
  return {
    host,
    onEditSource,
    render,
    unmount,
    enter: () => act(() => observers[0]!.enter()),
    preview: () => host.querySelector("[data-rendered-source]")?.textContent,
    validity: () => host.firstElementChild?.getAttribute("data-scient-rich-fence-validity"),
  };
}

describe("scientific fence validation lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    observers.length = 0;
    validate.mockReset().mockResolvedValue(renderedDiagram);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("defers off-screen validation and starts with the latest source and theme", async () => {
    const fence = await fixture();
    expect(validate).not.toHaveBeenCalled();
    await fence.render("graph RL\n B --> C", "dark");
    expect(validate).not.toHaveBeenCalled();
    expect(observers[0]?.observe).toHaveBeenCalledWith(fence.host.firstElementChild);

    await fence.enter();
    expect(validate).toHaveBeenCalledExactlyOnceWith("graph RL\n B --> C", "dark");
    expect(fence.validity()).toBe("valid");
    expect(fence.preview()).toBe("graph RL\n B --> C");
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  it("passes the editor-owned source action through the shared visual renderer", async () => {
    const fence = await fixture();
    const edit = fence.host.querySelector<HTMLButtonElement>("[data-edit-source]")!;

    edit.click();

    expect(fence.onEditSource).toHaveBeenCalledOnce();
  });

  it("keeps the last valid preview while invalid source is edited and recovers", async () => {
    const source = "graph LR\n A --> B";
    const fence = await fixture(source);
    await fence.enter();

    validate.mockRejectedValueOnce(new Error("Incomplete diagram"));
    await fence.render("graph LR\n A -->");
    expect(fence.validity()).toBe("invalid");
    expect(fence.preview()).toBe(source);
    expect(fence.host.querySelector('[role="status"]')?.textContent).toContain(
      "Preview kept at the last valid version.Incomplete diagram",
    );

    await fence.render("graph LR\n A --> C");
    expect(fence.validity()).toBe("valid");
    expect(fence.preview()).toBe("graph LR\n A --> C");
    expect(fence.host.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["success", "failure"])("ignores a stale validation %s", async (outcome) => {
    const stale = deferredRender();
    validate.mockReturnValueOnce(stale.promise);
    const fence = await fixture();
    await fence.enter();
    expect(fence.validity()).toBe("validating");

    const latest = "graph RL\n C --> D";
    await fence.render(latest);
    await act(() => {
      if (outcome === "success") stale.resolve(renderedDiagram);
      else stale.reject(new Error("Old source error"));
    });
    expect(fence.preview()).toBe(latest);
    expect(fence.validity()).toBe("valid");
    expect(fence.host.querySelector('[role="status"]')).toBeNull();
  });

  it("shows the current invalid source when no valid preview exists", async () => {
    validate.mockRejectedValue(new Error("Invalid diagram"));
    const fence = await fixture("invalid old source");
    await fence.render("invalid latest source");
    await fence.enter();
    expect(fence.preview()).toBe("invalid latest source");
    expect(fence.validity()).toBe("invalid");
    expect(fence.host.querySelector('[role="status"]')).toBeNull();
  });

  it("disconnects an unvisited fence without starting a render", async () => {
    const fence = await fixture();
    await fence.unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("ignores an asynchronous failure after unmount", async () => {
    const pending = deferredRender();
    validate.mockReturnValueOnce(pending.promise);
    const fence = await fixture();
    await fence.enter();
    await fence.unmount();
    await act(() => pending.reject(new Error("Late render error")));
    expect(fence.host.childElementCount).toBe(0);
  });

  it("still validates when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fence = await fixture();
    expect(validate).toHaveBeenCalledOnce();
    expect(fence.validity()).toBe("valid");
  });
});
