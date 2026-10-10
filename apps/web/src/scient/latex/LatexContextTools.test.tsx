// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { LatexContextTools } from "./LatexContextTools";

it("keeps object options open through footer interactions and closes explicitly or outside", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() =>
      root.render(
        <div className="scient-latex-visual-workspace">
          <main>Document text</main>
          <footer className="scient-latex-reader-footer">
            <LatexContextTools>
              <div role="toolbar" aria-label="Object options">
                <input aria-label="Object title" />
              </div>
            </LatexContextTools>
            <span className="scient-document-footer-count">100 words</span>
          </footer>
        </div>,
      ),
    );
    const context = host.querySelector<HTMLElement>(".scient-latex-context-tools")!;
    const trigger = context.querySelector<HTMLButtonElement>("button")!;
    const footer = host.querySelector("footer")!;
    const count = footer.querySelector(".scient-document-footer-count")!;
    await act(() => trigger.click());
    expect(context.hasAttribute("data-open")).toBe(true);
    for (const target of [footer, count]) {
      await act(() => target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      await act(() => target.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      expect(context.hasAttribute("data-open")).toBe(true);
    }
    await act(() =>
      context.querySelector<HTMLButtonElement>('[aria-label="Close object options"]')!.click(),
    );
    expect(context.hasAttribute("data-open")).toBe(false);
    await act(() => trigger.click());
    await act(() =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(context.hasAttribute("data-open")).toBe(false);
    await act(() => trigger.click());
    await act(() =>
      host.querySelector("main")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    );
    expect(context.hasAttribute("data-open")).toBe(false);
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
