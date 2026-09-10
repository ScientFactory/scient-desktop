// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GapCursor } from "prosemirror-gapcursor";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { CellSelection, mergeCells } from "prosemirror-tables";

import { ScientMarkdownEditorView } from "./view";
import { inlineTableArrow, inlineTableEnter } from "./tableNavigation";
import { ScientProseMirrorSession } from "./session";

const TABLE = "| Alpha | Beta |\n| --- | --- |\n| Gamma | Delta |\n| Epsilon | Zeta |\n";

describe("inline GFM table keyboard behavior", () => {
  const controllers: ScientMarkdownEditorView[] = [];
  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.destroy());
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function mount(source = `Before\n\n${TABLE}\nAfter\n`) {
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Table navigation",
      onUserSourceChange,
    });
    const host = document.createElement("div");
    document.body.append(host);
    controllers.push(controller);
    const view = controller.mount(host);
    const cells: { pos: number; start: number; end: number }[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") {
        cells.push({ pos, start: pos + 1, end: pos + 1 + node.content.size });
      }
    });
    const atEdge = vi.spyOn(view, "endOfTextblock").mockReturnValue(true);
    const move = (pos: number) =>
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    const key = (name: string, init: KeyboardEventInit = {}) =>
      Boolean(
        view.someProp("handleKeyDown", (handler) =>
          handler(view, new KeyboardEvent("keydown", { key: name, ...init })),
        ),
      );
    return { controller, view, cells, move, key, atEdge, onUserSourceChange };
  }

  it.each([0, 2])(
    "inserts a single line break in cell %s and preserves it through save and undo",
    (index) => {
      const { controller, view, cells, move, key } = mount(TABLE);
      const original = view.state.doc;
      const text = index === 0 ? "Alpha" : "Gamma";
      move(cells[index]!.start + 2);
      expect(key("Enter")).toBe(true);
      expect(view.state.selection.head).toBe(cells[index]!.start + 3);
      expect(view.state.selection.$head.parent.child(1).type.name).toBe("hard_break");
      const saved = controller.session.session.draftSource;
      expect(saved).toContain(`${text.slice(0, 2)}<br>${text.slice(2)}`);
      const reopened = new ScientProseMirrorSession({ source: saved, revision: "r1" });
      expect(reopened.state.doc.firstChild!.content.eq(view.state.doc.firstChild!.content)).toBe(
        true,
      );
      expect(controller.execute("undo")).toBe(true);
      expect(view.state.doc.eq(original)).toBe(true);
      expect(controller.execute("redo")).toBe(true);
      expect(controller.session.session.draftSource).toBe(saved);
    },
  );

  it("replaces selected text with a line break and keeps Shift-Enter in the same cell", () => {
    const { view, cells, key } = mount(TABLE);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cells[2]!.start + 1, cells[2]!.end - 1),
      ),
    );
    expect(key("Enter")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Ga");
    expect(key("Enter", { shiftKey: true })).toBe(true);
    expect(view.state.selection.$head.parent.childCount).toBe(4);
    expect(view.state.selection.$head.parent.child(2).type.name).toBe("hard_break");
    expect(view.state.doc.firstChild!.childCount).toBe(3);
  });

  it("limits plain Enter line breaks to editable text within a single cell", () => {
    const { controller, view, cells, move } = mount();
    move(2);
    expect(inlineTableEnter(view.state, view.dispatch, view)).toBe(false);
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cells[2]!.pos, cells[3]!.pos),
      ),
    );
    expect(inlineTableEnter(view.state, view.dispatch, view)).toBe(false);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cells[2]!.start, cells[3]!.end),
      ),
    );
    expect(inlineTableEnter(view.state, view.dispatch, view)).toBe(false);
    move(cells[2]!.start);
    controller.setMode("read");
    const original = view.state.doc;
    expect(inlineTableEnter(view.state, view.dispatch, view)).toBe(false);
    expect(view.state.doc).toBe(original);
  });

  it("moves Up/Down to the adjacent row in the same column without changing the table", () => {
    const { controller, view, cells, move, key, onUserSourceChange } = mount();
    const doc = view.state.doc;
    const tableDOM = view.dom.querySelector("table");
    move(cells[3]!.start + 2);
    expect(key("ArrowUp")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Beta");
    expect(key("ArrowDown")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Delta");
    expect(key("ArrowDown")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Zeta");
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.doc).toBe(doc);
    expect(view.dom.querySelector("table")).toBe(tableDOM);
    expect(controller.createSaveIntent()).toBeNull();
    expect(controller.getSnapshot().canUndo).toBe(false);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("crosses left/right cell boundaries and uses text positions rather than table selection", () => {
    const { view, cells, move, key } = mount();
    move(cells[2]!.end);
    expect(key("ArrowRight")).toBe(true);
    expect(view.state.selection.head).toBe(cells[3]!.start);
    expect(key("ArrowLeft")).toBe(true);
    expect(view.state.selection.head).toBe(cells[2]!.end);
  });

  it("leaves in-cell characters, wrapped lines, and modifier shortcuts to native handlers", () => {
    const { view, cells, move, key, atEdge } = mount();
    move(cells[2]!.start + 2);
    atEdge.mockReturnValue(false);
    const selection = view.state.selection;
    for (const arrow of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      expect(key(arrow)).toBe(false);
      expect(view.state.selection).toBe(selection);
    }
    atEdge.mockReturnValue(true);
    expect(key("ArrowLeft", { ctrlKey: true })).toBe(false);
    expect(key("ArrowRight", { metaKey: true })).toBe(false);
    expect(view.state.selection).toBe(selection);
  });

  it("does not replace an existing text selection with an unrelated cell", () => {
    const { view, cells } = mount();
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cells[2]!.start, cells[2]!.end),
      ),
    );
    // Generic ProseMirror handlers still own collapsing existing selections.
    expect(inlineTableArrow("down")(view.state, view.dispatch, view)).toBe(false);
    expect(view.state.selection.from).toBe(cells[2]!.start);
    expect(view.state.selection.to).toBe(cells[2]!.end);
  });

  it("keeps Shift-arrow cell selection, Tab, and Shift-Tab on the existing table machinery", () => {
    const { view, cells, move, key } = mount();
    move(cells[2]!.end);
    expect(key("ArrowRight", { shiftKey: true })).toBe(true);
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    const selection = view.state.selection as CellSelection;
    expect(selection.$anchorCell.pos).toBe(cells[2]!.pos);
    expect(selection.$headCell.pos).toBe(cells[3]!.pos);
    expect(key("ArrowDown", { shiftKey: true })).toBe(true);
    expect((view.state.selection as CellSelection).$headCell.pos).toBe(cells[5]!.pos);
    move(cells[2]!.start);
    expect(key("Tab")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Delta");
    expect(key("Tab", { shiftKey: true })).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Gamma");
  });

  it("leaves the top/bottom of a table through adjacent text without selecting the table", () => {
    const { view, cells, move, key } = mount();
    move(cells[1]!.start);
    expect(key("ArrowUp")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Before");
    move(cells[5]!.end);
    expect(key("ArrowDown")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("After");
    expect(view.state.selection).toBeInstanceOf(TextSelection);
  });

  it("uses the existing gap cursor outside a table-only file without inserting a paragraph", () => {
    const { view, cells, move, key, onUserSourceChange } = mount(TABLE);
    const doc = view.state.doc;
    move(cells[0]!.start);
    expect(key("ArrowUp")).toBe(true);
    expect(view.state.selection).toBeInstanceOf(GapCursor);
    expect(view.state.selection.head).toBe(0);
    move(cells[5]!.end);
    expect(key("ArrowDown")).toBe(true);
    expect(view.state.selection).toBeInstanceOf(GapCursor);
    expect(view.state.selection.head).toBe(doc.content.size);
    expect(view.state.doc).toBe(doc);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("never exposes a typing gap between cells inside a row", () => {
    const { view, cells } = mount(TABLE);
    const gapAt = (pos: number) => {
      const $pos = view.state.doc.resolve(pos);
      return view.someProp("createSelectionBetween", (handler) => handler(view, $pos, $pos));
    };
    for (const cell of cells) {
      expect(gapAt(cell.pos)).not.toBeInstanceOf(GapCursor);
      expect(gapAt(cell.end + 1)).not.toBeInstanceOf(GapCursor);
    }
    expect(gapAt(0)).toBeInstanceOf(GapCursor);
    expect(gapAt(view.state.doc.content.size)).toBeInstanceOf(GapCursor);
  });

  it("handles empty cells and mixed-direction text without changing file contents", () => {
    const { view, cells, move, key, onUserSourceChange } = mount(
      "| שם | value |\n| --- | --- |\n| | שלום 123 |\n",
    );
    move(cells[2]!.start);
    expect(key("ArrowRight")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("שלום 123");
    expect(key("ArrowUp")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("value");
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("follows visual column order in an RTL table", () => {
    const { view, cells, move, key } = mount();
    view.dom.querySelector("table")!.style.direction = "rtl";
    move(cells[3]!.end);
    expect(key("ArrowRight")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Gamma");
    expect(key("ArrowLeft")).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Delta");
  });

  it.each(["ArrowUp", "ArrowDown"])(
    "keeps the visual x and enters the nearest line on %s",
    (arrow) => {
      const { view, cells, move, key } = mount();
      move(cells[2]!.start + 3);
      const target = cells[arrow === "ArrowUp" ? 0 : 4]!;
      const dom = view.nodeDOM(target.pos) as HTMLElement;
      vi.spyOn(dom, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 100, 180, 80));
      vi.spyOn(view, "coordsAtPos").mockImplementation((pos) =>
        pos === view.state.selection.head
          ? { left: 95, right: 95, top: 50, bottom: 70 }
          : {
              left: 25,
              right: 25,
              top: arrow === "ArrowUp" ? 150 : 105,
              bottom: arrow === "ArrowUp" ? 170 : 125,
            },
      );
      const hit = vi
        .spyOn(view, "posAtCoords")
        .mockReturnValue({ pos: target.start + 2, inside: target.pos });
      expect(key(arrow)).toBe(true);
      expect(hit).toHaveBeenCalledWith({ left: 95, top: arrow === "ArrowUp" ? 160 : 115 });
      expect(view.state.selection.head).toBe(target.start + 2);
    },
  );

  it("rejects hit tests outside the neighboring cell", () => {
    const { view, cells, move, key } = mount();
    move(cells[2]!.start);
    vi.spyOn(view.nodeDOM(cells[4]!.pos) as HTMLElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 100, 180, 80),
    );
    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 1, inside: 0 });
    expect(key("ArrowDown")).toBe(true);
    expect(view.state.selection.head).toBe(cells[4]!.start);
  });

  it.each(["ArrowLeft", "ArrowRight"])("enters bidi text from the visual side on %s", (arrow) => {
    const { view, cells, move, key } = mount("| A | B |\n| --- | --- |\n| שלום | English |\n");
    const target = cells[arrow === "ArrowRight" ? 3 : 2]!;
    move(cells[arrow === "ArrowRight" ? 2 : 3]!.start);
    vi.spyOn(view.nodeDOM(target.pos) as HTMLElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 100, 180, 80),
    );
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 95, right: 95, top: 110, bottom: 130 });
    const hit = vi
      .spyOn(view, "posAtCoords")
      .mockReturnValue({ pos: target.end, inside: target.pos });
    expect(key(arrow)).toBe(true);
    expect(hit).toHaveBeenCalledWith({ left: arrow === "ArrowRight" ? 21 : 199, top: 120 });
    expect(view.state.selection.head).toBe(target.end);
  });

  it("uses TableMap to cross merged cells without changing their structure", () => {
    const { view: original, cells } = mount();
    // Qualify the navigation adapter independently of the GFM writer, whose
    // public commands deliberately reject merged tables.
    let state = EditorState.create({
      doc: original.state.doc,
      selection: CellSelection.create(original.state.doc, cells[2]!.pos, cells[3]!.pos),
    });
    mergeCells(state, (transaction) => {
      state = state.apply(transaction);
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cells[1]!.start)));
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView(host, { state });
    vi.spyOn(view, "endOfTextblock").mockReturnValue(true);
    const doc = view.state.doc;
    const cellDOM = view.dom.querySelector("td[colspan='2']");
    expect(inlineTableArrow("down")(view.state, view.dispatch, view)).toBe(true);
    expect(view.state.selection.$head.parent.attrs.colspan).toBe(2);
    expect(inlineTableArrow("down")(view.state, view.dispatch, view)).toBe(true);
    expect(view.state.selection.$head.parent.textContent).toBe("Epsilon");
    expect(view.state.doc).toBe(doc);
    expect(view.dom.querySelector("td[colspan='2']")).toBe(cellDOM);
    view.destroy();
  });

  it("does not take over read-only documents or ordinary paragraphs", () => {
    const { controller, view, cells, move } = mount();
    move(1);
    expect(inlineTableArrow("down")(view.state, view.dispatch, view)).toBe(false);
    move(cells[2]!.start);
    controller.setMode("read");
    const selection = view.state.selection;
    expect(inlineTableArrow("down")(view.state, view.dispatch, view)).toBe(false);
    expect(view.state.selection).toBe(selection);
  });

  it("extends an existing text range across a cell boundary while retaining the anchor", () => {
    const { view, cells, key } = mount();
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cells[2]!.start + 1, cells[2]!.end),
      ),
    );
    expect(key("ArrowRight", { shiftKey: true })).toBe(true);
    const selection = view.state.selection as CellSelection;
    expect(selection).toBeInstanceOf(CellSelection);
    expect(selection.$anchorCell.pos).toBe(cells[2]!.pos);
    expect(selection.$headCell.pos).toBe(cells[3]!.pos);
  });

  it("does not discard a text-selection anchor outside the table on Shift-arrow", () => {
    const { view, cells } = mount();
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, cells[2]!.end)),
    );
    const selection = view.state.selection;
    expect(inlineTableArrow("down", true)(view.state, view.dispatch, view)).toBe(false);
    expect(view.state.selection).toBe(selection);
    expect(view.state.selection.anchor).toBe(1);
  });

  it("extends and contracts repeated RTL Shift-arrows in visual column order", () => {
    const { view, cells, move, key } = mount(
      "| A | B | C |\n| --- | --- | --- |\n| One | Two | Three |\n",
    );
    view.dom.querySelector("table")!.style.direction = "rtl";
    move(cells[3]!.end);
    expect(key("ArrowLeft", { shiftKey: true })).toBe(true);
    expect((view.state.selection as CellSelection).$headCell.pos).toBe(cells[4]!.pos);
    expect(key("ArrowLeft", { shiftKey: true })).toBe(true);
    expect((view.state.selection as CellSelection).$headCell.pos).toBe(cells[5]!.pos);
    expect((view.state.selection as CellSelection).$anchorCell.pos).toBe(cells[3]!.pos);
    expect(key("ArrowLeft", { shiftKey: true })).toBe(true);
    expect((view.state.selection as CellSelection).$headCell.pos).toBe(cells[5]!.pos);
    expect(key("ArrowRight", { shiftKey: true })).toBe(true);
    expect((view.state.selection as CellSelection).$headCell.pos).toBe(cells[4]!.pos);
    expect(key("ArrowRight")).toBe(true);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.$head.parent.textContent).toBe("Two");
  });

  it("does not skip an atomic block immediately outside the table", () => {
    const { view, cells, move, key } = mount(`${TABLE}\n---\n\nAfter\n`);
    const tableEnd = view.state.doc.firstChild!.nodeSize;
    move(cells[5]!.end);
    expect(key("ArrowDown")).toBe(true);
    expect(view.state.selection).toBeInstanceOf(GapCursor);
    expect(view.state.selection.head).toBe(tableEnd);
  });
});
