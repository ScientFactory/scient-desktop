// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isLatexContextEvent, isLatexEditingMenuEvent } from "./latexContextEvents";
import { registerLatexSelection, runLatexSelectionCommand } from "./latexSelectionSession";

describe("LaTeX footer event ownership", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    host.innerHTML = `
      <div class="scient-latex-visual-workspace">
        <main id="document"><div id="object"><textarea id="nested-field"></textarea></div></main>
        <footer class="scient-latex-reader-footer" id="footer">
          <div class="scient-document-footer-options" id="space">
            <div class="scient-latex-context-tools" id="context"><button id="control">Label</button></div>
          </div>
          <div class="scient-document-footer-status" id="status"><span id="count">100 words</span></div>
        </footer>
        <div class="scient-latex-visual-workspace"><footer class="scient-latex-reader-footer" id="nested-document-footer"></footer></div>
      </div>
      <div class="scient-latex-visual-workspace"><footer class="scient-latex-reader-footer" id="other-footer"></footer></div>
      <button id="outside">App action</button>`;
    document.body.append(host);
  });
  afterEach(() => host.remove());
  const element = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;
  function dispatch(type: string, id: string, inspect: (event: Event) => void) {
    const target = element(id);
    target.addEventListener(type, inspect, { once: true });
    target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  it.each(["pointerdown", "focusin"])("keeps %s within the whole owning footer", (type) => {
    for (const id of ["control", "space", "footer", "status", "count"]) {
      dispatch(type, id, (event) => {
        expect(isLatexContextEvent(event, element("context")), id).toBe(true);
        expect(isLatexEditingMenuEvent(event, element("object")), id).toBe(true);
        expect(isLatexEditingMenuEvent(event, element("nested-field")), id).toBe(true);
      });
    }
  });

  it.each(["pointerdown", "focusin"])("leaves other locations outside on %s", (type) => {
    for (const id of ["document", "other-footer", "nested-document-footer", "outside"]) {
      dispatch(type, id, (event) => {
        expect(isLatexContextEvent(event, element("context")), id).toBe(false);
        expect(isLatexEditingMenuEvent(event, element("object")), id).toBe(false);
      });
    }
  });

  it("holds a nested selection for a footer command and releases it for another document", () => {
    const restore = vi.fn(() => true);
    const command = vi.fn(() => true);
    const field = element("nested-field");
    const registration = registerLatexSelection({
      element: field,
      capture: () => ({
        path: ["Equation", "Numerator"],
        scopes: () => [],
        selection: () => [],
        restore,
      }),
      command,
    });
    try {
      dispatch("pointerdown", "nested-field", () => {});
      dispatch("pointerdown", "count", () => {});
      expect(field.hasAttribute("data-scient-selection-held")).toBe(true);
      expect(runLatexSelectionCommand(field, "selectionExpand")).toBe(true);
      expect(restore).toHaveBeenCalledWith(false);
      expect(command).toHaveBeenCalledWith("selectionExpand");
      dispatch("pointerdown", "other-footer", () => {});
      expect(runLatexSelectionCommand(field, "selectionExpand")).toBe(false);
      expect(command).toHaveBeenCalledTimes(1);
    } finally {
      registration.dispose();
    }
  });
});
