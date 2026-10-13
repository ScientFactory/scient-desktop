import "../../index.css";

import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { SelectionCitationToolbar } from "./AssistantSelectionToolbar";

it.each([
  { pointer: { x: 700, y: 350 }, expected: { x: 340, y: 224 } },
  { pointer: { x: 315, y: 215 }, expected: { x: 315, y: 215 } },
])("anchors model selection to ink bounds for pointer $pointer", async ({ pointer, expected }) => {
  const viewport = document.createElement("div");
  viewport.style.cssText = "position:fixed;left:50px;top:50px;width:600px;height:400px";
  document.body.append(viewport);
  const root = createRoot(viewport);
  const sourceAnchor = {
    source: viewport,
    viewport,
    range: document.createRange(),
    resolveRects: () => [new DOMRect(300, 200, 40, 20)],
  };
  const citation = { text: "Selected model source" };
  const onCite = vi.fn(() => true);
  try {
    root.render(
      <SelectionCitationToolbar
        viewport={viewport}
        capture={() => ({ citation, sourceAnchor })}
        onCite={onCite}
        preserveSelection
      />,
    );
    // The model has no DOM text range; its own ink bounds locate the selection.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
    );
    viewport.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: pointer.x,
        clientY: pointer.y,
      }),
    );
    const action = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Ask in chat"]');
    await expect.poll(() => action()?.style.left).toBe(`${expected.x}px`);
    expect(action()!.style.top).toBe(`${expected.y}px`);
    action()!.click();
    expect(onCite).toHaveBeenCalledWith(citation, sourceAnchor);
  } finally {
    root.unmount();
    viewport.remove();
  }
});
