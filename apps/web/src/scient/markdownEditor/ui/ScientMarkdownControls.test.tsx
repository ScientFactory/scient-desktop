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

  async function fixture(source = "A paragraph\n") {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "r0",
      mode: "write",
      ariaLabel: "Document",
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
  it("selects the whole table through the real menu lifecycle and retains that selection for direction", async () => {
    const { view, controller, controlsHost } = await fixture(
      "| A | B |\n| --- | --- |\n| One | Two |\n",
    );
    const trigger = controlsHost.querySelector<HTMLButtonElement>(
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
    const direction = controlsHost.querySelector<HTMLButtonElement>(
      'button[aria-label^="Table direction:"]',
    )!;
    await act(() => direction.click());
    const rtl = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((node) => node.textContent?.trim() === "Right-to-left")!;
    await act(() => rtl.click());
    await vi.waitFor(() => expect(controller.getSnapshot().textDirection).toBe("rtl"));
    expect(view.state.selection).toBeInstanceOf(CellSelection);
    expect(controller.session.session.draftSource).toContain('<div dir="rtl">');
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
});
