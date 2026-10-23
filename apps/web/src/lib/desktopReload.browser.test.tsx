import { render as _fixtureRender, type Screen, act } from "../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { requestDesktopReload, useDesktopReloadGuard } from "./desktopReload";

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(() => "reload-toast"),
  closeToast: vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.addToast, close: mocks.closeToast },
}));

async function _cleanupFixture0(_fixture: _Fixture) {
  while (_fixture.root0.length) {
    const root = _fixture.root0.pop();
    if (root) await act(async () => await root.unmount());
  }
  _clearOwnedDOM(_fixture);
  Reflect.deleteProperty(window, "desktopBridge");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
}

describe("desktop reload", () => {
  it.each([false, true])(
    "rechecks the latest render while another file becomes pending (getter: %s)",
    async (withGetter) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const reloadMainWindow = vi.fn(async () => true);
      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        value: { reloadMainWindow },
      });
      const onFlush = vi.fn();
      const host = document.createElement("div");
      document.body.append(_ownDOM(_fixture, host));
      const root = _fixture.stack.use(
        await _fixtureRender(null, { container: host, router: false }),
      );
      _fixture.root0.push(root);
      function Harness({ pending }: { pending: ReadonlySet<string> }) {
        useDesktopReloadGuard(
          pending,
          { onFlush, ...(withGetter ? { getPendingSurfaceIds: () => pending } : {}) },
          () => undefined,
        );
        return null;
      }

      await act(async () => await root.rerender(<Harness pending={new Set(["first"])} />));
      await act(() => requestDesktopReload(false));
      await act(async () => await root.rerender(<Harness pending={new Set(["second"])} />));
      expect(reloadMainWindow).not.toHaveBeenCalled();
      expect(onFlush).toHaveBeenLastCalledWith(["second"]);
      await act(async () => await root.rerender(<Harness pending={new Set()} />));
      expect(reloadMainWindow).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("waits for live pending files to save before reloading the main window", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const reloadMainWindow = vi.fn(async () => true);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { reloadMainWindow },
    });
    const onFlush = vi.fn();
    const pending = new Set(["file:notes.md"]);
    let livePending: ReadonlySet<string> = pending;
    const options = { getPendingSurfaceIds: () => livePending, onFlush };
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    function Harness(props: { pending: ReadonlySet<string> }) {
      useDesktopReloadGuard(props.pending, options, () => undefined);
      return null;
    }

    await act(async () => await root.rerender(<Harness pending={pending} />));
    await act(() => requestDesktopReload(true));
    expect(onFlush).toHaveBeenCalledExactlyOnceWith(["file:notes.md"]);
    expect(reloadMainWindow).not.toHaveBeenCalled();

    livePending = new Set();
    await act(async () => await root.rerender(<Harness pending={livePending} />));
    expect(reloadMainWindow).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("cancels a blocked reload and requires another request after save attention", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const reloadMainWindow = vi.fn(async () => true);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { reloadMainWindow },
    });
    const pending = new Set(["file:notes.md"]);
    let attention: ReadonlySet<string> = new Set();
    const onAttention = vi.fn();
    const options = {
      getPendingSurfaceIds: () => pending,
      getAttentionSurfaceIds: () => attention,
      onAttention,
    };
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    function Harness(props: { attention: ReadonlySet<string> }) {
      useDesktopReloadGuard(
        pending,
        { ...options, attentionSurfaceIds: props.attention },
        () => undefined,
      );
      return null;
    }

    await act(async () => await root.rerender(<Harness attention={attention} />));
    await act(() => requestDesktopReload(false));
    attention = pending;
    await act(async () => await root.rerender(<Harness attention={attention} />));
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("file:notes.md");
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reload paused" }),
    );
    expect(reloadMainWindow).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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
