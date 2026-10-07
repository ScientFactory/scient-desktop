// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act as reactAct, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Test the actual ProseMirror transaction/save boundary. MathLive's native
// shadow-DOM keyboard is checked in the running desktop, not simulated here.
vi.mock("./LatexMathField", () => ({
  LatexMathField: ({ value, ref }: { value: string; ref: Ref<unknown> }) => {
    useImperativeHandle(ref, () => ({
      flush: () => true,
      focus: () => {},
      clearSelection: () => {},
    }));
    return <span>{value}</span>;
  },
}));
vi.mock("~/scient/presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { ReaderBarHostContext } from "../writing/readerBarHost";
import { mathSourceCompletions } from "./latexMathCompletion";
import { clearVisualDraft } from "./visualDrafts";
import { clearTypingDraft } from "./visualTyping";
import { scientificStatementsFixture } from "./scientificStatements.fixture";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import { latexFigureSource } from "./figureSource";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "../keyboard/preferences";

// Wait for the editor's paint-delayed conversion and source publication.
const act = async (callback: () => unknown) =>
  reactAct(async () => {
    await callback();
    await new Promise((resolve) => setTimeout(resolve, 320));
  });

const readerHosted = vi.fn();

describe("writing editor source transactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let current: string;
  let confirmed: string | null;
  const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  const writes = vi.fn();
  const flushReferences = vi.fn<() => Promise<boolean>>();
  const tex = (body: string) =>
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    writes.mockReset();
    confirmed = null;
    flushReferences.mockReset().mockResolvedValue(false);
    clearVisualDraft("synthetic-editor-test");
    clearTypingDraft("synthetic-editor-test");
    localStorage.clear();
    reloadKeyboardPreferences();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    // References keeps forms across remounts; discard this fixture's retained form.
    const cancel = [...container.querySelectorAll<HTMLButtonElement>("form button")].find(
      (button) => button.textContent === "Cancel",
    );
    if (cancel) await reactAct(() => cancel.click());
    await act(async () => root.unmount());
    container.remove();
    clearVisualDraft("synthetic-editor-test");
    clearTypingDraft("synthetic-editor-test");
    if (originalGetAnimations)
      Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  // Find and replace is in the writing row's Document menu.
  async function openFindAndReplace(_headerSlot: HTMLElement) {
    await act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[role="toolbar"][aria-label="Writing tools"] button[aria-label="Document"]',
        )!
        .click(),
    );
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.trim() === "Find and replace",
    )!;
    expect(item).toBeDefined();
    await act(() => item.click());
  }
  function editor(): Editor {
    return (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  }
  async function openCellFormatting() {
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!.click(),
    );
    const trigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Formatting",
    )!;
    await act(() => trigger.click());
    return vi.waitFor(() => {
      const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
      expect(items).toHaveLength(3);
      return items;
    });
  }
  async function insertMenuItem(name: string) {
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
    );
    const find = () =>
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent?.trim() === name,
      );
    // Open each category to reach its nested actions.
    for (const submenu of ["References", "Theorems & proofs", "Document blocks"]) {
      if (find()) break;
      const trigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => element.textContent?.trim() === submenu,
      );
      if (trigger) await act(() => trigger.click());
    }
    const item = find();
    expect(item).toBeDefined();
    await act(() => item!.click());
    await act(() => {});
  }
  async function setField(
    field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
  ) {
    expect(field).not.toBeNull();
    await act(() => {
      field.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(
        new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
      );
    });
    await act(() => field.blur());
  }
  async function selectOption(label: string, optionLabel: string) {
    const trigger = document.body.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
    expect(trigger).not.toBeNull();
    const details = trigger.closest("details");
    if (details && !details.open) await act(() => details.querySelector("summary")!.click());
    await act(() => trigger.click());
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === optionLabel,
    );
    expect(option, optionLabel).toBeDefined();
    await act(() => option!.click());
  }
  async function selectKind(kind: string) {
    let position = -1;
    editor().state.doc.descendants((node, offset) => {
      if (node.attrs.kind === kind || node.type.name === kind) position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    await act(() => editor().commands.setNodeSelection(position));
    return position;
  }
  /** `headerSlot` hosts the reader controls the way the LaTeX surface's header does. */
  async function mount(body = "Hello", preamble = "", headerSlot: HTMLElement | null = null) {
    current = tex(body).replace("\\begin{document}", preamble + "\\begin{document}");
    function Harness() {
      const [source, setSource] = useState(current);
      const editorElement = (
        <LatexVisualEditor
          draftKey="synthetic-editor-test"
          fileRevision="r1"
          source={source}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          flushReferenceEdits={flushReferences}
          confirmedReferenceSource={() => confirmed}
          onEdit={(expected, next) => {
            if (current !== expected) return false;
            writes(expected, next);
            current = next;
            setSource(next);
            return true;
          }}
        />
      );
      return headerSlot ? (
        <ReaderBarHostContext value={{ slot: headerSlot, onHosted: readerHosted }}>
          {editorElement}
        </ReaderBarHostContext>
      ) : (
        editorElement
      );
    }
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("shows a heading label directly in the footer and adds/removes it through source and undo", async () => {
    await mount("\\section{Introduction}\n\nSee Section~\\ref{sec:intro}.");
    await act(() => editor().commands.setTextSelection(3));
    const field = () =>
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Heading reference label"]',
      )!;
    expect(field()).not.toBeNull();
    expect(container.querySelector(".scient-latex-context-tools[data-inline]")).not.toBeNull();
    expect(container.querySelector(".scient-latex-context-inspector")?.hasAttribute("inert")).toBe(
      false,
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Heading options"]')?.hidden,
    ).toBe(true);
    expect(
      container.querySelector(".scient-latex-heading-bar [data-latex-number-toggle]"),
    ).toBeNull();
    await setField(field(), "sec:intro");
    expect(current).toContain("\\section{Introduction}\\label{sec:intro}");
    expect(
      latexEquationReferencesKey.getState(editor().state)?.labels.get("sec:intro")?.number,
    ).toBe("1");
    await setField(field(), "");
    expect(current).not.toContain("\\label{sec:intro}");
    await act(() => editor().commands.undo());
    expect(current).toContain("\\label{sec:intro}");
    expect(field().value).toBe("sec:intro");
  });

  it("renames a heading label and its recognized references on Enter while preserving heading selection", async () => {
    await mount(
      "\\section{Introduction}\\label{sec:old}\n\nSee \\ref{sec:old}, \\nameref{sec:old} and \\hyperref[sec:old]{Introduction}.\n\n% \\ref{sec:old}",
      "\\usepackage{hyperref}\n",
    );
    await act(() => editor().commands.setTextSelection(3));
    const field = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Heading reference label"]',
    )!;
    await act(() => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "sec:new",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(current).toContain("\\label{sec:old}");
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(current).toContain("\\label{sec:new}");
    expect(current).toContain("\\ref{sec:new}");
    expect(current).toContain("\\nameref{sec:new}");
    expect(current).toContain("\\hyperref[sec:new]{Introduction}");
    expect(current).toContain("% \\ref{sec:old}");
    expect(editor().state.selection.from).toBe(3);
    expect(editor().state.selection.empty).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("sec:new");
    await act(() => editor().commands.undo());
    expect(current).toContain("\\label{sec:old}");
    expect(current).toContain("\\hyperref[sec:old]{Introduction}");
  });

  it("rejects invalid and duplicate heading labels without publishing the field draft", async () => {
    await mount(
      "\\section{Introduction}\\label{sec:intro}\n\n\\section{Results}\\label{sec:results}",
    );
    await act(() => editor().commands.setTextSelection(3));
    const field = () =>
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Heading reference label"]',
      )!;
    await setField(field(), "bad label");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().value).toBe("bad label");
    expect(current).toContain("\\label{sec:intro}");
    await setField(field(), "sec:results");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(current.match(/\\label\{sec:results\}/gu)).toHaveLength(1);
    await setField(field(), "sec:summary");
    expect(field().getAttribute("aria-invalid")).toBe("false");
    expect(current).toContain("\\label{sec:summary}");
  });

  it("retains a manual reference until its document save is confirmed", async () => {
    await mount(
      "\\begin{thebibliography}{99}\n\\bibitem{known} Original entry\n\\end{thebibliography}",
    );
    await selectKind("bibliography");
    const manage = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Manage references",
    )!;
    expect(manage).toBeDefined();
    await act(() => manage.click());
    const field = () =>
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reference entry text"]');
    expect(field()).not.toBeNull();
    await setField(field()!, "Updated entry");
    let confirm!: (value: boolean) => void;
    flushReferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const save = () =>
      act(() =>
        container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    await save();
    expect(current).toContain("Updated entry");
    expect(flushReferences).toHaveBeenCalledOnce();
    expect(field()?.value).toBe("Updated entry");
    expect(container.textContent).not.toContain("Reference saved.");
    await act(() => confirm(false));
    expect(field()?.value).toBe("Updated entry");
    expect(container.textContent).toContain("Your entry draft is retained");
    expect(container.textContent).not.toContain("Reference saved.");
    flushReferences.mockResolvedValueOnce(true);
    confirmed = current;
    await save();
    expect(field()).toBeNull();
    expect(container.textContent).toContain("Reference saved.");
  });

  it("keeps a manual reference when a clean save published a superseding entry", async () => {
    await mount(
      "\\begin{thebibliography}{99}\n\\bibitem{known} Original entry\n\\end{thebibliography}",
    );
    await selectKind("bibliography");
    await act(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Manage references")!
        .click(),
    );
    const field = () =>
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reference entry text"]');
    await setField(field()!, "Entry A");
    flushReferences.mockImplementationOnce(async () => {
      confirmed = current.replace("Entry A", "Entry B");
      return true;
    });
    await act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(flushReferences).toHaveBeenCalledOnce();
    expect(confirmed).toContain("Entry B");
    expect(field()?.value).toBe("Entry A");
    expect(container.textContent).not.toContain("Reference saved.");
    expect(container.textContent).toContain("The file changed before the reference was saved");
  });

  it("keeps writing tools in one permanent row and reader controls in the footer", async () => {
    await mount();
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    expect(
      [...toolbar.querySelectorAll("[data-dock-group]")].map((group) =>
        group.getAttribute("data-dock-group"),
      ),
    ).toEqual(["history", "text", "insert", "math", "lists", "document"]);
    expect(toolbar.querySelector('button[aria-label="Text"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Hide formatting tools"]')).toBeNull();
    expect(toolbar.querySelector('input[aria-label="Page number"]')).toBeNull();
    expect(
      container.querySelector('.scient-latex-reader-footer input[aria-label="Page number"]'),
    ).not.toBeNull();
    expect(container.querySelector(".scient-latex-document-tools")).toBeNull();
    const context = container.querySelector(".scient-latex-context-tools")!;
    // The percentage fits the width; there is no separate Fit width button.
    expect(
      context.previousElementSibling?.previousElementSibling?.getAttribute("aria-label"),
    ).toMatch(/^Zoom in/);
    // Search is a field right after the zoom; the object options follow it.
    expect(context.previousElementSibling?.className).toBe("scient-reader-search");
    expect(context.querySelector(".scient-latex-context-tools-slot")).not.toBeNull();
    expect(container.querySelector('[aria-label="Selected object properties"]')).toBeNull();
  });

  it("draws the reader controls in the host's header and leaves a compact footer", async () => {
    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount("Hello brave new world", "", headerSlot);
      // Page, zoom and search are in the header slot, once.
      expect(headerSlot.querySelector('input[aria-label="Page number"]')).not.toBeNull();
      expect(headerSlot.querySelector(".scient-pdf-toolbar-hosted")).not.toBeNull();
      expect(container.querySelector('input[aria-label="Page number"]')).toBeNull();
      expect(document.body.querySelectorAll('input[aria-label="Page number"]')).toHaveLength(1);
      expect(readerHosted).toHaveBeenLastCalledWith(true);
      // The footer holds the object options slot and what follows the caret.
      const footer = container.querySelector(".scient-document-footer")!;
      expect(footer).not.toBeNull();
      expect(footer.classList.contains("scient-latex-reader-footer")).toBe(true);
      expect(footer.querySelector(".scient-latex-context-tools-slot")).not.toBeNull();
      expect(footer.querySelector(".scient-document-footer-position")?.textContent).toBe("Text");
      expect(footer.querySelector(".scient-document-footer-count")?.textContent).toBe("4 words");
      await act(() => {
        editor().commands.setTextSelection({ from: 1, to: 12 });
      });
      expect(footer.querySelector(".scient-document-footer-count")?.textContent).toBe(
        "2 of 4 words",
      );
      // Search opens under the writing row, next to the controls that opened it.
      await openFindAndReplace(headerSlot);
      // The same find and replace bar as the Markdown editor.
      const search = container.querySelector(".scient-markdown-find-bar")!;
      expect(search).not.toBeNull();
      const toolbar = container.querySelector(".scient-latex-writing-toolbar")!;
      expect(
        toolbar.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        search.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        search.compareDocumentPosition(container.querySelector(".scient-latex-visual-body")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      headerSlot.remove();
    }
  });

  it("finds and replaces text, writing the replacement to the source", async () => {
    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount("One cat, two cats, three Cats.", "", headerSlot);
      await openFindAndReplace(headerSlot);
      const bar = container.querySelector(".scient-markdown-find-bar")!;
      await setField(bar.querySelector<HTMLInputElement>("input[aria-label='Find text']")!, "cat");
      expect(bar.textContent).toContain("1 of 3");
      await act(() => bar.querySelector<HTMLButtonElement>("[aria-label='Show replace']")!.click());
      const replace = bar.querySelector<HTMLInputElement>("input[aria-label='Replacement text']")!;
      await setField(replace, "dog_100%");
      await act(() =>
        bar.querySelector<HTMLButtonElement>("[aria-label='Replace current match']")!.click(),
      );
      // Special characters are written the way typing them would write them.
      expect(current).toContain("One dog\\_100\\%, two cats, three Cats.");
      await act(() =>
        bar.querySelector<HTMLButtonElement>("[aria-label='Replace all matches']")!.click(),
      );
      expect(current).toContain("One dog\\_100\\%, two dog\\_100\\%s, three dog\\_100\\%s.");
      expect(current).toContain("\\begin{document}");
    } finally {
      headerSlot.remove();
    }
  });

  it("replaces across paragraphs, a heading and a list, one block at a time", async () => {
    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(
        [
          "\\section{A cat}",
          "First cat here, and a second cat.",
          "",
          "No match in this one.",
          "",
          "\\begin{itemize}",
          "\\item a cat in a list",
          "\\end{itemize}",
          "",
          "Last cat.",
        ].join("\n"),
        "",
        headerSlot,
      );
      await openFindAndReplace(headerSlot);
      const bar = container.querySelector(".scient-markdown-find-bar")!;
      await setField(bar.querySelector<HTMLInputElement>("input[aria-label='Find text']")!, "cat");
      expect(bar.textContent).toContain("1 of 5");
      await act(() => bar.querySelector<HTMLButtonElement>("[aria-label='Show replace']")!.click());
      await setField(
        bar.querySelector<HTMLInputElement>("input[aria-label='Replacement text']")!,
        "dog",
      );
      await act(() =>
        bar.querySelector<HTMLButtonElement>("[aria-label='Replace all matches']")!.click(),
      );
      // Each block is written to the source before the next is edited.
      await vi.waitFor(async () => {
        await act(() => {});
        expect(current).not.toContain("cat");
      });
      expect(current).toContain("\\section{A dog}");
      expect(current).toContain("First dog here, and a second dog.");
      expect(current).toContain("No match in this one.");
      expect(current).toMatch(/\\item a dog in a list/u);
      expect(current).toContain("Last dog.");
      expect(container.textContent).not.toContain("could not");
      // One block per undo step, so each step is an edit the source can hold.
      await act(() => editor().commands.undo());
      expect(current.match(/cat/gu)?.length).toBe(1);
      expect(container.textContent).not.toContain("could not");
    } finally {
      headerSlot.remove();
    }
  });

  it("stops replacing when the document changes under it, and never touches the new text", async () => {
    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(["cat cat.", "", "Last cat."].join("\n"), "", headerSlot);
      await openFindAndReplace(headerSlot);
      const bar = container.querySelector(".scient-markdown-find-bar")!;
      await setField(bar.querySelector<HTMLInputElement>("input[aria-label='Find text']")!, "cat");
      expect(bar.textContent).toContain("1 of 3");
      await act(() => bar.querySelector<HTMLButtonElement>("[aria-label='Show replace']")!.click());
      await setField(
        bar.querySelector<HTMLInputElement>("input[aria-label='Replacement text']")!,
        "dog",
      );
      await act(() => {
        bar.querySelector<HTMLButtonElement>("[aria-label='Replace all matches']")!.click();
        // The last paragraph is done; the others wait for a paint. The writer
        // types the searched word at the very start before that paint.
        editor().commands.insertContentAt(1, "cat ");
      });
      await act(() => {});
      expect(current).toContain("Last dog.");
      // The positions found earlier still hold the word "cat", but they are no
      // longer the words that were matched: nothing in this paragraph changes.
      expect(current).toContain("cat cat cat.");
      expect(current).not.toContain("dog dog");
      expect(container.textContent).not.toContain("could not");
    } finally {
      headerSlot.remove();
    }
  });

  it("groups insertions and runs relocated text blocks from Text", async () => {
    await mount();
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
    );
    const rows = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      "Figure",
      "Table",
      "Code block",
      "Literal text",
      "References",
      "Theorems & proofs",
      "Document blocks",
      "Page break",
      "Long quotation",
      "Left-aligned text",
      "Right-aligned text",
      "Part",
    ]);
    await act(() => rows.find((row) => row.textContent?.trim() === "References")!.click());
    expect(
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .filter((row) => row.closest('[data-slot="menu-sub-content"]'))
        .map((row) => row.textContent?.trim()),
    ).toEqual(["Citation", "Cross-reference", "Link", "Footnote"]);
    await act(() =>
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await act(() =>
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    // Dismiss the Insert menu before exercising the Text categories.
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!.click(),
    );
    const alignment = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => row.textContent?.trim() === "Alignment",
    )!;
    await act(() => alignment.click());
    const right = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => row.textContent?.trim() === "Right-aligned text",
    )!;
    await act(() => right.click());
    expect(current).toContain("\\begin{flushright}");
    expect(editor().isFocused).toBe(true);
  });

  it("starts a titled document with formatting ready on body text", async () => {
    await mount("\\maketitle\nHello world.", "\\title{Title}\n");
    expect(editor().state.selection.$from.parent.type.name).toBe("paragraph");
    const text = container.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!;
    await act(() => text.click());
    const formatting = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Formatting",
    )!;
    await act(() => formatting.click());
    const bold = await vi.waitFor(() => {
      const item = document.body.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
      expect(item).not.toBeNull();
      expect(item!.getAttribute("aria-disabled")).not.toBe("true");
      return item!;
    });
    await act(() => bold.click());
    expect(editor().isActive("bold")).toBe(true);
  });

  it("offers the Markdown bar's inline formatting in the same order, without strikethrough", async () => {
    await mount();
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    expect(toolbar.querySelector('button[aria-label="Bold"]')).toBeNull();
    const openFormatting = async () => {
      await act(() =>
        toolbar.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!.click(),
      );
      const trigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === "Formatting",
      )!;
      await act(() => {
        trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      return await vi.waitFor(() => {
        const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
        expect(
          items.map((item) =>
            item.textContent
              ?.trim()
              .split(/Ctrl|⌘|⌥/)[0]
              ?.trim(),
          ),
        ).toEqual(["Bold", "Italic", "Inline code"]);
        return items;
      });
    };
    await act(() => editor().commands.setTextSelection({ from: 1, to: 6 }));
    let items = await openFormatting();
    await act(() => items[2]!.click());
    expect(current).toContain("\\texttt{Hello}");
    expect(editor().isFocused).toBe(true);
    items = await openFormatting();
    expect(items[2]!.getAttribute("aria-checked")).toBe("true");
    await act(() => items[2]!.click());
    expect(current).not.toContain("\\texttt");
    // Link lives in Insert, not in the bar.
    await act(() =>
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
    );
    const references = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "References",
    )!;
    await act(() => references.click());
    const link = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim().startsWith("Link"),
    )!;
    expect(link).toBeDefined();
    await act(() => link.click());
    await act(() => {});
    const popup = document.body.querySelector('[data-slot="popover-popup"]')!;
    expect(popup).not.toBeNull();
    expect(popup.classList.contains("w-64")).toBe(true);
    expect(document.body.querySelector('[data-slot="dialog-backdrop"]')).toBeNull();
    expect(document.body.querySelector('[data-slot="dialog-popup"]')).toBeNull();
    await setField(
      popup.querySelector<HTMLInputElement>('input[aria-label="Link destination"]')!,
      "https://example.com",
    );
    await act(() =>
      popup
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await vi.waitFor(() => expect(current).toContain("\\href{https://example.com}{Hello}"));
    expect(editor().isFocused).toBe(true);
  });

  it("puts plain-text shortcut help under Document without extra More actions", async () => {
    await mount();
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    expect(toolbar.querySelector('button[aria-label="More actions"]')).toBeNull();
    await act(() =>
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
    );
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const shortcuts = items.find((item) => item.textContent?.trim() === "Keyboard shortcuts");
    expect(shortcuts).toBeDefined();
    expect(shortcuts!.querySelector("svg")).toBeNull();
    expect(
      items.some((item) =>
        /Open LaTeX source|Next source-only block/u.test(item.textContent ?? ""),
      ),
    ).toBe(false);
    await act(() => shortcuts!.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "Writing shortcuts",
    );
  });
  it("applies settings from a one-card submenu that shows the current values", async () => {
    await mount("Hello");
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    await act(() =>
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
    );
    const settings = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Document settings",
    )!;
    await act(() => {
      settings.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      settings.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await vi.waitFor(() => expect(settings.getAttribute("aria-expanded")).toBe("true"));
    const popup = document.body.querySelector(
      '[data-slot="menu-sub-content"][aria-label="Document settings"]',
    )!;
    expect(popup).not.toBeNull();
    expect(document.body.querySelector('[data-slot="dialog-backdrop"]')).toBeNull();
    expect(document.body.querySelector('[data-slot="dialog-popup"]')).toBeNull();
    const button = (label: string) =>
      [...popup.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === label,
      )!;
    // No tabs: every setting is on one card, showing what the document uses now.
    expect(button("Page layout")).toBeUndefined();
    expect(popup.textContent).toContain("Article");
    expect(popup.textContent).toContain("10 pt");
    expect(popup.textContent).toContain("Letter");
    expect(popup.textContent).toContain("LaTeX default");
    expect(button("Apply").disabled).toBe(true);
    // Margins: the four boxes appear under Custom.
    expect(popup.querySelector('input[aria-label="Top margin"]')).toBeNull();
    await act(() => popup.querySelector<HTMLButtonElement>('[aria-label="Margins"]')!.click());
    const custom = await vi.waitFor(() => {
      const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent?.trim() === "Custom",
      );
      expect(option).toBeDefined();
      return option!;
    });
    await act(() => custom.click());
    const top = await vi.waitFor(() => {
      const input = popup.querySelector<HTMLInputElement>('input[aria-label="Top margin"]');
      expect(input).not.toBeNull();
      return input!;
    });
    await setField(top, "2cm");
    await act(() => button("Apply").click());
    await vi.waitFor(() => expect(current).toContain("top=2cm"));
    expect(current).toContain("Hello");
    expect(current).toContain("\\documentclass{article}");
    const applied = current;
    await act(() => {
      editor().commands.undo();
    });
    await vi.waitFor(() => expect(current).not.toContain("top=2cm"));
    await act(() => {
      editor().commands.redo();
    });
    await vi.waitFor(() => expect(current).toBe(applied));
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[data-slot="menu-sub-content"][aria-label="Document settings"]',
        ),
      ).toBeNull(),
    );
  });

  it("moves lower-priority writing groups into More on narrow panes", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute("role") === "toolbar" ? 230 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-dock-reserved") ? 36 : 70;
    });
    await mount();
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    // Bold and italic leave last, as in the Markdown bar.
    expect(toolbar.querySelector('[data-dock-group="text"]')).not.toBeNull();
    expect(toolbar.querySelector('[data-dock-group="history"]')).toBeNull();
    await act(() =>
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.click(),
    );
    const menuItems = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
    ];
    for (const label of [
      "Undo",
      "Redo",
      "Bullet list",
      "Theorems & proofs",
      "Document settings",
      "Keyboard shortcuts",
    ])
      // A row may end with its shortcut.
      expect(
        menuItems.some((item) => item.textContent?.trim().startsWith(label)),
        label,
      ).toBe(true);
  });

  it("shows the list menu in the Markdown menu's shape, with its shortcuts", async () => {
    await mount("A paragraph.");
    const toolbar = container.querySelector('[role="toolbar"][aria-label="Writing tools"]')!;
    await act(() =>
      toolbar.querySelector<HTMLButtonElement>('button[aria-label="List: None"]')!.click(),
    );
    const rows = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(rows.map((row) => row.textContent?.trim().replace(/\s+/gu, " "))).toEqual([
      expect.stringMatching(/^Bullet list.+/u),
      expect.stringMatching(/^Numbered list.+/u),
      "No list",
    ]);
    // Outside a list, "No list" is the current state, as in Markdown.
    expect(rows[2]!.getAttribute("aria-checked")).toBe("true");
    expect(rows[0]!.getAttribute("aria-keyshortcuts")).toBeTruthy();
    // The current kind is shown by the row itself, not by a separate mark.
    expect(document.body.querySelector('[data-slot="menu-radio-item-indicator"]')).toBeNull();
    await act(() => rows[0]!.click());
    expect(current).toContain("\\begin{itemize}");
  });

  it.each([false, true])(
    "opens and applies an existing theorem's exact source after insertion=%s",
    async (insertBefore) => {
      const raw =
        "\\begin{theorem}[Energy estimate and decay]\nAssume \\eqref{eq:bc} and $u_0 \\in L^2(\\Omega)$.\n\\[\\|u(t)\\|^2 \\le \\|u_0\\|^2\\]\n\\custom{Keep}\n\\end{theorem}";
      await mount(raw);
      if (insertBefore)
        await act(() =>
          editor().commands.insertContentAt(0, {
            type: "paragraph",
            content: [{ type: "text", text: "Before" }],
          }),
        );
      const block = container.querySelector<HTMLElement>(".scient-latex-visual-raw pre")!;
      expect(block.textContent).toBe(raw);
      await act(() => block.click());
      const source = container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Block LaTeX source']",
      );
      expect(source).not.toBeNull();
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          source,
          raw.replace("Assume", "Suppose"),
        );
        source!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const apply = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Apply LaTeX",
      );
      expect(apply).toBeDefined();
      await act(() => apply!.click());
      expect(current).toContain(raw.replace("Assume", "Suppose"));
      if (insertBefore) expect(current).toContain("Before");
    },
  );

  it("edits prose and nested equations in the supplied theorem/proof/remark document", async () => {
    const marker = "\\begin{document}";
    const body = scientificStatementsFixture
      .slice(
        scientificStatementsFixture.indexOf(marker) + marker.length,
        scientificStatementsFixture.lastIndexOf("\\end{document}"),
      )
      .trim();
    await mount(body);
    expect(container.querySelectorAll(".scient-latex-scientific-structure")).toHaveLength(4);
    expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    const before = current;
    let prose = -1;
    editor().state.doc.descendants((node, position) => {
      if (node.isText && node.text?.startsWith("Assume")) prose = position;
    });
    expect(prose).toBeGreaterThan(0);
    await act(() => {
      editor().commands.setTextSelection(prose);
      editor().commands.insertContent("We ");
    });
    expect(current).toBe(before.replace("Assume", "We Assume"));
    let math = -1;
    editor().state.doc.descendants((node, position) => {
      if (node.type.name === "latexDisplayMath" && String(node.attrs.tex).includes("\\sup"))
        math = position;
    });
    await act(() => {
      editor().commands.setNodeSelection(math);
      editor().commands.updateAttributes("latexDisplayMath", {
        tex: String(editor().state.doc.nodeAt(math)!.attrs.tex).replace("\\sup", "\\max"),
      });
    });
    expect(current).toBe(before.replace("Assume", "We Assume").replace("\\sup", "\\max"));
    await act(() => editor().commands.undo());
    expect(current).toBe(before.replace("Assume", "We Assume"));
  });

  it("splits a paragraph inside a theorem while keeping its environment", async () => {
    await mount("\\begin{theorem}[Result]\nFirst second\n\\end{theorem}");
    await act(() => {
      editor().commands.setTextSelection(7);
      editor().commands.splitBlock();
    });
    expect(editor().state.doc.firstChild!.type.name).toBe("latexScientific");
    expect(editor().state.doc.firstChild!.childCount).toBe(2);
    expect(current).toContain("\\begin{theorem}[Result]\nFirst\n\n second\n\\end{theorem}");
  });

  it("does not write on mount; spaces, Enter and undo save real source", async () => {
    await mount();
    expect(writes).not.toHaveBeenCalled();
    await act(async () => {
      editor().commands.setTextSelection(6);
      editor().commands.insertContent(" world");
    });
    expect(current).toBe(tex("Hello world"));
    await act(async () => {
      editor().commands.splitBlock();
    });
    expect(current).toContain("Hello world\n\n\\par");
    await act(async () => {
      editor().commands.insertContent("Next");
    });
    expect(current).toContain("Hello world\n\nNext");
    await act(async () => {
      editor().commands.undo();
    });
    expect(current).not.toContain("Next");
    await act(async () => {
      editor().commands.redo();
    });
    expect(current).toContain("Next");
  });

  it("applies toolbar formatting and inserts math without a build", async () => {
    await mount();
    await act(async () => {
      editor().commands.setTextSelection({ from: 1, to: 6 });
      editor().commands.toggleBold();
    });
    expect(current).toContain("\\textbf{Hello}");
    await act(async () => {
      editor().commands.setTextSelection(6);
      editor().commands.insertContent({ type: "latexInlineMath", attrs: { tex: "x^2" } });
    });
    expect(current).toContain("\\(x^2\\)");
  });

  it("inserts a source-backed explicit page break", async () => {
    await mount("First page");
    await insertMenuItem("Page break");
    expect(current).toContain("\\newpage");
    expect(
      editor()
        .getJSON()
        .content?.some((node) => node.attrs?.kind === "pagebreak"),
    ).toBe(true);
  });

  it("zooms the fixed paper without changing LaTeX", async () => {
    await mount("Stable page");
    await act(() => container.querySelector<HTMLButtonElement>(".scient-pdf-zoom-label")!.click());
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Zoom out"]')!.click(),
    );
    expect(
      container
        .querySelector<HTMLElement>(".scient-latex-page-stage")
        ?.style.getPropertyValue("transform"),
    ).toBe("scale(0.95)");
    expect(writes).not.toHaveBeenCalled();
  });

  it("shows editable front matter and marks only starred headings as unnumbered", async () => {
    current = `\\documentclass{article}
\\title{Research Guide}
\\author{Nati}
\\date{2026}
\\begin{document}
\\maketitle

\\section{Introduction}

\\subsection*{Scope}
\\end{document}
`;
    function Harness() {
      const [source, setSource] = useState(current);
      return (
        <LatexVisualEditor
          draftKey="synthetic-front-matter-test"
          fileRevision="r1"
          source={source}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(expected, next) => {
            if (current !== expected) return false;
            current = next;
            setSource(next);
            return true;
          }}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const title = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Document title']",
    )!;
    expect(title.value).toBe("Research Guide");
    expect(container.querySelector("h1")?.hasAttribute("data-latex-unnumbered")).toBe(false);
    expect(container.querySelector("h2")?.hasAttribute("data-latex-unnumbered")).toBe(true);
    await setField(title, "A Better Guide");
    expect(current).toContain("\\title{A Better Guide}");
    await act(async () => title.focus());
    const removeAuthor = container.querySelector<HTMLInputElement>(
      ".scient-latex-title-author-toggle input",
    )!;
    await act(async () => removeAuthor.click());
    expect(current).toContain("\\author{}");
    expect(container.querySelector("textarea[aria-label='Document author']")).toBeNull();
    await selectOption("Title date", "Date: Hidden");
    expect(current).toContain("\\date{}");
    expect(container.querySelector("textarea[aria-label='Document date']")).toBeNull();
  });

  it("opens formula source without replacing the rendered equation", async () => {
    await mount("Inline $x^2$ here");
    await selectKind("latexInlineMath");
    const equation = container.querySelector(".scient-latex-visual-inline-math") as HTMLElement;
    await act(async () => equation.click());
    const sourceButton = document.body.querySelector<HTMLButtonElement>(
      ".scient-latex-math-bar-source",
    )!;
    await act(async () => sourceButton.click());
    const source = container.querySelector(
      "textarea[aria-label='LaTeX formula code']",
    ) as HTMLTextAreaElement;
    expect(source.value).toBe("x^2");
    expect(container.textContent).toContain("x^2");
    expect(document.body.querySelector("[aria-label='Math tools']")).not.toBeNull();
    expect(document.body.querySelector("[aria-label='Edit formula as LaTeX']")).not.toBeNull();
  });

  it("changes a display wrapper from the compact source popover", async () => {
    await mount("\\[\nx^2\n\\]");
    await selectKind("latexDisplayMath");
    const equation = container.querySelector(".scient-latex-visual-display-math") as HTMLElement;
    await act(async () => equation.click());
    await act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Math tools"] [data-latex-number-toggle]')!
        .click(),
    );
    expect(current).toContain("\\begin{equation}\nx^2\n\\end{equation}");
  });

  it("changes centered math to a standalone inline formula", async () => {
    await mount("\\[\nx^2\n\\]");
    await selectKind("latexDisplayMath");
    const equation = container.querySelector(".scient-latex-visual-display-math") as HTMLElement;
    await act(async () => equation.click());
    const footerMath = container.querySelector<HTMLButtonElement>(
      '.scient-latex-math-bar button[aria-label="Math"]',
    )!;
    await act(() => footerMath.click());
    const inline = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.trim() === "Inline math",
    )!;
    await act(() => inline.click());
    expect(current).toBe(tex("\\(x^2\\)"));
  });

  it("offers bounded command and environment completions", () => {
    expect(mathSourceCompletions("\\[\n\\fra", 7)[0]).toMatchObject({
      label: "\\frac",
      replacement: "\\frac{}{}",
    });
    expect(mathSourceCompletions("\\[\n\\begin{ali", 13)[0]).toMatchObject({
      label: "\\begin{align}",
      replacement: "\\begin{align}\n\n\\end{align}",
    });
  });

  it("converts a completely typed supported math environment", async () => {
    await mount("Replace me");
    const matrix = "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}";
    await act(async () => {
      editor().commands.selectAll();
      editor().commands.insertContent(matrix);
    });
    expect(editor().getJSON().content?.[0]?.type).toBe("latexDisplayMath");
    expect(current).toContain(`\\[\n${matrix}\n\\]`);
  });

  it("edits prose and inserts both kinds of math inside an abstract", async () => {
    await mount("\\begin{abstract}\nAbstract text.\n\\end{abstract}");
    const host = container.querySelector('[aria-label="Abstract"]');
    expect(host?.closest('[contenteditable="false"]')).toBeNull();
    let position = 0;
    editor().state.doc.descendants((node, at) => {
      if (node.type.name === "paragraph") position = at + 1;
    });
    await act(() =>
      editor()
        .chain()
        .setTextSelection(position)
        .insertContent({ type: "latexInlineMath", attrs: { tex: "x", wrapper: "paren" } })
        .run(),
    );
    await act(() =>
      editor().commands.insertContentAt(editor().state.doc.firstChild!.nodeSize - 1, {
        type: "latexDisplayMath",
        attrs: { tex: "a=b", wrapper: "bracket" },
      }),
    );
    expect(current).toContain("\\(x\\)Abstract text.");
    expect(current).toMatch(/\\\[\s*a=b\s*\\\]/u);
    expect(current.match(/\\begin\{abstract\}/g)).toHaveLength(1);
    expect(projectLatexVisualDocument(current).rawBlocks).toBe(0);
  });

  it.each([
    ["bold", 0, "textbf"],
    ["italic", 1, "textit"],
    ["code", 2, "texttt"],
  ] as const)(
    "follows the cell caret for %s availability, checked state and menu actions",
    async (mark, index, command) => {
      await mount(`\\begin{tabular}{ll}\n\\${command}{Marked} Plain & Other\\\\\n\\end{tabular}`);
      await selectKind("table");
      const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
      const inner = (field as HTMLElement & { editor: Editor }).editor;
      await act(() => inner.chain().focus().setTextSelection({ from: 1, to: 7 }).run());
      let items = await openCellFormatting();
      expect(items.every((item) => item.getAttribute("aria-disabled") !== "true")).toBe(true);
      expect(items[index]!.getAttribute("aria-checked")).toBe("true");
      await act(() => items[index]!.click());
      expect(inner.isActive(mark)).toBe(false);
      expect(current).not.toContain(`\\${command}{Marked}`);
      await act(() => inner.chain().focus().setTextSelection({ from: 8, to: 13 }).run());
      items = await openCellFormatting();
      expect(items[index]!.getAttribute("aria-checked")).toBe("false");
      await act(() => items[index]!.click());
      expect(inner.isActive(mark)).toBe(true);
      expect(current).toContain(`Marked \\${mark === "italic" ? "emph" : command}{Plain}`);
      // A different cell has its own marks, even though the outer selection stays a table.
      const other = (
        container.querySelector('[data-table-cell="0-1"]') as HTMLElement & { editor: Editor }
      ).editor;
      await act(() => other.chain().focus().selectAll().run());
      items = await openCellFormatting();
      expect(items[index]!.getAttribute("aria-checked")).toBe("false");
    },
  );

  it.each(["MacIntel", "Win32"])(
    "respects default, disabled and remapped cell formatting shortcuts on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      reloadKeyboardPreferences();
      await mount("\\begin{tabular}{l}\nCell text\\\\\n\\end{tabular}");
      const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
      const inner = (field as HTMLElement & { editor: Editor }).editor;
      await act(() => inner.chain().focus().selectAll().run());
      const press = (key: string, shiftKey = false) =>
        act(() =>
          field.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              shiftKey,
              metaKey: platform === "MacIntel",
              ctrlKey: platform !== "MacIntel",
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
      for (const [command, key, mark] of [
        ["latex.bold", "b", "bold"],
        ["latex.italic", "i", "italic"],
        ["latex.inlineCode", "e", "code"],
      ] as const) {
        await act(() => saveKeyboardPreferences(DEFAULT_KEYBOARD_PREFERENCES));
        await press(key);
        expect(inner.isActive(mark)).toBe(true); // One toggle, not two owners.
        await press(key);
        expect(inner.isActive(mark)).toBe(false);
        await act(() =>
          saveKeyboardPreferences({
            ...DEFAULT_KEYBOARD_PREFERENCES,
            overrides: { [command]: [] },
          }),
        );
        const before = current;
        await press(key);
        expect(inner.isActive(mark)).toBe(false);
        expect(current).toBe(before);
        await act(() =>
          saveKeyboardPreferences({
            ...DEFAULT_KEYBOARD_PREFERENCES,
            overrides: { [command]: [`mod+shift+${key}`] },
          }),
        );
        await press(key);
        expect(inner.isActive(mark)).toBe(false);
        await press(key, true);
        expect(inner.isActive(mark)).toBe(true);
        await press(key, true);
        expect(inner.isActive(mark)).toBe(false);
      }
    },
    30_000,
  );

  it("counts a cell text selection in the footer and follows cell selection changes", async () => {
    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(
        "\\begin{tabular}{ll}\nHello brave $x$ world & Other\\\\\n\\end{tabular}",
        "",
        headerSlot,
      );
      const inner = (
        container.querySelector('[data-table-cell="0-0"]') as HTMLElement & { editor: Editor }
      ).editor;
      await act(() => inner.chain().focus().setTextSelection({ from: 1, to: 12 }).run());
      const footer = container.querySelector(".scient-document-footer-count")!;
      expect(footer.textContent).toBe("2 of 4 words");
      await act(() => inner.commands.setTextSelection({ from: 1, to: 6 }));
      expect(footer.textContent).toBe("1 of 4 words");
      await act(() => inner.commands.setTextSelection(1));
      expect(footer.textContent).toBe("4 words");
    } finally {
      headerSlot.remove();
    }
  });

  it("routes the Math menu to the caret inside a table cell and shares document undo", async () => {
    await mount("\\begin{tabular}{ll}\nBefore after & Keep\\\\\n\\end{tabular}");
    const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    expect(inner).toBeDefined();
    await act(() => inner.chain().focus().setTextSelection(8).run());
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Math"]')!.click(),
    );
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
    ].find((item) => item.textContent?.trim() === "Inline math");
    expect(option).toBeDefined();
    await act(() => option!.click());
    let position = -1;
    inner.state.doc.descendants((node, at) => {
      if (node.type.name === "latexInlineMath") position = at;
    });
    expect(position).toBeGreaterThan(0);
    await act(() =>
      inner.view.dispatch(
        inner.state.tr.setNodeMarkup(position, undefined, { tex: "q^2", wrapper: "paren" }),
      ),
    );
    expect(current).toContain("Before \\(q^2\\)after & Keep");
    expect(editor().state.doc.childCount).toBe(1);
    expect(projectLatexVisualDocument(current).rawBlocks).toBe(0);
    await act(() => editor().commands.undo());
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
  });

  it("expands a cell's Select All to the whole table and restores a deleted table with undo", async () => {
    await mount("\\begin{tabular}{ll}\nOne & Two\\\\\n\\end{tabular}");
    const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    await act(() => inner.chain().focus().selectAll().run());
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    const table = container.querySelector<HTMLElement>('[data-table-selection="whole"]');
    expect(table).not.toBeNull();
    await act(() =>
      table!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      ),
    );
    expect(current).not.toContain("\\begin{tabular}");
    await act(() => editor().commands.undo());
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
    expect(current).toContain("One & Two");
  });

  it("retains rapid edits in different table cells", async () => {
    await mount("\\begin{tabular}{ll}\nOne & Two\\\\\n\\end{tabular}");
    const fields = [...container.querySelectorAll<HTMLElement>("[data-table-cell]")].map(
      (field) => (field as HTMLElement & { editor: Editor }).editor,
    );
    await act(() => {
      fields[0]!.chain().selectAll().insertContent("First").run();
      fields[1]!.chain().selectAll().insertContent("Second").run();
    });
    expect(current).toContain("First & Second");
  });

  it("clears a rectangular selection of rich cells and restores it without another table", async () => {
    await mount("\\begin{tabular}{ll}\nAlpha & Text $x$\\\\\nKeep & Last\\\\\n\\end{tabular}");
    const field = container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    await act(() => inner.commands.focus("end"));
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const table = container.querySelector<HTMLElement>('[data-table-selection="cells"]');
    expect(table).not.toBeNull();
    await act(() =>
      table!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      ),
    );
    expect(editor().state.doc.firstChild!.attrs.rows).toEqual([
      ["", ""],
      ["Keep", "Last"],
    ]);
    await act(() => editor().commands.undo());
    expect(editor().state.doc.firstChild!.attrs.rows).toEqual([
      ["Alpha", "Text $x$"],
      ["Keep", "Last"],
    ]);
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
    await act(() => inner.commands.focus("end"));
    expect(container.querySelector("[data-table-selection]")).toBeNull();
    expect(inner.state.selection.empty).toBe(true);
  });

  it("edits description and table structures without opening source", async () => {
    await mount(`\\begin{description}[style=nextline]
\\item[Algorithms] Design and prove algorithms.
\\item[Complexity] Study computational limits.
\\end{description}

\\begin{table}
\\caption{Research options.}
\\begin{tabular}{ll}
Area & Evidence \\\\
Theory & Proofs \\\\
\\end{tabular}
\\end{table}`);
    expect(container.querySelectorAll(".scient-latex-rich-preview")).toHaveLength(2);
    expect(container.querySelector(".scient-latex-visual-raw")).toBeNull();
    const descriptionLabel = container.querySelector<HTMLInputElement>(
      "input[aria-label='Description item 1 label']",
    )!;
    const descriptionBody = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Description item 1 body']",
    )!;
    expect(descriptionLabel.value).toBe("Algorithms");
    expect(descriptionBody.value).toBe("Design and prove algorithms.");
    await setField(descriptionLabel, "Algorithms & proofs");
    await setField(descriptionBody, "Design verified algorithms.");
    expect(current).toContain("\\item[Algorithms \\& proofs] Design verified algorithms.");
    await selectKind("table");
    const caption = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Table caption']",
    )!;
    expect(caption.value).toBe("Research options.");
    await setField(caption, "Research areas & evidence.");
    expect(current).toContain("\\caption{Research areas \\& evidence.}");
    const evidence = container.querySelector<HTMLElement>(
      "[contenteditable][aria-label='Table row 2 column 2']",
    )!;
    const fieldEditor = (evidence as HTMLElement & { editor: Editor }).editor;
    await act(() => fieldEditor.chain().focus().selectAll().insertContent("Verified proofs").run());
    expect(current).toContain("Theory & Verified proofs");
    expect(container.querySelector("[contenteditable][aria-label='Table row 2 column 2']")).toBe(
      evidence,
    );
    const addRow = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Insert below",
    )!;
    await act(async () => addRow.click());
    expect(current).toContain(" &  \\\\");
    expect(
      container.querySelector("[contenteditable][aria-label='Table row 3 column 1']"),
    ).not.toBeNull();
    const addColumn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Insert right",
    )!;
    await act(async () => addColumn.click());
    expect(
      container.querySelector("[contenteditable][aria-label='Table row 1 column 3']"),
    ).not.toBeNull();
    await selectOption("Table style", "Full grid");
    expect(current).toContain("\\hline");
    const reference = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Table reference label']",
    )!;
    await setField(reference, "tab:research");
    expect(current).toContain("\\label{tab:research}");
  });

  it("inserts a table from the document toolbar picker", async () => {
    await mount("Before");
    await insertMenuItem("Table");
    const insert = document.body.querySelector<HTMLElement>(
      "[data-scient-table-size-cell-row='3'][data-scient-table-size-cell-column='4']",
    )!;
    await act(async () => insert.click());
    await act(() => {});
    expect(current).toContain("\\begin{table}[htbp]");
    expect(current).toContain("\\begin{tabular}");
    expect(
      container.querySelector("[contenteditable][aria-label='Table row 3 column 4']"),
    ).not.toBeNull();
  });

  it("inserts and edits theorem-like scientific statements", async () => {
    await mount("Before");
    await insertMenuItem("Claim");
    const position = await selectKind("latexScientific");
    const title = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Scientific statement title']",
    )!;
    await setField(title, "Central claim");
    await act(() => {
      const statement = editor().state.doc.nodeAt(position)!;
      editor().commands.setTextSelection({
        from: position + 2,
        to: position + statement.nodeSize - 2,
      });
      editor().commands.insertContent("The visual source remains authoritative.");
    });
    expect(current).toContain("\\newtheorem{claim}{Claim}");
    expect(current).toContain("\\begin{claim}[Central claim]");
    expect(current).toContain("The visual source remains authoritative.");
  });

  it("inserts, edits and deletes a visual figure", async () => {
    await mount("Before");
    const figure = latexFigureSource({
      documentPath: "main.tex",
      assetPath: "images/image.png",
      source: current,
    });
    await act(() =>
      editor().commands.insertContent(projectLatexVisualDocument(tex(figure)).content.content!),
    );
    expect(current).toContain("\\usepackage{graphicx}");
    await selectKind("figure");
    const path = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Figure image path']",
    )!;
    await setField(path, "images/result.png");
    expect(current).toContain("\\includegraphics[width=0.8\\textwidth]{images/result.png}");
    const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Delete figure",
    )!;
    await act(async () => remove.click());
    expect(current).not.toContain("\\begin{figure}");
  });

  it("inserts a source-backed reference from the writing toolbar", async () => {
    await mount("Target \\label{sec:target}");
    await insertMenuItem("Cross-reference");
    const key = document.body.querySelector<HTMLInputElement>(
      ".scient-writing-reference-key input",
    )!;
    await setField(key, "sec:target");
    await act(() =>
      key.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await act(() => {});
    expect(current).toContain("\\ref{sec:target}");
  });

  it("provides a compact writing toolbar and collapsed document outline", async () => {
    await mount("\\section{Methods}\nThe method remains editable.");
    expect(container.querySelector("button[aria-label='Insert']")).not.toBeNull();
    expect(container.querySelector("[aria-label='Document navigation']")).toBeNull();
    const outline = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Show Document sidebar']",
    )!;
    await act(() => outline.click());
    await act(() =>
      [...container.querySelectorAll<HTMLButtonElement>(".scient-latex-navigation-tabs button")]
        .find((button) => button.textContent === "Outline")!
        .click(),
    );
    expect(container.querySelector("[aria-label='Document navigation']")?.textContent).toContain(
      "Methods",
    );
  });

  it("never inserts a printed title block unless the writer asks for one", async () => {
    await mount("Body", "\\title{Existing metadata}\n");
    const original = current;
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
    );
    const titleGroup = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Title & authors",
    )!;
    await act(() => titleGroup.click());
    const names = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    );
    // No title block is shown yet: the only choice is to add one.
    expect(names).toContain("Add a title");
    expect(names).not.toContain("Edit title");
    expect(current).toBe(original);
    expect(current).not.toContain("\\maketitle");
  });

  it("rejects a destructive transaction spanning protected source", async () => {
    await mount("Hello\n\n\\custom{keep}");
    const before = current;
    await act(async () => {
      editor().commands.selectAll();
      editor().commands.deleteSelection();
    });
    expect(current).toBe(before);
    expect(container.textContent).toContain("source was left unchanged");
  });

  it("discards obsolete undo history when external source is adopted", async () => {
    const renderEditor = (source: string) => (
      <LatexVisualEditor
        draftKey="synthetic-editor-test"
        fileRevision="external-test"
        source={source}
        disabled={false}
        onEdit={(expected, next) => {
          writes(expected, next);
          return true;
        }}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
      />
    );
    await act(async () => {
      root.render(renderEditor(tex("Hello")));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      editor().commands.insertContent("Old ");
    });
    expect(editor().can().undo()).toBe(true);
    const external = tex("External replacement");
    await act(async () => {
      root.render(renderEditor(external));
    });
    expect(editor().getText()).toBe("External replacement");
    expect(editor().can().undo()).toBe(false);
  });

  it("keeps the body caret after an external source change so typing cannot replace the title", async () => {
    const titled = (body: string) =>
      `\\documentclass{article}\n\\title{Keep this title}\n\\begin{document}\n\\maketitle\n\n${body}\n\\end{document}\n`;
    const renderEditor = (source: string) => (
      <LatexVisualEditor
        draftKey="synthetic-title-selection-test"
        fileRevision="external-title-test"
        source={source}
        disabled={false}
        onEdit={(expected, next) => {
          writes(expected, next);
          return true;
        }}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
      />
    );
    await act(async () => root.render(renderEditor(titled("First paragraph"))));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    let bodyPosition = -1;
    editor().state.doc.descendants((node, position) => {
      if (node.isText && node.text?.includes("First paragraph")) bodyPosition = position + 5;
    });
    expect(bodyPosition).toBeGreaterThan(0);
    await act(async () => editor().commands.setTextSelection(bodyPosition));

    const external = titled("Changed paragraph");
    await act(async () => root.render(renderEditor(external)));
    expect(editor().getText()).toContain("Changed paragraph");
    expect(editor().state.selection.empty).toBe(true);
    expect(editor().state.selection.$from.parent.type.name).toBe("paragraph");
    await act(async () => editor().commands.insertContent("X"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(writes).toHaveBeenCalledWith(external, expect.stringContaining("\\maketitle"));
    expect(writes.mock.lastCall?.[1]).toContain("\\title{Keep this title}");
    expect(writes.mock.lastCall?.[1]).toContain("ChangXed paragraph");
  });

  it("edits labelled equation math while retaining numbering and refusing new outer rows", async () => {
    await mount("\\begin{align}\n  x &= y \\label{eq:first} \\\\\n  a &= b \\notag\n\\end{align}");
    const before = current;
    expect(editor().state.doc.firstChild?.type.name).toBe("latexDisplayMath");
    await act(async () => {
      editor().commands.setNodeSelection(0);
      editor().commands.updateAttributes("latexDisplayMath", {
        tex: String(editor().state.doc.firstChild!.attrs.tex).replace("x &=", "z &="),
      });
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(current).toBe(before.replace("x &=", "z &="));
    const saved = current;
    const math = editor().state.doc.firstChild!.attrs.tex;
    await act(async () => {
      editor().commands.updateAttributes("latexDisplayMath", { tex: math + " \\\\ q = r" });
    });
    expect(editor().state.doc.firstChild!.attrs.tex).toBe(math);
    expect(current).toBe(saved);
  });
});
