// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DOMParser, DOMSerializer } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";

import { scientMarkdownSchema } from "./schema";
import { createScientMarkdownProjection } from "./projection";
import { ScientMarkdownEditorView, type ScientMarkdownEditorViewOptions } from "./view";

const TABLE = "| Name | Value |\n| --- | ---: |\n| שלום | 42 |\n| World | 7 |";
const SOURCE = `Before.\n\n${TABLE}\n\nAfter.\n`;
const controllers: ScientMarkdownEditorView[] = [];

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  document.body.replaceChildren();
});

function mount(
  source = SOURCE,
  options: Partial<
    Pick<ScientMarkdownEditorViewOptions, "showLinkContextMenu" | "showTableContextMenu">
  > = {},
) {
  const onUserSourceChange = vi.fn();
  const controller = new ScientMarkdownEditorView({
    source,
    revision: "r0",
    mode: "write",
    ariaLabel: "Tables",
    onUserSourceChange,
    ...options,
  });
  controllers.push(controller);
  const host = document.body.appendChild(document.createElement("div"));
  const view = controller.mount(host);
  const cells: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell")
      cells.push(pos);
  });
  const select = (pos: number) =>
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  return { controller, host, view, cells, select, onUserSourceChange };
}

describe("whole Markdown table selection", () => {
  it("round-trips a directed nested table without losing its blockquote or trailing CRLF prose", () => {
    const source = `${TABLE.split("\n")
      .map((line) => `> ${line}`)
      .join("\r\n")}\r\n\r\nUntouched  tail.\r\n`;
    const { controller, view, cells, select } = mount(source);
    select(cells[2]! + 1);
    controller.execute("select-table");
    controller.execute("direction-rtl");
    expect(view.state.doc.firstChild?.type.name).toBe("blockquote");
    const saved = controller.session.session.draftSource;
    expect(saved.endsWith("\r\n\r\nUntouched  tail.\r\n")).toBe(true);
    const parsed = createScientMarkdownProjection(saved).document;
    expect(parsed.firstChild?.firstChild?.type.name, saved).toBe("table");
    expect(parsed.firstChild?.firstChild?.attrs.dir).toBe("rtl");
    expect(parsed.firstChild?.textContent).toBe(view.state.doc.firstChild?.textContent);
    controller.execute("undo");
    expect(controller.session.session.draftSource).toBe(source);
  });
  it("activates only the current table and selects every cell without changing source or save state", () => {
    const { controller, host, view, cells, select, onUserSourceChange } = mount(
      `${SOURCE}\n${TABLE}\n`,
    );
    expect(host.querySelector(".is-active-table")).toBeNull();
    select(cells[3]! + 1);
    const active = host.querySelector(".is-active-table")!;
    expect(host.querySelectorAll(".is-active-table")).toHaveLength(1);
    const originalTableDOM = active.querySelector("table");
    const button = active.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-label")).toBe("Select whole table");
    expect(button.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.5");
    button.click();
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    const selection = view.state.selection as CellSelection;
    expect(selection.isRowSelection()).toBe(true);
    expect(selection.isColSelection()).toBe(true);
    expect(selection.$anchorCell.pos).toBe(cells[0]);
    expect(selection.$headCell.pos).toBe(cells[5]);
    expect(active.querySelector("table")).toBe(originalTableDOM);
    expect(view.hasFocus()).toBe(true);
    expect(controller.getSnapshot().inTable).toBe(true);
    expect(controller.getSnapshot().canUndo).toBe(false);
    expect(onUserSourceChange).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(`${SOURCE}\n${TABLE}\n`);
    select(cells[7]! + 1);
    expect(active.classList.contains("is-active-table")).toBe(false);
    select(1);
    expect(host.querySelector(".is-active-table")).toBeNull();
  });

  it("shares selection with the command menu and ignores inactive or read-only button activation", () => {
    const { controller, host, view, cells, select } = mount();
    const button = host.querySelector<HTMLButtonElement>(".scient-markdown-table-select")!;
    const before = view.state.selection;
    button.click();
    expect(view.state.selection.eq(before)).toBe(true);
    expect(controller.execute("select-table")).toBe(false);
    select(cells[2]! + 1);
    controller.setMode("read");
    button.click();
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(controller.execute("select-table")).toBe(false);
    controller.setMode("write");
    expect(controller.execute("select-table")).toBe(true);
    expect((view.state.selection as CellSelection).isColSelection()).toBe(true);
    expect(controller.execute("bold")).toBe(true);
    expect(controller.session.session.draftSource).toContain("| **Name** | **Value** |");
    expect(controller.session.session.draftSource).toContain("| **שלום** | **42** |");
    expect(controller.session.session.draftSource.startsWith("Before.\n\n")).toBe(true);
    expect(controller.session.session.draftSource.endsWith("\n\nAfter.\n")).toBe(true);
    controller.execute("undo");
    expect(controller.session.session.draftSource).toBe(SOURCE);
  });

  it("runs the existing table command against the right-clicked cell", async () => {
    const showTableContextMenu = vi.fn(async () => "delete-row" as const);
    const { controller, host, view, cells, select, onUserSourceChange } = mount(SOURCE, {
      showTableContextMenu,
    });
    select(cells[0]! + 1);
    const target = host.querySelectorAll<HTMLTableCellElement>("tbody td")[2]!;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 38,
      clientY: 52,
    });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(showTableContextMenu).toHaveBeenCalledExactlyOnceWith({ x: 38, y: 52 });
    await vi.waitFor(() => expect(controller.session.session.draftSource).not.toContain("World"));
    expect(controller.session.session.draftSource).toContain("שלום");
    expect(onUserSourceChange).toHaveBeenCalledOnce();
    expect(view.hasFocus()).toBe(true);
  });

  it("opens the handle menu without selecting or mutating the table", async () => {
    const showTableContextMenu = vi.fn(async () => null);
    const { controller, host, view, cells, select, onUserSourceChange } = mount(SOURCE, {
      showTableContextMenu,
    });
    select(cells[2]! + 1);
    const beforeSelection = view.state.selection;
    const button = host.querySelector<HTMLButtonElement>(".scient-markdown-table-select")!;
    const primaryMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(primaryMouseDown);
    expect(primaryMouseDown.defaultPrevented).toBe(true);
    const secondaryMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    button.dispatchEvent(secondaryMouseDown);
    expect(secondaryMouseDown.defaultPrevented).toBe(false);
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 11,
      clientY: 19,
    });

    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(showTableContextMenu).toHaveBeenCalledExactlyOnceWith({ x: 11, y: 19 });
    await vi.waitFor(() => expect(showTableContextMenu).toHaveBeenCalledOnce());
    expect(view.state.selection.eq(beforeSelection)).toBe(true);
    expect(controller.session.session.draftSource).toBe(SOURCE);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("preserves native text actions and gives links precedence inside cells", async () => {
    const showTableContextMenu = vi.fn(async () => null);
    const showLinkContextMenu = vi.fn(async () => null);
    const source = "| Link |\n| --- |\n| [[Notes]] and words |\n";
    const { host, view, cells } = mount(source, {
      showLinkContextMenu,
      showTableContextMenu,
    });
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cells[1]! + 1, cells[1]! + 3),
      ),
    );
    const cell = host.querySelector<HTMLTableCellElement>("tbody td")!;
    const textEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    cell.dispatchEvent(textEvent);
    expect(textEvent.defaultPrevented).toBe(false);
    expect(showTableContextMenu).not.toHaveBeenCalled();

    const link = host.querySelector<HTMLElement>("[data-scient-markdown-wiki-link]")!;
    link.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 31,
      }),
    );
    await vi.waitFor(() => expect(showLinkContextMenu).toHaveBeenCalledOnce());
    expect(showTableContextMenu).not.toHaveBeenCalled();
  });

  it("ignores a delayed table action after the selection leaves its context", async () => {
    let resolveMenu!: (action: "delete-row") => void;
    const showTableContextMenu = vi.fn(
      () =>
        new Promise<"delete-row">((resolve) => {
          resolveMenu = resolve;
        }),
    );
    const { controller, host, view, onUserSourceChange } = mount(SOURCE, {
      showTableContextMenu,
    });
    const target = host.querySelector<HTMLTableCellElement>("tbody td")!;
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 17,
        clientY: 29,
      }),
    );
    expect(showTableContextMenu).toHaveBeenCalledOnce();

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    resolveMenu("delete-row");
    await Promise.resolve();

    expect(controller.session.session.draftSource).toBe(SOURCE);
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it.each(["ltr", "rtl"] as const)(
    "persists %s direction, preserves cell selection, and reverses through undo/redo and Auto",
    (dir) => {
      const { controller, host, view, cells, select } = mount();
      select(cells[2]! + 1);
      controller.execute("select-table");
      controller.execute(`direction-${dir}`);
      const source = controller.session.session.draftSource;
      expect(source).toContain(`<div dir="${dir}">\n\n${TABLE}\n\n</div>`);
      expect(view.state.selection).toBeInstanceOf(CellSelection);
      expect(controller.getSnapshot().textDirection).toBe(dir);
      expect(host.querySelector("table")?.getAttribute("dir")).toBe(dir);
      const reopened = createScientMarkdownProjection(source).document;
      expect(reopened.child(1).type.name).toBe("table");
      expect(reopened.child(1).attrs.dir).toBe(dir);
      expect(reopened.child(1).childCount).toBe(3);
      expect(reopened.child(1).child(1).textContent).toBe("שלום42");
      controller.execute("undo");
      expect(controller.session.session.draftSource).toBe(SOURCE);
      expect(host.querySelector("table")?.hasAttribute("dir")).toBe(false);
      controller.execute("redo");
      expect(controller.session.session.draftSource).toBe(source);
      controller.execute("direction-auto");
      expect(controller.session.session.draftSource).toBe(SOURCE);
      expect(controller.getSnapshot().textDirection).toBeNull();
      expect(host.querySelector("table")?.hasAttribute("dir")).toBe(false);
    },
  );

  it("keeps direction and valid GFM through structural edits, delete/undo, and DOM copying", () => {
    const { controller, host, view, cells, select } = mount(
      `<div dir="rtl">\n\n${TABLE}\n\n</div>\n`,
    );
    select(cells[2]! + 1);
    controller.execute("add-row-after");
    expect(view.state.doc.firstChild?.childCount).toBe(4);
    expect(host.querySelector("table")?.dir).toBe("rtl");
    const clipboard = document.createElement("div");
    clipboard.append(
      DOMSerializer.fromSchema(scientMarkdownSchema).serializeFragment(view.state.doc.content),
    );
    const copied = DOMParser.fromSchema(scientMarkdownSchema).parse(clipboard);
    expect(copied.firstChild?.attrs.dir).toBe("rtl");
    expect(copied.firstChild?.childCount).toBe(4);
    controller.execute("select-table");
    const beforeDelete = controller.session.session.draftSource;
    controller.execute("delete-table");
    expect(host.querySelector("table")).toBeNull();
    controller.execute("undo");
    expect(controller.session.session.draftSource).toBe(beforeDelete);
    expect(host.querySelector("table")?.dir).toBe("rtl");
  });

  it("applies direction as a block attribute from a cell without changing its caret or adjacent prose", () => {
    const { controller, view, cells, select } = mount();
    select(cells[3]! + 1);
    const position = view.state.selection.head;
    controller.execute("direction-rtl");
    expect(view.state.selection.head).toBe(position);
    expect(view.state.doc.child(0).attrs.dir).toBeNull();
    expect(view.state.doc.child(1).attrs.dir).toBe("rtl");
    expect(view.state.doc.child(2).attrs.dir).toBeNull();
    const reopened = createScientMarkdownProjection(controller.session.session.draftSource);
    expect(reopened.document.childCount).toBe(3);
  });
});
