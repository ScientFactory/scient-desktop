// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ScientMarkdownEditorView } from "../prosemirror/view";
import { ScientMarkdownControls } from "./ScientMarkdownControls";

describe("formatting menu focus", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function fixture(
    source = "A paragraph\n",
    showLinkContextMenu?: ConstructorParameters<
      typeof ScientMarkdownEditorView
    >[0]["showLinkContextMenu"],
  ) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Document",
      ...(showLinkContextMenu ? { showLinkContextMenu } : {}),
    });
    const editorHost = document.createElement("div");
    const controlsHost = document.createElement("div");
    document.body.append(controlsHost, editorHost);
    const view = controller.mount(editorHost);
    expect(view.hasFocus(), "mounted editable document must accept focus").toBe(true);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    const root = createRoot(controlsHost);
    cleanups.push(async () => {
      await act(() => root.unmount());
      controller.destroy();
    });
    await act(() =>
      root.render(
        <ScientMarkdownControls
          controller={controller}
          expanded
          onExpandedChange={() => undefined}
        />,
      ),
    );
    return { view, controller, controlsHost };
  }

  it("opens the existing link editor with the right-clicked destination prefilled", async () => {
    const showLinkContextMenu = vi.fn(async () => "edit" as const);
    const { controlsHost } = await fixture(
      "[linked words](notes.md) beside\n",
      showLinkContextMenu,
    );
    const link = document.querySelector<HTMLAnchorElement>("a[href]")!;

    await act(() => {
      link.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
    });

    const input = await vi.waitFor(() => {
      const element = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Link destination"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    expect(input.value).toBe("notes.md");
    expect(showLinkContextMenu).toHaveBeenCalledOnce();
    expect(controlsHost.querySelectorAll('button[aria-label="Add or edit link"]')).toHaveLength(1);
  });

  it.each([
    ["Style:", "Heading 2", "heading-2", "A paragraph\n"],
    ["List:", "Numbered list", "ordered-list", "A paragraph\n"],
    ["Text direction:", "Right-to-left", "direction-rtl", "A paragraph\n"],
    ["Style:", "Paragraph", "paragraph", "A paragraph\n"],
    ["Style:", "Paragraph", "paragraph", "> A quote\n"],
  ])(
    "closes %s after %s and leaves the caret ready to type (%s, %s)",
    async (prefix, label, command, source) => {
      const { view, controller, controlsHost } = await fixture(source);
      const execute = vi.spyOn(controller, "execute");
      const trigger = controlsHost.querySelector<HTMLButtonElement>(
        `button[aria-label^='${prefix}']`,
      )!;
      await act(() => {
        trigger.focus();
        trigger.click();
      });
      const item = Array.from(
        document.body.querySelectorAll<HTMLElement>("[role='menuitemradio']"),
      ).find((node) => node.textContent?.trim() === label);
      expect(item).toBeDefined();
      await act(() => {
        item!.focus();
        item!.click();
      });
      expect(execute).toHaveBeenCalledWith(command);
      await vi.waitFor(() => expect(document.body.querySelector("[role='menu']")).toBeNull());
      await vi.waitFor(() => expect(document.activeElement === view.dom).toBe(true));
      expect(view.hasFocus()).toBe(true);
      expect(view.state.selection.empty).toBe(true);
    },
  );
  it("selects the whole table and exposes explicit and automatic table direction", async () => {
    const { view, controller, controlsHost } = await fixture(
      "| A | B |\n| --- | --- |\n| One | Two |\n",
    );
    const trigger = controlsHost.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions"]',
    )!;
    await act(() => trigger.click());
    const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (node) => node.textContent?.trim() === "Select whole table",
    )!;
    expect(item).toBeDefined();
    await act(() => item.click());
    await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).toBeNull());
    await vi.waitFor(() => expect(view.hasFocus()).toBe(true));
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    expect((view.state.selection as CellSelection).isColSelection()).toBe(true);
    const direction = controlsHost.querySelector<HTMLButtonElement>(
      'button[aria-label^="Table direction:"]',
    )!;
    await act(() => direction.click());
    const directionItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    expect(
      directionItems.find((node) => node.textContent?.trim() === "Auto — detect from table"),
    ).toBeDefined();
    const rtl = directionItems.find((node) => node.textContent?.trim() === "Right-to-left")!;
    await act(() => rtl.click());
    await vi.waitFor(() => expect(controller.getSnapshot().textDirection).toBe("rtl"));
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    expect(controller.session.session.draftSource).toContain('<div dir="rtl">');

    await act(() => direction.click());
    const automatic = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((node) => node.textContent?.trim() === "Auto — detect from table")!;
    await act(() => automatic.click());
    await vi.waitFor(() => expect(controller.getSnapshot().textDirection).toBeNull());
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    expect(controller.session.session.draftSource).not.toContain('<div dir="rtl">');
  });

  it("keeps normal trigger focus on Escape without running a command", async () => {
    const { controller, controlsHost } = await fixture();
    const execute = vi.spyOn(controller, "execute");
    const trigger = controlsHost.querySelector<HTMLButtonElement>("button[aria-label^='Style:']")!;
    await act(() => {
      trigger.focus();
      trigger.click();
    });
    const menu = document.body.querySelector<HTMLElement>("[role='menu']")!;
    await act(() => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(execute).not.toHaveBeenCalled();
  });

  it("inserts a paired footnote and leaves its one-line text editor ready", async () => {
    const { controller, controlsHost } = await fixture("A paragraph\n");
    const trigger = controlsHost.querySelector<HTMLButtonElement>(
      'button[aria-label="Insert block or element"]',
    )!;
    await act(() => trigger.click());
    const footnote = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Footnote")!;
    expect(footnote).toBeDefined();

    await act(() => footnote.click());

    await vi.waitFor(() =>
      expect(controller.session.session.draftSource).toBe("A [^note-1]paragraph\n\n[^note-1]: \n"),
    );
    const editor = document.body.querySelector<HTMLTextAreaElement>(
      '.scient-markdown-footnote-definition textarea[aria-label="Footnote text"]',
    )!;
    await vi.waitFor(() => expect(document.activeElement).toBe(editor));
    expect(editor.hidden).toBe(false);
  });

  it("closes nested outline actions and focuses the chosen heading", async () => {
    const { view, controller, controlsHost } = await fixture(
      "# First\n\nParagraph\n\n## Second\n\nText\n",
    );
    const navigate = vi.spyOn(controller, "navigateToOutline");
    await act(() =>
      controlsHost.querySelector<HTMLButtonElement>("[aria-label='More actions']")!.click(),
    );
    const outline = Array.from(
      document.body.querySelectorAll<HTMLElement>("[role='menuitem']"),
    ).find((item) => item.textContent?.includes("Document outline"))!;
    await act(() => {
      outline.focus();
      outline.click();
    });
    const heading = Array.from(
      document.body.querySelectorAll<HTMLElement>("[role='menuitem']"),
    ).find((item) => item.textContent?.trim() === "Second")!;
    expect(heading).toBeDefined();
    await act(() => {
      heading.focus();
      heading.click();
    });
    await vi.waitFor(() => expect(document.body.querySelector("[role='menu']")).toBeNull());
    expect(navigate).toHaveBeenCalledOnce();
    expect(view.state.selection.$from.parent.textContent).toBe("Second");
    expect(view.hasFocus()).toBe(true);
  });

  it("chooses table dimensions visually and preserves two-dimensional keyboard movement", async () => {
    const { view, controller, controlsHost } = await fixture();
    const insertTable = vi.spyOn(controller, "insertTable");
    const insertTrigger = controlsHost.querySelector<HTMLButtonElement>(
      'button[aria-label="Insert block or element"]',
    )!;
    await act(() => insertTrigger.click());
    const tableTrigger = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Table")!;
    expect(tableTrigger).toBeDefined();
    await act(() => {
      tableTrigger.focus();
      tableTrigger.click();
    });

    const picker = await vi.waitFor(() => {
      const element = document.body.querySelector<HTMLElement>("[data-scient-table-size-picker]");
      expect(element).not.toBeNull();
      return element!;
    });
    const choices = picker.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(choices).toHaveLength(64);
    const grid = picker.querySelector<HTMLElement>("[data-scient-table-size-columns]")!;
    expect(grid.dataset.scientTableSizeColumns).toBe("8");
    expect(grid.dataset.scientTableSizeRows).toBe("8");
    expect(grid.dataset.scientTableSizeOrigin).toBe("left");
    expect(grid.dir).toBe("ltr");
    expect(choices[0]?.classList.contains("size-4")).toBe(true);
    expect(choices[0]?.classList.contains("sm:min-h-0")).toBe(true);
    expect(choices[0]?.classList.contains("min-h-8")).toBe(false);
    expect(choices[0]?.classList.contains("sm:min-h-7")).toBe(false);
    expect(choices[0]?.className).not.toContain("transition-");
    expect(grid.style.gridAutoRows).toBe("1rem");
    const viewport = picker.querySelector<HTMLElement>("[data-scient-table-size-viewport]")!;
    expect(viewport.classList.contains("scient-markdown-table-size-viewport")).toBe(true);
    expect(viewport.classList.contains("overflow-x-auto")).toBe(true);
    expect(viewport.classList.contains("overflow-y-hidden")).toBe(true);
    expect(viewport.classList.contains("overscroll-x-contain")).toBe(true);
    expect(viewport.style.inlineSize).toContain("8rem");
    expect(viewport.style.inlineSize).toContain("var(--available-width)");
    expect(viewport.style.blockSize).toBe("");
    expect(viewport.dir).toBe("ltr");
    const popup = picker.closest<HTMLElement>("[data-slot='menu-sub-content']")!;
    expect(popup.classList).toContain("max-w-(--available-width)");
    expect(popup.classList).toContain("[&>div]:max-h-none");
    expect(popup.classList).toContain("[&>div]:overflow-y-visible");
    const sizeLabel = picker.querySelector<HTMLElement>("[data-scient-table-size-label]")!;
    expect(sizeLabel.textContent).toBe("3 × 3");
    const sixByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 6 columns × 3 rows"]',
    )!;
    await act(() => {
      sixByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(sizeLabel.textContent).toBe("6 × 3");
    expect(
      Array.from(choices).filter((choice) => choice.classList.contains("bg-accent")),
    ).toHaveLength(18);
    expect(insertTable).not.toHaveBeenCalled();

    const threeByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 3 columns × 3 rows"]',
    )!;
    await act(() => threeByThree.focus());
    await act(() => {
      threeByThree.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Insert table with 4 columns × 3 rows",
    );
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    const fourByFour = document.activeElement as HTMLElement;
    expect(fourByFour.getAttribute("aria-label")).toBe("Insert table with 4 columns × 4 rows");
    expect(sizeLabel.textContent).toBe("4 × 4");

    await act(() => fourByFour.click());
    await vi.waitFor(() =>
      expect(insertTable).toHaveBeenCalledExactlyOnceWith({ columns: 4, rows: 4 }),
    );
    await vi.waitFor(() => expect(document.body.querySelector("[role='menu']")).toBeNull());
    const table = view.state.doc.content.content.find((node) => node.type.name === "table");
    expect(table?.type.name).toBe("table");
    expect(table?.childCount).toBe(4);
    expect(table?.firstChild?.childCount).toBe(4);
    expect(view.hasFocus()).toBe(true);
  });

  it("expands the visual table picker progressively to 15×15 and resets without mutation", async () => {
    const { controller, controlsHost } = await fixture();
    const before = controller.session.session.draftSource;
    const insertTable = vi.spyOn(controller, "insertTable");
    await act(() =>
      controlsHost
        .querySelector<HTMLButtonElement>('button[aria-label="Insert block or element"]')!
        .click(),
    );
    const tableTrigger = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Table")!;
    await act(() => {
      tableTrigger.focus();
      tableTrigger.click();
    });
    let picker = await vi.waitFor(() => {
      const element = document.body.querySelector<HTMLElement>("[data-scient-table-size-picker]");
      expect(element).not.toBeNull();
      return element!;
    });
    const grid = picker.querySelector<HTMLElement>("[data-scient-table-size-columns]")!;
    const viewport = picker.querySelector<HTMLElement>("[data-scient-table-size-viewport]")!;
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    scrollIntoView.mockClear();
    expect(picker.querySelectorAll('[role="menuitem"]')).toHaveLength(64);
    expect(viewport.style.inlineSize).toContain("8rem");
    expect(grid.style.gridTemplateColumns).toBe("repeat(8, 1rem)");
    const sevenByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 7 columns × 3 rows"]',
    )!;
    await act(() => sevenByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await vi.waitFor(() => {
      expect(grid.dataset.scientTableSizeColumns).toBe("9");
      expect(grid.dataset.scientTableSizeRows).toBe("8");
    });
    expect(viewport.style.inlineSize).toContain("9rem");
    const nineByOne = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 9 columns × 1 row"]',
    )!;
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(nineByOne);
    scrollIntoView.mockRestore();
    const sevenBySeven = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 7 columns × 7 rows"]',
    )!;
    await act(() => sevenBySeven.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await vi.waitFor(() => {
      expect(grid.dataset.scientTableSizeColumns).toBe("9");
      expect(grid.dataset.scientTableSizeRows).toBe("9");
    });

    for (let dimension = 8; dimension <= 14; dimension += 1) {
      const cell = picker.querySelector<HTMLElement>(
        `[aria-label="Insert table with ${dimension} columns × ${dimension} rows"]`,
      );
      expect(cell, `${dimension}×${dimension} should be revealed`).not.toBeNull();
      await act(() => cell!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      const expectedVisibleDimension = Math.min(15, dimension + 2);
      await vi.waitFor(() => {
        expect(grid.dataset.scientTableSizeColumns).toBe(String(expectedVisibleDimension));
        expect(grid.dataset.scientTableSizeRows).toBe(String(expectedVisibleDimension));
      });
    }
    expect(picker.querySelectorAll('[role="menuitem"]')).toHaveLength(225);
    expect(picker.querySelector<HTMLElement>("[data-scient-table-size-viewport]")).toBe(viewport);
    expect(viewport.style.inlineSize).toContain("15rem");
    expect(viewport.style.blockSize).toBe("");
    expect(grid.style.gridTemplateColumns).toBe("repeat(15, 1rem)");
    const fifteenByFifteen = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 15 columns × 15 rows"]',
    )!;
    await act(() => fifteenByFifteen.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(picker.querySelector<HTMLElement>("[data-scient-table-size-label]")?.textContent).toBe(
      "15 × 15",
    );
    expect(picker.querySelectorAll('[role="menuitem"]')).toHaveLength(225);

    await act(() => {
      fifteenByFifteen.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await vi.waitFor(() =>
      expect(document.body.querySelector("[data-scient-table-size-picker]")).toBeNull(),
    );
    expect(insertTable).not.toHaveBeenCalled();
    expect(controller.session.session.draftSource).toBe(before);

    await act(() => {
      tableTrigger.focus();
      tableTrigger.click();
    });
    picker = await vi.waitFor(() => {
      const element = document.body.querySelector<HTMLElement>("[data-scient-table-size-picker]");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(picker.querySelector<HTMLElement>("[data-scient-table-size-label]")?.textContent).toBe(
      "3 × 3",
    );
    expect(picker.querySelectorAll('[role="menuitem"]')).toHaveLength(64);
  });

  it("continues a fast pointer briefly beyond the grid without timer-driven growth", async () => {
    const { controller, controlsHost } = await fixture();
    const before = controller.session.session.draftSource;
    await act(() =>
      controlsHost
        .querySelector<HTMLButtonElement>('button[aria-label="Insert block or element"]')!
        .click(),
    );
    const tableTrigger = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Table")!;
    await act(() => {
      tableTrigger.focus();
      tableTrigger.click();
    });
    const picker = await vi.waitFor(() => {
      const element = document.body.querySelector<HTMLElement>("[data-scient-table-size-picker]");
      expect(element).not.toBeNull();
      return element!;
    });
    const grid = picker.querySelector<HTMLElement>("[data-scient-table-size-columns]")!;
    const viewport = picker.querySelector<HTMLElement>("[data-scient-table-size-viewport]")!;
    const sizeLabel = picker.querySelector<HTMLElement>("[data-scient-table-size-label]")!;
    const firstCell = picker.querySelector<HTMLElement>("[data-scient-table-size-cell]")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      bottom: 249,
      height: 149,
      left: 100,
      right: 249,
      top: 100,
      width: 149,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(firstCell, "getBoundingClientRect").mockReturnValue({
      bottom: 116,
      height: 16,
      left: 100,
      right: 116,
      top: 100,
      width: 16,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });

    const threeByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 3 columns × 3 rows"]',
    )!;
    await act(() => threeByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(() => {
      sizeLabel.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 270 }),
      );
    });
    await vi.waitFor(() => {
      expect(sizeLabel.textContent).toBe("3 × 10");
      expect(grid.dataset.scientTableSizeRows).toBe("11");
    });

    await act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 400 }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 270 }),
      );
    });
    expect(sizeLabel.textContent).toBe("3 × 10");
    expect(grid.dataset.scientTableSizeRows).toBe("11");

    await act(() => threeByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 270, clientY: 120 }),
      );
    });
    await vi.waitFor(() => {
      expect(sizeLabel.textContent).toBe("10 × 3");
      expect(grid.dataset.scientTableSizeColumns).toBe("11");
    });
    expect(controller.session.session.draftSource).toBe(before);
  });

  it("locks the initial collision side and mirrors physical arrow movement when placed left", async () => {
    const { controlsHost } = await fixture();
    await act(() =>
      controlsHost
        .querySelector<HTMLButtonElement>('button[aria-label="Insert block or element"]')!
        .click(),
    );
    const tableTrigger = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Table")!;
    await act(() => {
      tableTrigger.focus();
      tableTrigger.click();
    });
    const picker = await vi.waitFor(() => {
      const element = document.body.querySelector<HTMLElement>("[data-scient-table-size-picker]");
      expect(element).not.toBeNull();
      return element!;
    });
    const grid = picker.querySelector<HTMLElement>("[data-scient-table-size-columns]")!;
    const popup = picker.closest<HTMLElement>("[data-slot='menu-sub-content']")!;
    const positioner = popup.closest<HTMLElement>("[data-slot='menu-positioner']")!;
    await act(() => positioner.setAttribute("data-side", "inline-start"));
    await vi.waitFor(() => {
      expect(grid.dataset.scientTableSizeOrigin).toBe("right");
      expect(grid.dir).toBe("rtl");
      expect(picker.querySelector<HTMLElement>("[data-scient-table-size-viewport]")?.dir).toBe(
        "rtl",
      );
      expect(picker.dataset.scientTableSizeSide).toBe("left");
      expect(picker.dataset.scientTableSizeSideLocked).toBe("true");
    });

    const threeByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 3 columns × 3 rows"]',
    )!;
    await act(() => threeByThree.focus());
    await act(() => {
      threeByThree.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Insert table with 4 columns × 3 rows",
    );
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Insert table with 3 columns × 3 rows",
    );

    await act(() => positioner.setAttribute("data-side", "inline-end"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(grid.dataset.scientTableSizeOrigin).toBe("right");
    expect(grid.dir).toBe("rtl");
    expect(picker.dataset.scientTableSizeSide).toBe("left");
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Insert table with 2 columns × 3 rows",
    );

    const viewport = picker.querySelector<HTMLElement>("[data-scient-table-size-viewport]")!;
    const firstCell = picker.querySelector<HTMLElement>("[data-scient-table-size-cell]")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      bottom: 249,
      height: 149,
      left: 100,
      right: 249,
      top: 100,
      width: 149,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(firstCell, "getBoundingClientRect").mockReturnValue({
      bottom: 116,
      height: 16,
      left: 233,
      right: 249,
      top: 100,
      width: 16,
      x: 233,
      y: 100,
      toJSON: () => ({}),
    });
    await act(() => threeByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 79, clientY: 120 }),
      );
    });
    await vi.waitFor(() => {
      expect(picker.querySelector<HTMLElement>("[data-scient-table-size-label]")?.textContent).toBe(
        "10 × 3",
      );
      expect(grid.dataset.scientTableSizeColumns).toBe("11");
    });
  });
});
