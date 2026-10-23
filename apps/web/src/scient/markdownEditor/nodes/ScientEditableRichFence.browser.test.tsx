import {
  render as _fixtureRender,
  stubGlobal as _fixtureStubGlobal,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { renderMermaidDiagram } from "~/scient/diagrams/mermaidRuntime";
import { ScientEditableRichFence } from "./ScientEditableRichFence";

vi.mock("~/scient/diagrams/mermaidRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/scient/diagrams/mermaidRuntime")>()),
  renderMermaidDiagram: vi.fn(),
}));
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

async function fixture(_fixture: _Fixture, source = "graph LR\n A --> B") {
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  let mounted = true;
  const unmount = async () => {
    if (mounted) await act(async () => await root.unmount());
    mounted = false;
  };
  _fixture.cleanups.push(unmount);
  const onEditSource = vi.fn();
  const authoringActions = { onEditSource };
  const render = async (nextSource: string, theme: "light" | "dark" = "light") => {
    await act(
      async () =>
        await root.rerender(
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
    enter: async () => await act(() => observers[0]!.enter()),
    preview: () => host.querySelector("[data-rendered-source]")?.textContent,
    validity: () => host.firstElementChild?.getAttribute("data-scient-rich-fence-validity"),
  };
}

async function finishMermaidDebounce(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(180));
}

describe("scientific fence validation lifecycle", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());

    _fixture.stack.use(_fixtureStubGlobal("IntersectionObserver", TestIntersectionObserver));
    observers.length = 0;
    validate.mockReset().mockResolvedValue(renderedDiagram);
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    for (const cleanup of _fixture.cleanups.splice(0)) await cleanup();
    _clearOwnedDOM(_fixture);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }

  it("defers off-screen validation and starts with the latest source and theme", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fence = await fixture(_fixture);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fence = await fixture(_fixture);
    const edit = fence.host.querySelector<HTMLButtonElement>("[data-edit-source]")!;

    edit.click();

    expect(fence.onEditSource).toHaveBeenCalledOnce();
  });

  it("keeps the last valid preview while invalid source is edited and recovers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const source = "graph LR\n A --> B";
    const fence = await fixture(_fixture, source);
    await fence.enter();

    validate.mockRejectedValueOnce(new Error("Incomplete diagram"));
    await fence.render("graph LR\n A -->");
    expect(fence.validity()).toBe("valid");
    await finishMermaidDebounce();
    expect(fence.validity()).toBe("invalid");
    expect(fence.preview()).toBe(source);
    expect(fence.host.querySelector('[role="status"]')?.textContent).toContain(
      "Preview kept at the last valid version.Incomplete diagram",
    );

    await fence.render("graph LR\n A --> C");
    await finishMermaidDebounce();
    expect(fence.validity()).toBe("valid");
    expect(fence.preview()).toBe("graph LR\n A --> C");
    expect(fence.host.querySelector('[role="status"]')).toBeNull();
  });

  it.each(["success", "failure"])("ignores a stale validation %s", async (outcome) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const stale = deferredRender();
    validate.mockReturnValueOnce(stale.promise);
    const fence = await fixture(_fixture);
    await fence.enter();
    expect(fence.validity()).toBe("validating");

    const latest = "graph RL\n C --> D";
    await fence.render(latest);
    await act(() => {
      if (outcome === "success") stale.resolve(renderedDiagram);
      else stale.reject(new Error("Old source error"));
    });
    await finishMermaidDebounce();
    expect(fence.preview()).toBe(latest);
    expect(fence.validity()).toBe("valid");
    expect(fence.host.querySelector('[role="status"]')).toBeNull();
  });

  it("shows the current invalid source when no valid preview exists", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    validate.mockRejectedValue(new Error("Invalid diagram"));
    const fence = await fixture(_fixture, "invalid old source");
    await fence.render("invalid latest source");
    await fence.enter();
    expect(fence.preview()).toBe("invalid latest source");
    expect(fence.validity()).toBe("invalid");
    expect(fence.host.querySelector('[role="status"]')).toBeNull();
  });

  it("coalesces rapid Mermaid edits into the newest settled source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fence = await fixture(_fixture);
    await fence.enter();
    expect(validate).toHaveBeenCalledOnce();

    await fence.render("graph LR\n A --> C");
    await fence.render("graph LR\n A --> D");
    await act(() => vi.advanceTimersByTimeAsync(179));
    expect(validate).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenLastCalledWith("graph LR\n A --> D", "light");
    expect(fence.preview()).toBe("graph LR\n A --> D");
  });

  it("allows one active Mermaid render and replaces its pending work with the latest edit", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const active = deferredRender();
    validate.mockReturnValueOnce(active.promise);
    const fence = await fixture(_fixture);
    await fence.enter();

    await fence.render("graph LR\n A --> C");
    await fence.render("graph LR\n A --> D");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(validate).toHaveBeenCalledOnce();

    await act(() => active.resolve(renderedDiagram));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenLastCalledWith("graph LR\n A --> D", "light");
    expect(fence.preview()).toBe("graph LR\n A --> D");
  });

  it("does not debounce a theme refresh", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fence = await fixture(_fixture);
    await fence.enter();

    await fence.render("graph LR\n A --> B", "dark");

    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenLastCalledWith("graph LR\n A --> B", "dark");
  });

  it("disconnects an unvisited fence without starting a render", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fence = await fixture(_fixture);
    await fence.unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("ignores an asynchronous failure after unmount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const pending = deferredRender();
    validate.mockReturnValueOnce(pending.promise);
    const fence = await fixture(_fixture);
    await fence.enter();
    await fence.unmount();
    await act(() => pending.reject(new Error("Late render error")));
    expect(fence.host.childElementCount).toBe(0);
  });

  it("still validates when IntersectionObserver is unavailable", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureStubGlobal("IntersectionObserver", undefined));
    const fence = await fixture(_fixture);
    expect(validate).toHaveBeenCalledOnce();
    expect(fence.validity()).toBe("valid");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    cleanups: [] as Array<() => Promise<void>>,
    _ownedDOM: [] as Node[],

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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
