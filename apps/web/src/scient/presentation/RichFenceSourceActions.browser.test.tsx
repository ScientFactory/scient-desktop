import { render as _fixtureRender, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ScientRichFenceAuthoringActions,
  createRichFenceContextMenu,
} from "./RichFenceSourceActions";

function ContextMenuFixture(props: {
  readonly actions?: ScientRichFenceAuthoringActions | undefined;
  readonly onCopySource: () => void;
}) {
  const onContextMenu = createRichFenceContextMenu(props.actions, props.onCopySource);
  return <div data-card onContextMenu={onContextMenu} />;
}

describe("rich-fence authoring actions", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    await undefined;
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    _clearOwnedDOM(_fixture);
    vi.unstubAllGlobals();
  }

  async function fixture(_fixture: _Fixture, actions?: ScientRichFenceAuthoringActions) {
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    const onCopySource = vi.fn();
    await act(
      async () =>
        await root.rerender(<ContextMenuFixture actions={actions} onCopySource={onCopySource} />),
    );
    return { card: host.querySelector<HTMLElement>("[data-card]")!, onCopySource, root };
  }

  it("leaves the ordinary preview context menu untouched", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { card, onCopySource, root } = await fixture(_fixture);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    card.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onCopySource).not.toHaveBeenCalled();
    await act(async () => await root.unmount());
  });

  it.each([
    ["edit-source", "edit"],
    ["copy-source", "copy"],
  ] as const)("routes %s through the supplied authoring command", async (action, expected) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onEditSource = vi.fn();
    const showContextMenu = vi.fn(async () => action);
    const { card, onCopySource, root } = await fixture(_fixture, { onEditSource, showContextMenu });
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 23,
      clientY: 41,
    });

    await act(async () => {
      card.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(showContextMenu).toHaveBeenCalledExactlyOnceWith({ x: 23, y: 41 });
    expect(onEditSource).toHaveBeenCalledTimes(expected === "edit" ? 1 : 0);
    expect(onCopySource).toHaveBeenCalledTimes(expected === "copy" ? 1 : 0);
    await act(async () => await root.unmount());
  });

  it("anchors a keyboard context-menu request to its focused target", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const showContextMenu = vi.fn(async () => null);
    const { card, root } = await fixture(_fixture, { onEditSource: vi.fn(), showContextMenu });
    card.getBoundingClientRect = () => ({ left: 80, top: 120, width: 200, height: 90 }) as DOMRect;

    await act(async () => {
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(showContextMenu).toHaveBeenCalledExactlyOnceWith({ x: 104, y: 144 });
    await act(async () => await root.unmount());
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
