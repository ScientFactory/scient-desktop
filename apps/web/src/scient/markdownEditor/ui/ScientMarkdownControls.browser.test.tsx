import { page } from "vitest/browser";
import "../../../index.css";
import { nativeShortcut } from "../../../../test/nativeShortcut";

import { render as _fixtureRender, act } from "../../../../test/render";

import { TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import { describe, expect, it, vi } from "vite-plus/test";
import { ScientMarkdownEditorView } from "../prosemirror/view";
import { scientMarkdownShortcut } from "../shortcuts";
import { ScientMarkdownControls } from "./ScientMarkdownControls";
import { ScientMarkdownFooter } from "./ScientMarkdownFooter";

describe("formatting menu focus", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    for (const cleanup of _fixture.cleanups.splice(0)) await cleanup();
    _clearOwnedDOM(_fixture);
    vi.unstubAllGlobals();
  }

  async function fixture(
    _fixture: _Fixture,
    source = "A paragraph\n",
    showLinkContextMenu?: ConstructorParameters<
      typeof ScientMarkdownEditorView
    >[0]["showLinkContextMenu"],
  ) {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 900);
    _fixture.stack.defer(() => page.viewport(previousViewport.width, previousViewport.height));
    const lifetime = _fixture.stack.use(new AsyncDisposableStack());
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Document",
      ...(showLinkContextMenu ? { showLinkContextMenu } : {}),
    });
    lifetime.defer(() => controller.destroy());
    const editorHost = document.createElement("div");
    const controlsHost = document.createElement("div");
    document.body.append(_ownDOM(_fixture, controlsHost), _ownDOM(_fixture, editorHost));
    const view = controller.mount(editorHost);
    expect(view.hasFocus(), "mounted editable document must accept focus").toBe(true);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    const root = lifetime.use(
      await _fixtureRender(null, { container: controlsHost, router: false }),
    );
    _fixture.cleanups.push(() => lifetime.disposeAsync());
    await act(
      async () =>
        await root.rerender(
          <ScientMarkdownControls
            controller={controller}
            expanded
            onExpandedChange={() => undefined}
          />,
        ),
    );
    return { view, controller, controlsHost };
  }

  // Link lives in Insert; Cmd+K still opens it from the editor.
  async function openLinkFromInsert(controlsHost: HTMLElement) {
    await act(() =>
      controlsHost.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
    );
    const references = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent?.trim() === "References",
    )!;
    await act(() => references.click());
    const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (node) => node.textContent?.trim().startsWith("Link"),
    )!;
    expect(item).toBeDefined();
    await act(() => item.click());
  }

  it("opens the existing link editor with the right-clicked destination prefilled", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const showLinkContextMenu = vi.fn(async () => "edit" as const);
    const { controlsHost } = await fixture(
      _fixture,
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
    // There is no link button in the bar any more.
    expect(controlsHost.querySelector('button[aria-label="Add or edit link"]')).toBeNull();
  });

  // The caret shortcut opens the same editor in "restores the correct focus target after Escape".
  it("opens exactly one link editor from the selection shortcut and restores editor focus", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view } = await fixture(_fixture, "Link these words.\n");
    await act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    });

    const event = new KeyboardEvent(
      "keydown",
      nativeShortcut({
        key: "k",
        code: "KeyK",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );
    await act(() => view.dom.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      const inputs = document.body.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Link destination"]',
      );
      expect(inputs).toHaveLength(1);
      expect(document.activeElement).toBe(inputs[0]);
    });

    const cancel = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("[data-slot='popover-popup'] button"),
    ).find((button) => button.textContent === "Cancel")!;
    await act(() => cancel.click());
    await vi.waitFor(() => {
      expect(document.body.querySelector('input[aria-label="Link destination"]')).toBeNull();
      expect(view.hasFocus()).toBe(true);
    });
  });

  it("uses one stable link popup while switching between detached triggers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, controlsHost } = await fixture(_fixture, "Link these words.\n");
    await act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    });
    // The selection toolbar has its own link button; the bar opens it from Insert.
    const selectionTrigger = await vi.waitFor(() => {
      const buttons = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="Add or edit link"]'),
      );
      expect(buttons).toHaveLength(1);
      return buttons[0]!;
    });

    await act(() => selectionTrigger.click());
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll('[data-slot="popover-popup"]')).toHaveLength(1);
      expect(document.body.querySelectorAll('input[aria-label="Link destination"]')).toHaveLength(
        1,
      );
    });

    await openLinkFromInsert(controlsHost);
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll('[data-slot="popover-popup"]')).toHaveLength(1);
      expect(document.body.querySelectorAll('input[aria-label="Link destination"]')).toHaveLength(
        1,
      );
    });
  });

  it("preserves outside focus when an outside interaction dismisses the link popup", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controlsHost } = await fixture(_fixture);
    const outsideInput = document.createElement("input");
    outsideInput.setAttribute("aria-label", "Outside input");
    document.body.append(_ownDOM(_fixture, outsideInput));

    await openLinkFromInsert(controlsHost);
    await vi.waitFor(() =>
      expect(document.body.querySelector('input[aria-label="Link destination"]')).not.toBeNull(),
    );
    await act(() => {
      outsideInput.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
      outsideInput.focus();
      outsideInput.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      outsideInput.click();
    });
    await vi.waitFor(() =>
      expect(document.body.querySelector('input[aria-label="Link destination"]')).toBeNull(),
    );
    expect(document.activeElement).toBe(outsideInput);
  });

  it("restores the correct focus target after Escape", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, controlsHost } = await fixture(_fixture);

    const shortcutEvent = new KeyboardEvent(
      "keydown",
      nativeShortcut({
        key: "k",
        code: "KeyK",
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );
    await act(() => view.dom.dispatchEvent(shortcutEvent));
    const shortcutInput = await vi.waitFor(() => {
      const input = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Link destination"]',
      );
      expect(input).not.toBeNull();
      return input!;
    });
    await act(() => {
      shortcutInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await vi.waitFor(() => expect(view.hasFocus()).toBe(true));

    await openLinkFromInsert(controlsHost);
    const triggerInput = await vi.waitFor(() => {
      const input = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Link destination"]',
      );
      expect(input).not.toBeNull();
      return input!;
    });
    await act(() => {
      triggerInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    // Opened from Insert, it returns focus to the document.
    await vi.waitFor(() => expect(view.hasFocus()).toBe(true));
  });

  it.each([
    ["Text", "Heading 2", "heading-2", "A paragraph\n"],
    ["List:", "Numbered list", "ordered-list", "A paragraph\n"],
    ["Text", "Paragraph", "paragraph", "> A quote\n"],
  ])(
    "closes %s after %s and leaves the caret ready to type (%s, %s)",
    async (prefix, label, command, source) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const { view, controller, controlsHost } = await fixture(_fixture, source);
      const execute = vi.spyOn(controller, "execute");
      const trigger = controlsHost.querySelector<HTMLButtonElement>(
        `button[aria-label^='${prefix}']`,
      )!;
      await act(() => {
        trigger.focus();
        trigger.click();
      });
      if (prefix === "Text")
        await act(() =>
          [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
            .find((item) => item.textContent === "Paragraph style")!
            .click(),
        );
      const item = Array.from(
        document.body.querySelectorAll<HTMLElement>("[role='menuitemradio']"),
      ).find((node) => node.textContent?.trim().startsWith(label));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, controller, controlsHost } = await fixture(
      _fixture,
      "| A | B |\n| --- | --- |\n| One | Two |\n",
    );
    // A table's commands are in the footer's menu, not in the bar's Document.
    const footerHost = document.createElement("div");
    document.body.append(_ownDOM(_fixture, footerHost));
    const footerRoot = _fixture.stack.use(
      await _fixtureRender(null, { container: footerHost, router: false }),
    );
    _fixture.cleanups.push(async () => {
      await act(async () => await footerRoot.unmount());
      footerHost.remove();
    });
    await act(
      async () => await footerRoot.rerender(<ScientMarkdownFooter controller={controller} />),
    );
    expect(controlsHost.querySelector('[aria-label="Table actions"]')).toBeNull();
    const trigger = footerHost.querySelector<HTMLButtonElement>(
      'button[aria-label="More table actions"]',
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
    // Every selected cell is counted, not only the one the selection ends in.
    await vi.waitFor(() =>
      expect(footerHost.querySelector(".scient-document-footer-count")?.textContent).toBe(
        "4 of 4 words",
      ),
    );
    // Direction lives in the Style menu, under Direction (Table direction in a table).
    const openDirection = async () => {
      await act(() =>
        controlsHost.querySelector<HTMLButtonElement>("button[aria-label='Text']")!.click(),
      );
      const submenu = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((node) => node.textContent?.trim() === "Table direction")!;
      expect(submenu).toBeDefined();
      await act(() => submenu.click());
    };
    await openDirection();
    const directionItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    expect(
      directionItems.find((node) => node.textContent?.trim() === "Auto (detect from table)"),
    ).toBeDefined();
    const rtl = directionItems.find((node) => node.getAttribute("aria-label") === "Right-to-left")!;
    await act(() => rtl.click());
    await vi.waitFor(() => expect(controller.getSnapshot().textDirection).toBe("rtl"));
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    expect(controller.session.session.draftSource).toContain('<div dir="rtl">');

    await vi.waitFor(() => expect(document.body.querySelector("[role='menu']")).toBeNull());
    await openDirection();
    const automatic = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((node) => node.textContent?.trim() === "Auto (detect from table)")!;
    await act(() => automatic.click());
    await vi.waitFor(() => expect(controller.getSnapshot().textDirection).toBeNull());
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    expect(controller.session.session.draftSource).not.toContain('<div dir="rtl">');
  });

  it("keeps normal trigger focus on Escape without running a command", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, controlsHost } = await fixture(_fixture);
    const execute = vi.spyOn(controller, "execute");
    const trigger = controlsHost.querySelector<HTMLButtonElement>("button[aria-label='Text']")!;
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, controlsHost } = await fixture(_fixture, "A paragraph\n");
    const trigger = controlsHost.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!;
    await act(() => trigger.click());
    const references = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent?.trim() === "References",
    )!;
    await act(() => references.click());
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

  it("formats selected text from the shared hover card and restores editor focus", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, controller, controlsHost } = await fixture(_fixture, "Hello world.\n");
    await act(() =>
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6))),
    );
    const openFormatting = async () => {
      await act(() =>
        controlsHost.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!.click(),
      );
      const trigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === "Formatting",
      )!;
      await act(() => {
        trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      return await vi.waitFor(() => {
        const bold = [
          ...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
        ].find((item) => item.textContent?.startsWith("Bold"));
        expect(bold).toBeDefined();
        return bold!;
      });
    };
    let bold = await openFormatting();
    await act(() => bold.click());
    await vi.waitFor(() => expect(controller.session.session.draftSource).toContain("**Hello**"));
    expect(view.hasFocus()).toBe(true);
    bold = await openFormatting();
    expect(bold.getAttribute("aria-checked")).toBe("true");
    const clear = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.startsWith("Clear formatting"),
    )!;
    await act(() => clear.click());
    await vi.waitFor(() => expect(controller.session.session.draftSource).toBe("Hello world.\n"));
    expect(view.hasFocus()).toBe(true);
  });

  it("shows understated LTR shortcut hints without changing action names", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controlsHost } = await fixture(_fixture);
    await act(() =>
      controlsHost.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!.click(),
    );
    await act(() =>
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Formatting")!
        .click(),
    );
    const bold = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
      (item) => item.textContent?.startsWith("Bold"),
    )!;
    expect(bold.getAttribute("aria-keyshortcuts")).toBe(
      scientMarkdownShortcut("bold").ariaKeyShortcuts,
    );
    await act(() =>
      bold.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    // Escape closes the submenu; open the paragraph category in the same Text menu.
    await act(() =>
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Paragraph style")!
        .click(),
    );
    const heading = Array.from(
      document.body.querySelectorAll<HTMLElement>("[role='menuitemradio']"),
    ).find((item) => item.textContent?.startsWith("Heading 2"))!;
    const hint = heading.querySelector<HTMLElement>("[data-slot='menu-shortcut']")!;
    const shortcut = scientMarkdownShortcut("heading2");
    expect(heading.getAttribute("aria-keyshortcuts")).toBe(shortcut.ariaKeyShortcuts);
    expect(hint.textContent).toBe(shortcut.display);
    expect(hint.dir).toBe("ltr");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
  });

  it("closes nested outline actions and focuses the chosen heading", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, controller, controlsHost } = await fixture(
      _fixture,
      "# First\n\nParagraph\n\n## Second\n\nText\n",
    );
    const navigate = vi.spyOn(controller, "navigateToOutline");
    await act(() =>
      controlsHost.querySelector<HTMLButtonElement>("[aria-label='Document']")!.click(),
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { view, controller, controlsHost } = await fixture(_fixture);
    const insertTable = vi.spyOn(controller, "insertTable");
    const insertTrigger = controlsHost.querySelector<HTMLButtonElement>(
      'button[aria-label="Insert"]',
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
    const sizeLabel = picker.querySelector<HTMLElement>("[data-scient-table-size-label]")!;
    expect(sizeLabel.textContent).toBe("3 × 3");
    const sixByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 6 columns × 3 rows"]',
    )!;
    await act(() => {
      sixByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(sizeLabel.textContent).toBe("6 × 3");
    expect(Array.from(choices).filter((choice) => choice.hasAttribute("data-active"))).toHaveLength(
      18,
    );
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, controlsHost } = await fixture(_fixture);
    const before = controller.session.session.draftSource;
    const insertTable = vi.spyOn(controller, "insertTable");
    await act(() =>
      controlsHost.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
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
    const sevenByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 7 columns × 3 rows"]',
    )!;
    await act(() => sevenByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await vi.waitFor(() => {
      expect(grid.dataset.scientTableSizeColumns).toBe("9");
      expect(grid.dataset.scientTableSizeRows).toBe("8");
    });
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controller, controlsHost } = await fixture(_fixture);
    const before = controller.session.session.draftSource;
    await act(() =>
      controlsHost.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
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
    const viewportBounds = viewport.getBoundingClientRect();

    const threeByThree = picker.querySelector<HTMLElement>(
      '[aria-label="Insert table with 3 columns × 3 rows"]',
    )!;
    await act(() => threeByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(() => {
      sizeLabel.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: viewportBounds.left + 20,
          clientY: viewportBounds.top + 170,
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sizeLabel.textContent).toBe("3 × 10");
      expect(grid.dataset.scientTableSizeRows).toBe("11");
    });

    await act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: viewportBounds.left + 20,
          clientY: viewportBounds.top + 300,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: viewportBounds.left + 20,
          clientY: viewportBounds.top + 170,
        }),
      );
    });
    expect(sizeLabel.textContent).toBe("3 × 10");
    expect(grid.dataset.scientTableSizeRows).toBe("11");

    await act(() => threeByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: viewportBounds.left + 170,
          clientY: viewportBounds.top + 20,
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sizeLabel.textContent).toBe("10 × 3");
      expect(grid.dataset.scientTableSizeColumns).toBe("11");
    });
    expect(controller.session.session.draftSource).toBe(before);
  });

  it("locks its native collision origin against stale positioning metadata and mirrors physical arrows", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const { controlsHost } = await fixture(_fixture);
    const insertButton = controlsHost.querySelector<HTMLButtonElement>(
      'button[aria-label="Insert"]',
    )!;
    const triggerBounds = insertButton.getBoundingClientRect();
    controlsHost.style.transform = `translateX(${window.innerWidth - 40 - triggerBounds.right}px)`;
    expect(insertButton.getBoundingClientRect().right).toBeCloseTo(window.innerWidth - 40);
    await act(() =>
      controlsHost.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
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
    await vi.waitFor(() =>
      expect(positioner.getBoundingClientRect().right).toBeLessThanOrEqual(
        tableTrigger.getBoundingClientRect().left + 4,
      ),
    );
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

    // A stale positioning notification must not mirror a grid that is already active.
    await act(() => positioner.setAttribute("data-side", "inline-end"));
    expect(positioner.getBoundingClientRect().right).toBeLessThanOrEqual(
      tableTrigger.getBoundingClientRect().left + 4,
    );
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
    const viewportBounds = viewport.getBoundingClientRect();

    await act(() => threeByThree.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(() => {
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: viewportBounds.right - 170,
          clientY: viewportBounds.top + 20,
        }),
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    cleanups: [] as Array<() => Promise<void>>,
    _ownedDOM: [] as Node[],

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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
