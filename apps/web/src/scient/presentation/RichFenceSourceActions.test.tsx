// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ScientRichFenceAuthoringActions,
  useRichFenceContextMenu,
} from "./RichFenceSourceActions";

function ContextMenuFixture(props: {
  readonly actions?: ScientRichFenceAuthoringActions | undefined;
  readonly onCopySource: () => void;
}) {
  const onContextMenu = useRichFenceContextMenu(props.actions, props.onCopySource);
  return <div data-card onContextMenu={onContextMenu} />;
}

describe("rich-fence authoring actions", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function fixture(actions?: ScientRichFenceAuthoringActions) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onCopySource = vi.fn();
    await act(() =>
      root.render(<ContextMenuFixture actions={actions} onCopySource={onCopySource} />),
    );
    return { card: host.querySelector<HTMLElement>("[data-card]")!, onCopySource, root };
  }

  it("leaves the ordinary preview context menu untouched", async () => {
    const { card, onCopySource, root } = await fixture();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    card.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onCopySource).not.toHaveBeenCalled();
    await act(() => root.unmount());
  });

  it.each([
    ["edit-source", "edit"],
    ["copy-source", "copy"],
  ] as const)("routes %s through the supplied authoring command", async (action, expected) => {
    const onEditSource = vi.fn();
    const showContextMenu = vi.fn(async () => action);
    const { card, onCopySource, root } = await fixture({ onEditSource, showContextMenu });
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
    await act(() => root.unmount());
  });

  it("anchors a keyboard context-menu request to its focused target", async () => {
    const showContextMenu = vi.fn(async () => null);
    const { card, root } = await fixture({ onEditSource: vi.fn(), showContextMenu });
    card.getBoundingClientRect = () => ({ left: 80, top: 120, width: 200, height: 90 }) as DOMRect;

    await act(async () => {
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(showContextMenu).toHaveBeenCalledExactlyOnceWith({ x: 104, y: 144 });
    await act(() => root.unmount());
  });
});
