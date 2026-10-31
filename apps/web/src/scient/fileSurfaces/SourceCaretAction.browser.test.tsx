import "../../index.css";

import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { SourceCaretAction } from "./SourceCaretAction";

function Surface(props: {
  readonly capture: (viewport: HTMLElement) => {
    citation: string;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null;
  readonly onCite: (citation: string, anchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setViewport}
      data-testid="surface"
      style={{ position: "relative", width: 400, height: 200, overflow: "auto" }}
    >
      {viewport === null ? null : (
        <SourceCaretAction
          viewport={viewport}
          capture={() => props.capture(viewport)}
          onCite={props.onCite}
        />
      )}
      <span id="code">value = 1</span>
      <div style={{ height: 600 }} />
    </div>
  );
}

function quote(viewport: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(viewport.querySelector("#code")!);
  const rows = [...range.getClientRects()];
  return {
    citation: "cell",
    sourceAnchor: { source: viewport, viewport, range, resolveRects: () => rows },
  };
}

/** A click as a person makes it, `x` and `y` from the surface's corner. */
async function click(x = 20, y = 30) {
  const surface = document.querySelector<HTMLElement>('[data-testid="surface"]')!;
  const { left, top } = surface.getBoundingClientRect();
  const at = { bubbles: true, button: 0, clientX: left + x, clientY: top + y };
  await act(async () => {
    surface.dispatchEvent(new PointerEvent("pointerdown", { ...at, isPrimary: true }));
    surface.dispatchEvent(new MouseEvent("mouseup", at));
    surface.dispatchEvent(new PointerEvent("pointerup", { ...at, isPrimary: true }));
  });
}

const action = () =>
  [...document.querySelectorAll("button")].find((button) => button.innerText === "Ask in chat") ??
  null;

describe("Ask in chat for a clicked caret", () => {
  it("opens where the pointer is, like a selection's action", async () => {
    await using _screen = await render(<Surface capture={quote} onCite={() => true} />);
    await click(20, 30);
    await vi.waitFor(() => expect(action()).not.toBeNull());
    const surface = document.querySelector('[data-testid="surface"]')!.getBoundingClientRect();
    const { left, top } = action()!.getBoundingClientRect();
    expect([left - surface.left, top - surface.top]).toEqual([20, 30]);
  });

  it("stays inside the surface near its edges", async () => {
    await using _screen = await render(<Surface capture={quote} onCite={() => true} />);
    await click(398, 198);
    await vi.waitFor(() => expect(action()).not.toBeNull());
    const surface = document.querySelector('[data-testid="surface"]')!.getBoundingClientRect();
    const { right, bottom } = action()!.getBoundingClientRect();
    expect(right).toBeLessThanOrEqual(surface.right);
    expect(bottom).toBeLessThanOrEqual(surface.bottom);
  });

  it("lets a second press at the same spot through to the editor", async () => {
    await using _screen = await render(<Surface capture={quote} onCite={() => true} />);
    await click(20, 30);
    await vi.waitFor(() => expect(action()).not.toBeNull());
    const surface = document.querySelector('[data-testid="surface"]')!;
    const { left, top } = surface.getBoundingClientRect();
    const under = document.elementFromPoint(left + 20, top + 30);
    expect(under?.closest("button")).toBeNull();
    expect(getComputedStyle(under!).pointerEvents).not.toBe("none");
    expect(surface.contains(under)).toBe(true);
    const wrapper = action()!.parentElement!;
    expect(under).not.toBe(wrapper);
  });

  it("offers nothing when the caret stands for nothing", async () => {
    const capture = vi.fn(() => null);
    await using _screen = await render(<Surface capture={capture} onCite={() => true} />);
    await click();
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    expect(action()).toBeNull();
  });

  it("cites what it offered, with only the rows in view", async () => {
    const onCite = vi.fn((_citation: string, _anchor: AssistantCitationSourceAnchor) => true);
    await using _screen = await render(<Surface capture={quote} onCite={onCite} />);
    await click();
    await vi.waitFor(() => expect(action()).not.toBeNull());
    await act(async () => action()!.click());
    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite.mock.calls[0]![0]).toBe("cell");
    expect(onCite.mock.calls[0]![1].resolveRects?.().length).toBeGreaterThan(0);
    expect(action()).toBeNull();
  });

  it("leaves at the first key, even one the page stops at the document", async () => {
    const stopEscape = (event: KeyboardEvent) => event.stopImmediatePropagation();
    document.addEventListener("keydown", stopEscape, true);
    try {
      await using _screen = await render(<Surface capture={quote} onCite={() => true} />);
      await click();
      await vi.waitFor(() => expect(action()).not.toBeNull());
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      });
      expect(action()).toBeNull();
    } finally {
      document.removeEventListener("keydown", stopEscape, true);
    }
  });

  it("leaves when the code scrolls", async () => {
    await using _screen = await render(<Surface capture={quote} onCite={() => true} />);
    await click();
    await vi.waitFor(() => expect(action()).not.toBeNull());
    await act(async () => {
      document.querySelector('[data-testid="surface"]')!.dispatchEvent(new Event("scroll"));
    });
    expect(action()).toBeNull();
  });
});
