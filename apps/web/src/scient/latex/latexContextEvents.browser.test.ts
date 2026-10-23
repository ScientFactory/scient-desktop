import { describe, expect, it, vi } from "vite-plus/test";
import { isLatexContextEvent, isLatexEditingMenuEvent } from "./latexContextEvents";
import { registerLatexSelection, runLatexSelectionCommand } from "./latexSelectionSession";

describe("LaTeX footer event ownership", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.host = document.createElement("div");
    _fixture.host.innerHTML = `
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
    document.body.append(_fixture.host);
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await _fixture.host.remove();
  }
  const element = (_fixture: _Fixture, id: string) =>
    _fixture.host.querySelector<HTMLElement>(`#${id}`)!;
  function dispatch(_fixture: _Fixture, type: string, id: string, inspect: (event: Event) => void) {
    const target = element(_fixture, id);
    target.addEventListener(type, inspect, { once: true });
    target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }

  it.each(["pointerdown", "focusin"])("keeps %s within the whole owning footer", async (type) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    for (const id of ["control", "space", "footer", "status", "count"]) {
      dispatch(_fixture, type, id, (event) => {
        expect(isLatexContextEvent(event, element(_fixture, "context")), id).toBe(true);
        expect(isLatexEditingMenuEvent(event, element(_fixture, "object")), id).toBe(true);
        expect(isLatexEditingMenuEvent(event, element(_fixture, "nested-field")), id).toBe(true);
      });
    }
  });

  it.each(["pointerdown", "focusin"])("leaves other locations outside on %s", async (type) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    for (const id of ["document", "other-footer", "nested-document-footer", "outside"]) {
      dispatch(_fixture, type, id, (event) => {
        expect(isLatexContextEvent(event, element(_fixture, "context")), id).toBe(false);
        expect(isLatexEditingMenuEvent(event, element(_fixture, "object")), id).toBe(false);
      });
    }
  });

  it("holds a nested selection for a footer command and releases it for another document", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const restore = vi.fn(() => true);
    const command = vi.fn(() => true);
    const field = element(_fixture, "nested-field");
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
      dispatch(_fixture, "pointerdown", "nested-field", () => {});
      dispatch(_fixture, "pointerdown", "count", () => {});
      expect(field.hasAttribute("data-scient-selection-held")).toBe(true);
      expect(runLatexSelectionCommand(field, "selectionExpand")).toBe(true);
      expect(restore).toHaveBeenCalledWith(false);
      expect(command).toHaveBeenCalledWith("selectionExpand");
      dispatch(_fixture, "pointerdown", "other-footer", () => {});
      expect(runLatexSelectionCommand(field, "selectionExpand")).toBe(false);
      expect(command).toHaveBeenCalledTimes(1);
    } finally {
      registration.dispose();
    }
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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
