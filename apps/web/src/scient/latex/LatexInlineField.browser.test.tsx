import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { describe, expect, it, vi } from "vite-plus/test";
import { LatexInlineField } from "./LatexInlineField";
import { LatexDraftContext, replaceLatexFieldDraft } from "./LatexTextField";

describe("rich-cell pending input", () => {
  const publish = vi.fn(() => false);
  const pending = new Set<string>();
  const reportDraft = (id: string, value: boolean) => {
    if (value) pending.add(id);
    else pending.delete(id);
  };
  async function _setupFixture0(_fixture: _Fixture) {
    localStorage.clear();
    publish.mockClear();
    pending.clear();
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    _fixture.owner = new Editor({ extensions: [StarterKit], content: "<p>Owner</p>" });
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.owner.destroy();
    _fixture.host.remove();
    vi.unstubAllGlobals();
  }
  const render = async (_fixture: _Fixture, source = "Original") =>
    await act(
      async () =>
        await _fixture.root0.rerender(
          <LatexDraftContext value={{ reportDraft, undo: () => {} }}>
            <LatexInlineField
              owner={_fixture.owner}
              source={source}
              draftKey="synthetic-inline-cell"
              label="Cell"
              cell="0-0"
              width="content"
              disabled={false}
              extensions={[]}
              onFocus={() => {}}
              onChange={publish}
              onTab={() => {}}
              onExit={() => {}}
            />
          </LatexDraftContext>,
        ),
    );

  it.each(["restored"])(
    "retires %s input and its journal on an accepted grouped replacement",
    async (kind) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      if (kind === "restored")
        localStorage.setItem(
          "scient.latex.field:synthetic-inline-cell",
          JSON.stringify({
            base: "Original",
            text: "Unfinished",
          }),
        );
      await render(_fixture);
      const field = _fixture.host.querySelector<HTMLElement>("[data-table-cell]")!;
      const inner = (field as HTMLElement & { editor: Editor }).editor;
      expect(inner.state.doc.textContent).toBe("Unfinished");
      expect(pending.size).toBe(1);
      expect(localStorage.getItem("scient.latex.field:synthetic-inline-cell")).not.toBeNull();
      publish.mockClear();
      await act(() => {
        replaceLatexFieldDraft(field, "");
        expect(pending.size).toBe(0);
        expect(inner.state.doc.textContent).toBe("");
      });
      await render(_fixture, "");
      expect(publish).not.toHaveBeenCalled();
      expect(localStorage.getItem("scient.latex.field:synthetic-inline-cell")).toBeNull();
      // Subsequent document Undo/source updates can replace the field again.
      await render(_fixture);
      expect(inner.state.doc.textContent).toBe("Original");
      expect(pending.size).toBe(0);
    },
  );

  it("paints typing before publication and retains a refused cell draft", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const element = _fixture.host.querySelector<HTMLElement>("[data-table-cell]")!;
    const field = (element as HTMLElement & { editor: Editor }).editor;
    await act(() => field.commands.setTextSelection({ from: 2, to: 5 }));
    await act(() => field.commands.insertContent("Unavailable"));
    expect(field.state.doc.textContent).toContain("Unavailable");
    expect(publish).not.toHaveBeenCalled();
    await act(() => element.dispatchEvent(new Event("scient-latex-flush-field")));
    expect(publish).toHaveBeenCalled();
    expect(field.state.doc.textContent).toContain("Unavailable");
    expect(pending.size).toBe(1);
    expect(localStorage.getItem("scient.latex.field:synthetic-inline-cell")).toContain(
      "Unavailable",
    );
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    owner: undefined! as Editor,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
