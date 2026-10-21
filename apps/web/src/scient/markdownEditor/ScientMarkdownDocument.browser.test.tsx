import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { ScientMarkdownDocument } from "./ScientMarkdownDocument";
import { ScientMarkdownEditorView } from "./prosemirror/view";

describe("ScientMarkdownDocument", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    while (_fixture.root0.length > 0) {
      const root = _fixture.root0.pop();
      if (root) await act(async () => await root.unmount());
    }
    _clearOwnedDOM(_fixture);
    vi.unstubAllGlobals();
  }

  async function renderDocument(_fixture: _Fixture) {
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    return { host, root };
  }

  it("keeps the rendered document DOM while activating and deactivating editing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { host, root } = await renderDocument(_fixture);
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source: "# Results\n\n- one\n  - nested\n",
      revision: "sha256:one",
      mode: "read",
      ariaLabel: "Results document",
      onUserSourceChange,
    });
    await act(
      async () =>
        await root.rerender(<ScientMarkdownDocument controller={controller} mode="read" />),
    );
    const proseMirror = host.querySelector(".ProseMirror");
    const heading = proseMirror?.querySelector("h1");

    await act(
      async () =>
        await root.rerender(<ScientMarkdownDocument controller={controller} mode="write" />),
    );
    expect(host.querySelector(".ProseMirror")).toBe(proseMirror);
    expect(host.querySelector("h1")).toBe(heading);
    expect(proseMirror?.getAttribute("contenteditable")).toBe("true");

    await act(
      async () =>
        await root.rerender(<ScientMarkdownDocument controller={controller} mode="read" />),
    );
    expect(host.querySelector(".ProseMirror")).toBe(proseMirror);
    expect(proseMirror?.getAttribute("contenteditable")).toBe("false");
    expect(onUserSourceChange).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("leaves controller lifetime with the owning workspace", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { root } = await renderDocument(_fixture);
    const controller = new ScientMarkdownEditorView({
      source: "# Before\n",
      revision: "sha256:before",
      mode: "write",
      ariaLabel: "Agent-edited document",
      onUserSourceChange: vi.fn(),
    });
    const destroy = vi.spyOn(controller, "destroy");
    await act(
      async () =>
        await root.rerender(<ScientMarkdownDocument controller={controller} mode="write" />),
    );

    _fixture.root0.pop();
    await act(async () => await root.unmount());
    expect(destroy).not.toHaveBeenCalled();
    controller.destroy();
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
