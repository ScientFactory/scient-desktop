import "../../index.css";
import "./scient-latex.css";
import { fakeTimers, render as _fixtureRender, type Screen, act } from "../../../test/render";
import { waitForTestReceipt } from "../../../test/receipt";
import type { Editor, NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { LatexMathFieldHandle } from "./LatexMathField";
import { useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { PDF_FIT_WIDTH_PADDING } from "../pdf/pdfReaderModel";

import { describe, expect, it, vi, type TestContext } from "vite-plus/test";

// Test the actual ProseMirror transaction/save boundary. MathLive's native
// shadow-DOM keyboard is checked in the running desktop, not simulated here.
vi.mock("./LatexMathField", () => ({
  LatexMathField: ({ value, ref }: { value: string; ref: Ref<LatexMathFieldHandle> }) => {
    useImperativeHandle(ref, () => ({
      flush: () => true,
      getSource: () => value,
      focus: () => {},
      isEmpty: () => value.length === 0,
      clearSelection: () => {},
      cancelPointerSelection: () => {},
      insert: () => {},
      toggleTextFormat: () => false,
      textFormatActive: () => false,
      command: () => false,
    }));
    return <span>{value}</span>;
  },
}));
// These source-transaction cases use the interactive adapter above. Passive
// math preparation and activation are exercised by the real browser cases.
vi.mock("./mathReadingNodeView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mathReadingNodeView")>()),
  mathReadingNodeView: (props: NodeViewRendererProps, interactive: NodeViewRenderer) =>
    interactive(props),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import { setLatexPageMarkers } from "./latexPageMarkers";
import { latexPagedKey, pagedLayoutSettled } from "./latexPagedGeometry";
import {
  createLatexVisualTestOwner,
  useLatexVisualTestOwner,
  stubLatexReadingFonts,
} from "./latexVisualTestOwner";
import { waitForLatexVisualTestReadiness } from "./latexVisualTestReadiness";
import { latexEditingTarget } from "./latexEditingTarget";
import { ReaderBarHostContext } from "../writing/readerBarHost";
import { mathSourceCompletions } from "./latexMathCompletion";
import { clearVisualDraft, readPersistedVisualDraft } from "./visualDrafts";
import { clearTypingDraft } from "./visualTyping";
import { scientificStatementsFixture } from "./scientificStatements.fixture";
import { readStoredRecovery } from "./visualRecovery";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import { latexFigureSource } from "./figureSource";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "../keyboard/preferences";

const advance = async (ms = 320) => await act(() => vi.advanceTimersByTimeAsync(ms));
const settleTyping = async (published: () => Promise<void>) => {
  await advance();
  await published();
};

const readerHosted = vi.fn();

describe("writing editor source transactions", () => {
  let current: string;
  let confirmed: string | null;

  const writes = vi.fn();
  const writeReceipts = new Map<() => void, (source: string) => boolean>();
  const nextWriteReceipt = (
    _fixture: _Fixture,
    matches: (source: string) => boolean = () => true,
  ) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const dispose = () => {
      writeReceipts.delete(resolve);
    };
    writeReceipts.set(resolve, matches);
    _fixture.cleanup.defer(dispose);
    // Arm immediately, but only start the rejecting cancellation race when awaited.
    return () => waitForTestReceipt(_fixture.context.signal, promise, dispose);
  };
  const publishWriteReceipt = (source: string) => {
    for (const [resolve, matches] of writeReceipts) {
      if (!matches(source)) continue;
      writeReceipts.delete(resolve);
      resolve();
    }
  };
  const flushReferences = vi.fn<() => Promise<boolean>>();
  const tex = (body: string) =>
    `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.restoreFonts = stubLatexReadingFonts();
    writes.mockReset();
    confirmed = null;
    flushReferences.mockReset().mockResolvedValue(false);
    clearVisualDraft("synthetic-editor-test");
    clearTypingDraft("synthetic-editor-test");
    localStorage.clear();
    reloadKeyboardPreferences();
    _fixture.container = document.createElement("div");
    // The application bounds this surface; auto height feeds pagination back into its observer.
    _fixture.container.style.cssText =
      "display:flex;flex-direction:column;height:800px;min-height:0;overflow:hidden";
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function renderMountedEditor(_fixture: _Fixture, ui: ReactNode) {
    _fixture.clock?.[Symbol.dispose]();
    _fixture.clock = undefined;
    await _fixture.root0.rerender(ui);
    await waitForLatexVisualTestReadiness(
      _fixture.container,
      _fixture.context,
      "source transactions",
    );
    _fixture.clock = _fixture.cleanup.use(fakeTimers());
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    // References keeps forms across remounts; discard this fixture's retained form.
    const cancel = [..._fixture.container.querySelectorAll<HTMLButtonElement>("form button")].find(
      (button) => button.textContent === "Cancel",
    );
    if (cancel) await act(() => cancel.click());
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    clearVisualDraft("synthetic-editor-test");
    clearTypingDraft("synthetic-editor-test");
    _fixture.restoreFonts();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  // Find and replace is in the writing row's Document menu.
  async function openFindAndReplace(_fixture: _Fixture, _headerSlot: HTMLElement) {
    await act(() =>
      _fixture.container
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
  async function openReferenceEntry(_fixture: _Fixture) {
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
    );
    const references = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "References",
    );
    expect(references).toBeDefined();
    await act(() => references!.click());
    const entry = _fixture.container.querySelector<HTMLButtonElement>(
      '[aria-label="Bibliography entries"] button',
    );
    expect(entry).not.toBeNull();
    await act(() => entry!.click());
  }
  function editor(_fixture: _Fixture): Editor {
    return (_fixture.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor })
      .editor;
  }
  async function focusCellEditor(_fixture: _Fixture, field: Editor) {
    // TipTap's focus command queues RAF. With the fixture clock stopped, a
    // selection transaction alone has not delivered the native focus event
    // that gives this cell ownership of toolbar actions and selection status.
    await act(() => field.view.focus());
    expect(document.activeElement).toBe(field.view.dom);
    expect(field.isFocused).toBe(true);
    expect(latexEditingTarget(editor(_fixture))).toBe(field);
  }
  async function contextMenuAction(
    _fixture: _Fixture,
    menu: string,
    submenu: string | null,
    name: string,
  ) {
    const trigger = _fixture.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${menu}"]`,
    );
    expect(trigger).not.toBeNull();
    await act(() => trigger!.click());
    const find = (label: string) =>
      [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
        (item) => item.textContent?.trim() === label,
      );
    if (submenu) {
      const group = find(submenu);
      expect(group).toBeDefined();
      await act(() => group!.click());
    }
    const action = find(name);
    expect(action).toBeDefined();
    await act(() => action!.click());
    await advance();
  }
  async function openCellFormatting(_fixture: _Fixture) {
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!.click(),
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
  async function insertMenuItem(_fixture: _Fixture, name: string) {
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
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
    await advance();
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
    await advance();
    await act(() => field.blur());
    await advance();
  }
  async function focusReferenceLabel(_fixture: _Fixture, label: string) {
    const field = _fixture.container.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${label}"]`,
    )!;
    expect(field).not.toBeNull();
    await act(() => field.focus());
    return field;
  }
  async function selectKind(_fixture: _Fixture, kind: string) {
    let position = -1;
    editor(_fixture).state.doc.descendants((node, offset) => {
      if (node.attrs.kind === kind || node.type.name === kind) position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    await act(() => editor(_fixture).commands.setNodeSelection(position));
    return position;
  }
  /** `headerSlot` hosts the reader controls the way the LaTeX surface's header does. */
  async function mount(
    _fixture: _Fixture,
    body = "Hello",
    preamble = "",
    headerSlot: HTMLElement | null = null,
    registerFinishEditing?: (finish: (() => boolean) | null) => void,
  ) {
    current = tex(body).replace("\\begin{document}", preamble + "\\begin{document}");
    function Harness() {
      const [source, setSource] = useState(current);
      const owner = useLatexVisualTestOwner(source);
      const editorElement = (
        <LatexVisualEditor
          draftKey="synthetic-editor-test"
          fileRevision="r1"
          source={source}
          sourceSnapshot={owner.snapshot}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          {...(registerFinishEditing ? { registerFinishEditing } : {})}
          flushReferenceEdits={flushReferences}
          confirmedReferenceSource={() => confirmed}
          onEdit={(request) => {
            const outcome = owner.edit(request, current === request.edit.source);
            if (!outcome.accepted) return outcome;
            writes(request.edit.source, outcome.snapshot.source);
            current = outcome.snapshot.source;
            setSource(current);
            publishWriteReceipt(current);
            return outcome;
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
    await renderMountedEditor(_fixture, <Harness />);
  }

  it.for([
    "\\newcommand% name follows\n\\hiddenBegin{\\begin{comment}}",
    "\\newcommand% star follows\r\n*{\\hiddenBegin}{\\begin{comment}}",
    "\\DeclareDocumentCommand{\\hiddenBegin}{m}{\\begin{comment}#1}",
  ] as const)(
    "edits the body and preserves unused declaration %s through undo and redo",
    async (definition, testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await mount(_fixture, "Actual body.", `${definition}\n`);
      const original = current;
      expect(editor(_fixture).isEditable).toBe(true);
      expect(editor(_fixture).state.doc.textContent).toBe("Actual body.");
      let published = nextWriteReceipt(_fixture);
      await act(() => editor(_fixture).chain().setTextSelection(1).insertContent("New ").run());
      await settleTyping(published);
      const changed = original.replace("Actual body.", "New Actual body.");
      expect(current).toBe(changed);
      published = nextWriteReceipt(_fixture);
      await act(() => editor(_fixture).commands.undo());
      await settleTyping(published);
      expect(current).toBe(original);
      published = nextWriteReceipt(_fixture);
      await act(() => editor(_fixture).commands.redo());
      await settleTyping(published);
      expect(current).toBe(changed);
    },
  );

  it("edits a visible heading label in the footer and adds/removes it through source and undo", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\section{Introduction}\n\nSee Section~\\ref{sec:intro}.");
    await act(() => editor(_fixture).commands.setTextSelection(3));
    const field = () =>
      document.body.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Heading reference label"]',
      )!;
    await focusReferenceLabel(_fixture, "Heading reference label");
    expect(field()).not.toBeNull();
    expect(
      _fixture.container.querySelector(".scient-latex-context-tools[data-inline]"),
    ).not.toBeNull();
    expect(
      _fixture.container.querySelector(".scient-latex-context-inspector")?.hasAttribute("inert"),
    ).toBe(false);
    expect(
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Heading options"]')
        ?.hidden,
    ).toBe(true);
    expect(
      _fixture.container.querySelector(".scient-latex-heading-bar [data-latex-number-toggle]"),
    ).toBeNull();
    await setField(field(), "sec:intro");
    expect(current).toContain("\\section{Introduction}\\label{sec:intro}");
    expect(
      latexEquationReferencesKey.getState(editor(_fixture).state)?.labels.get("sec:intro")?.number,
    ).toBe("1");
    await setField(field(), "");
    expect(current).not.toContain("\\label{sec:intro}");
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toContain("\\label{sec:intro}");
    expect(field().value).toBe("sec:intro");
  });

  it("renames a heading label and its recognized references on Enter while preserving heading selection", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\section{Introduction}\\label{sec:old}\n\nSee \\ref{sec:old}, \\nameref{sec:old} and \\hyperref[sec:old]{Introduction}.\n\n% \\ref{sec:old}",
      "\\usepackage{hyperref}\n",
    );
    await act(() => editor(_fixture).commands.setTextSelection(3));
    const field = await focusReferenceLabel(_fixture, "Heading reference label");
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
    await advance();
    expect(current).toContain("\\label{sec:new}");
    expect(current).toContain("\\ref{sec:new}");
    expect(current).toContain("\\nameref{sec:new}");
    expect(current).toContain("\\hyperref[sec:new]{Introduction}");
    expect(current).toContain("% \\ref{sec:old}");
    expect(editor(_fixture).state.selection.from).toBe(3);
    expect(editor(_fixture).state.selection.empty).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("sec:new");
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toContain("\\label{sec:old}");
    expect(current).toContain("\\hyperref[sec:old]{Introduction}");
  });

  it("rejects invalid and duplicate heading labels without publishing the field draft", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\section{Introduction}\\label{sec:intro}\n\n\\section{Results}\\label{sec:results}",
    );
    await act(() => editor(_fixture).commands.setTextSelection(3));
    await focusReferenceLabel(_fixture, "Heading reference label");
    const field = () =>
      document.body.querySelector<HTMLTextAreaElement>(
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

  it("keeps table label editing attached to its object through the inline footer field", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      `\\begin{table}
\\caption{Results}
\\label{tab:old}
\\begin{tabular}{ll}
Method & Score \\\\
Control & 1 \\\\
\\end{tabular}
\\end{table}`,
    );
    await selectKind(_fixture, "table");
    const field = await focusReferenceLabel(_fixture, "Table reference label");
    expect(field.value).toBe("tab:old");
    await setField(field, "tab:new");
    expect(current).toContain("\\label{tab:new}");
    expect(current).toContain("Control & 1");
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toContain("\\label{tab:old}");
  });

  it("settles selected table layout without resize observer errors", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => {
      if (event.message.includes("ResizeObserver")) errors.push(event.message);
    };
    window.addEventListener("error", onError);
    _fixture.stack.defer(() => window.removeEventListener("error", onError));
    await mount(
      _fixture,
      "\\begin{table}\\caption{Results}\\label{tab:old}\\begin{tabular}{ll}Method & Score \\\\\nControl & 1 \\\\\n\\end{tabular}\\end{table}",
    );
    await selectKind(_fixture, "table");
    await advance();
    await expect.poll(() => pagedLayoutSettled(editor(_fixture).view)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("retains a manual reference until its document save is confirmed", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\begin{thebibliography}{99}\n\\bibitem{known} Original entry\n\\end{thebibliography}",
    );
    await selectKind(_fixture, "bibliography");
    await openReferenceEntry(_fixture);
    const field = () =>
      _fixture.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Reference entry text"]',
      );
    expect(field()).not.toBeNull();
    await setField(field()!, "Updated entry");
    let confirm!: (value: boolean) => void;
    flushReferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const save = async () =>
      await act(() =>
        _fixture.container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    await save();
    expect(current).toContain("Updated entry");
    expect(flushReferences).toHaveBeenCalledOnce();
    expect(field()?.value).toBe("Updated entry");
    expect(_fixture.container.textContent).not.toContain("Reference saved.");
    await act(() => confirm(false));
    expect(field()?.value).toBe("Updated entry");
    expect(_fixture.container.textContent).toContain("Your entry draft is retained");
    expect(_fixture.container.textContent).not.toContain("Reference saved.");
    flushReferences.mockResolvedValueOnce(true);
    confirmed = current;
    await save();
    expect(field()).toBeNull();
    expect(_fixture.container.textContent).toContain("Reference saved.");
  });

  it("keeps a manual reference when a clean save published a superseding entry", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\begin{thebibliography}{99}\n\\bibitem{known} Original entry\n\\end{thebibliography}",
    );
    await selectKind(_fixture, "bibliography");
    await openReferenceEntry(_fixture);
    const field = () =>
      _fixture.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Reference entry text"]',
      );
    await setField(field()!, "Entry A");
    flushReferences.mockImplementationOnce(async () => {
      confirmed = current.replace("Entry A", "Entry B");
      return true;
    });
    await act(() =>
      _fixture.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(flushReferences).toHaveBeenCalledOnce();
    expect(confirmed).toContain("Entry B");
    expect(field()?.value).toBe("Entry A");
    expect(_fixture.container.textContent).not.toContain("Reference saved.");
    expect(_fixture.container.textContent).toContain(
      "The file changed before the reference was saved",
    );
  });

  it("keeps writing tools in one permanent row and reader controls in the footer", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    const toolbar = _fixture.container.querySelector(
      '[role="toolbar"][aria-label="Writing tools"]',
    )!;
    expect(
      [...toolbar.querySelectorAll("[data-dock-group]")].map((group) =>
        group.getAttribute("data-dock-group"),
      ),
    ).toEqual(["history", "text", "insert", "math", "lists", "document"]);
    expect(toolbar.querySelector('button[aria-label="Text"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Hide formatting tools"]')).toBeNull();
    expect(toolbar.querySelector('input[aria-label="Page number"]')).toBeNull();
    expect(latexPagedKey.getState(editor(_fixture).state)?.plan?.pages).toBe(1);
    await expect
      .element(_fixture.root0.getByRole("textbox", { name: "Page number", exact: true }))
      .toHaveValue("1");
    expect(
      _fixture.container.querySelector('.scient-latex-reader-footer [aria-label="1 pages"]'),
    ).not.toBeNull();
    expect(
      _fixture.container.querySelector('.scient-latex-reader-footer button[aria-label^="Zoom in"]'),
    ).not.toBeNull();
    expect(_fixture.container.querySelector(".scient-latex-document-tools")).toBeNull();
    const context = _fixture.container.querySelector(".scient-latex-context-tools")!;
    // The percentage fits the width; there is no separate Fit width button.
    expect(
      context.previousElementSibling?.previousElementSibling?.getAttribute("aria-label"),
    ).toMatch(/^Zoom in/);
    // Search is a field right after the zoom; the object options follow it.
    expect(context.previousElementSibling?.className).toBe("scient-reader-search");
    expect(context.querySelector(".scient-latex-context-tools-slot")).not.toBeNull();
    expect(
      _fixture.container.querySelector('[aria-label="Selected object properties"]'),
    ).toBeNull();
  });

  it("draws the reader controls in the host's header and leaves a compact footer", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(_fixture, "Hello brave new world", "", headerSlot);
      // Native visual pagination does not require a compiled PDF.
      expect(headerSlot.querySelector('button[aria-label^="Zoom in"]')).not.toBeNull();
      expect(headerSlot.querySelector(".scient-pdf-toolbar-hosted")).not.toBeNull();
      expect(_fixture.container.querySelector('button[aria-label^="Zoom in"]')).toBeNull();
      await expect
        .element(document.body.querySelector<HTMLInputElement>('input[aria-label="Page number"]')!)
        .toHaveValue("1");
      expect(document.body.querySelectorAll('input[aria-label="Page number"]')).toHaveLength(1);
      await act(() =>
        setLatexPageMarkers(editor(_fixture).view, {
          key: "build",
          pageCount: 2,
          anchors: [{ page: 1, position: 0 }],
        }),
      );
      expect(headerSlot.querySelector('input[aria-label="Page number"]')).not.toBeNull();
      expect(headerSlot.querySelector('[aria-label="1 pages"]')).not.toBeNull();
      expect(document.body.querySelectorAll('input[aria-label="Page number"]')).toHaveLength(1);
      expect(readerHosted).toHaveBeenLastCalledWith(true);
      // The footer holds the object options slot and what follows the caret.
      const footer = _fixture.container.querySelector(".scient-document-footer")!;
      expect(footer).not.toBeNull();
      expect(footer.classList.contains("scient-latex-reader-footer")).toBe(true);
      expect(footer.querySelector(".scient-latex-context-tools-slot")).not.toBeNull();
      expect(footer.querySelector(".scient-document-footer-position")?.textContent).toBe("Text");
      expect(footer.querySelector(".scient-document-footer-count")?.textContent).toBe("4 words");
      await act(() => {
        editor(_fixture).commands.setTextSelection({ from: 1, to: 12 });
      });
      expect(footer.querySelector(".scient-document-footer-count")?.textContent).toBe(
        "2 of 4 words",
      );
      // Search opens under the writing row, next to the controls that opened it.
      await openFindAndReplace(_fixture, headerSlot);
      // The same find and replace bar as the Markdown editor.
      const search = _fixture.container.querySelector(".scient-markdown-find-bar")!;
      expect(search).not.toBeNull();
      const toolbar = _fixture.container.querySelector(".scient-latex-writing-toolbar")!;
      expect(
        toolbar.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        search.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        search.compareDocumentPosition(
          _fixture.container.querySelector(".scient-latex-visual-body")!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      headerSlot.remove();
    }
  });

  it("finds and replaces text, writing the replacement to the source", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(_fixture, "One cat, two cats, three Cats.", "", headerSlot);
      await openFindAndReplace(_fixture, headerSlot);
      const bar = _fixture.container.querySelector(".scient-markdown-find-bar")!;
      await setField(bar.querySelector<HTMLInputElement>("input[aria-label='Find text']")!, "cat");
      expect(bar.textContent).toContain("1 of 3");
      await act(() => bar.querySelector<HTMLButtonElement>("[aria-label='Show replace']")!.click());
      const replace = bar.querySelector<HTMLInputElement>("input[aria-label='Replacement text']")!;
      await setField(replace, "dog_100%");
      await act(() =>
        bar.querySelector<HTMLButtonElement>("[aria-label='Replace current match']")!.click(),
      );
      // Special characters are written the way typing them would write them.
      await advance();
      expect(current).toContain("One dog\\_100\\%, two cats, three Cats.");
      await act(() =>
        bar.querySelector<HTMLButtonElement>("[aria-label='Replace all matches']")!.click(),
      );
      await advance();
      expect(current).toContain("One dog\\_100\\%, two dog\\_100\\%s, three dog\\_100\\%s.");
      expect(current).toContain("\\begin{document}");
    } finally {
      headerSlot.remove();
    }
  });

  it("replaces across paragraphs, a heading and a list, one block at a time", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(
        _fixture,
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
      await openFindAndReplace(_fixture, headerSlot);
      const bar = _fixture.container.querySelector(".scient-markdown-find-bar")!;
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
      await advance();
      await act(() => vi.waitFor(() => expect(current).not.toContain("cat")));
      expect(current).toContain("\\section{A dog}");
      expect(current).toContain("First dog here, and a second dog.");
      expect(current).toContain("No match in this one.");
      expect(current).toMatch(/\\item a dog in a list/u);
      expect(current).toContain("Last dog.");
      expect(_fixture.container.textContent).not.toContain("could not");
      // One block per undo step, so each step is an edit the source can hold.
      await act(() => editor(_fixture).commands.undo());
      await advance();
      expect(current.match(/cat/gu)?.length).toBe(1);
      expect(_fixture.container.textContent).not.toContain("could not");
    } finally {
      headerSlot.remove();
    }
  });

  it("stops replacing when the document changes under it, and never touches the new text", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(_fixture, ["cat cat.", "", "Last cat."].join("\n"), "", headerSlot);
      await openFindAndReplace(_fixture, headerSlot);
      const bar = _fixture.container.querySelector(".scient-markdown-find-bar")!;
      await setField(bar.querySelector<HTMLInputElement>("input[aria-label='Find text']")!, "cat");
      expect(bar.textContent).toContain("1 of 3");
      await act(() => bar.querySelector<HTMLButtonElement>("[aria-label='Show replace']")!.click());
      await setField(
        bar.querySelector<HTMLInputElement>("input[aria-label='Replacement text']")!,
        "dog",
      );
      const published = nextWriteReceipt(
        _fixture,
        (source) => source.includes("cat cat cat.") && source.includes("Last dog."),
      );
      await act(() => {
        bar.querySelector<HTMLButtonElement>("[aria-label='Replace all matches']")!.click();
        // The last paragraph is done; the others wait for a paint. The writer
        // types the searched word at the very start before that paint.
        editor(_fixture).commands.insertContentAt(1, "cat ");
      });
      await settleTyping(published);
      expect(current).toContain("Last dog.");
      // The positions found earlier still hold the word "cat", but they are no
      // longer the words that were matched: nothing in this paragraph changes.
      expect(current).toContain("cat cat cat.");
      expect(current).not.toContain("dog dog");
      expect(_fixture.container.textContent).not.toContain("could not");
    } finally {
      headerSlot.remove();
    }
  });

  it("groups insertions and runs relocated text blocks from Text", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
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
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!.click(),
    );
    const alignment = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => row.textContent?.trim() === "Alignment",
    )!;
    await act(() => alignment.click());
    const right = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (row) => row.textContent?.trim() === "Right-aligned text",
    )!;
    await act(() => right.click());
    await advance();
    expect(current).toContain("\\begin{flushright}");
    expect(editor(_fixture).isFocused).toBe(true);
  });

  it("keeps Backspace typed in the title inside the title, whatever the document selects", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\maketitle\nFirst.\n\nSecond.", "\\title{Title}\n");
    const title = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Document title']",
    )!;
    // The document's own selection is the whole title block, as after a click on it.
    const titlePosition = editor(_fixture).view.posAtDOM(
      title.closest(".scient-latex-title-preview")!,
      0,
    );
    await act(() => editor(_fixture).commands.setNodeSelection(Math.max(0, titlePosition - 1)));
    await act(async () => title.focus());
    const backspace = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      title.dispatchEvent(backspace);
    });
    // The field keeps the key; the document editor neither deletes nor blocks it.
    expect(backspace.defaultPrevented).toBe(false);
    expect(current).toContain("\\maketitle");
    expect(current).toContain("\\title{Title}");
    expect(current).toContain("First.");
    expect(current).toContain("Second.");
  });

  it.for(["english", "hebrew"] as const)(
    "removes an empty %s document title with Backspace and restores it with Undo",
    async (language, testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const body = language === "hebrew" ? "טקסט המסמך." : "Document body.";
      const preamble =
        "\\title{}\n\\author{Author}\n\\date{Date}\n" +
        (language === "hebrew" ? "\\usepackage{polyglossia}\n\\setmainlanguage{hebrew}\n" : "");
      await mount(_fixture, `\\maketitle\n${body}\n\n\\custom{keep}`, preamble);
      const title = _fixture.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Document title']",
      )!;
      await act(() => title.focus());
      const backspace = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      });
      await act(() => title.dispatchEvent(backspace));
      await advance();
      expect(backspace.defaultPrevented).toBe(true);
      expect(current).not.toContain("\\maketitle");
      expect(current).toContain(preamble);
      expect(current).toContain(body);
      expect(current).toContain("\\custom{keep}");
      expect(_fixture.container.querySelector(".scient-latex-title-preview")).toBeNull();
      expect(editor(_fixture).state.selection.$from.parent.type.name).toBe("paragraph");
      expect(editor(_fixture).isFocused).toBe(true);
      await act(() => editor(_fixture).commands.undo());
      await advance();
      expect(current).toContain("\\maketitle");
      expect(current).toContain(preamble);
      expect(_fixture.container.querySelector(".scient-latex-title-preview")).not.toBeNull();
      await act(() => editor(_fixture).commands.redo());
      await advance();
      expect(current).not.toContain("\\maketitle");
      expect(current).toContain(body);
    },
  );

  it("settles a just-cleared title before deleting a title-only block", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\maketitle", "\\title{Title}\n\\author{}\n\\date{}\n");
    const title = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Document title']",
    )!;
    await act(() => title.focus());
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, "");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      );
    });
    await advance();
    expect(current).not.toContain("\\maketitle");
    expect(current).toContain("\\title{}");
    expect(editor(_fixture).state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor(_fixture).isFocused).toBe(true);
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toContain("\\maketitle");
    expect(current).toContain("\\title{}");
    expect(
      _fixture.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Document title']",
      )!.value,
    ).toBe("");
  });

  it("starts a titled document with formatting ready on body text", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\maketitle\nHello world.", "\\title{Title}\n");
    expect(editor(_fixture).state.selection.$from.parent.type.name).toBe("paragraph");
    const text = _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Text"]')!;
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
    expect(editor(_fixture).isActive("bold")).toBe(true);
  });

  it("offers the Markdown bar's inline formatting in the same order, without strikethrough", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    const toolbar = _fixture.container.querySelector(
      '[role="toolbar"][aria-label="Writing tools"]',
    )!;
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
    await act(() => editor(_fixture).commands.setTextSelection({ from: 1, to: 6 }));
    let items = await openFormatting();
    await act(() => items[2]!.click());
    await advance();
    expect(current).toContain("\\texttt{Hello}");
    expect(editor(_fixture).isFocused).toBe(true);
    items = await openFormatting();
    expect(items[2]!.getAttribute("aria-checked")).toBe("true");
    await act(() => items[2]!.click());
    await advance();
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
    // InsertMenu runs the command after its close transition completes.
    const popup = await vi.waitFor(() => {
      const element = document.body.querySelector('[data-slot="popover-popup"]');
      expect(element).not.toBeNull();
      return element!;
    });
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
    await advance();
    await vi.waitFor(() => expect(current).toContain("\\href{https://example.com}{Hello}"));
    expect(editor(_fixture).isFocused).toBe(true);
  });

  it("puts plain-text shortcut help under Document without extra More actions", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    const toolbar = _fixture.container.querySelector(
      '[role="toolbar"][aria-label="Writing tools"]',
    )!;
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
  it("applies settings from a one-card submenu that shows the current values", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Hello");
    const toolbar = _fixture.container.querySelector(
      '[role="toolbar"][aria-label="Writing tools"]',
    )!;
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
    await advance();
    await vi.waitFor(() => expect(current).toContain("top=2cm"));
    expect(current).toContain("Hello");
    expect(current).toContain("\\documentclass{article}");
    const applied = current;
    await act(() => {
      editor(_fixture).commands.undo();
    });
    await advance();
    await vi.waitFor(() => expect(current).not.toContain("top=2cm"));
    await act(() => {
      editor(_fixture).commands.redo();
    });
    await advance();
    await vi.waitFor(() => expect(current).toBe(applied));
    await vi.waitFor(() =>
      expect(
        document.body.querySelector(
          '[data-slot="menu-sub-content"][aria-label="Document settings"]',
        ),
      ).toBeNull(),
    );
  });

  it("changes the document language through settings with source preservation and undo/redo", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const body = "Existing \\textbf{bold} prose.\n\n\\textenglish{English passage.}";
    await mount(_fixture, body, "\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n");
    const original = current;
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
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
    await act(() =>
      popup.querySelector<HTMLButtonElement>('[aria-label="Document language"]')!.click(),
    );
    const hebrew = await vi.waitFor(() => {
      const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent?.trim() === "Hebrew",
      );
      expect(option).toBeDefined();
      return option!;
    });
    await act(() => hebrew.click());
    expect(current).toBe(original);
    await act(() =>
      [...popup.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Apply")!
        .click(),
    );
    await advance();
    await vi.waitFor(() => expect(current).toContain("\\setdefaultlanguage{hebrew}"));
    expect(current).toContain(body);
    expect(current).not.toContain("\\usepackage[T1]{fontenc}");
    const applied = current;
    await act(() => editor(_fixture).commands.undo());
    await advance();
    await vi.waitFor(() => expect(current).toBe(original));
    await act(() => editor(_fixture).commands.redo());
    await advance();
    await vi.waitFor(() => expect(current).toBe(applied));
  });

  it("moves lower-priority writing groups into More on narrow panes", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.container.style.width = "230px";
    _fixture.container.dataset.nativeNarrowWriting = "true";
    const layout = document.createElement("style");
    layout.textContent =
      "[data-native-narrow-writing] [data-dock-group]{width:70px;flex-shrink:0}[data-native-narrow-writing] [data-dock-reserved]{width:36px;flex-shrink:0}";
    document.body.append(layout);
    _fixture.stack.defer(() => layout.remove());
    await mount(_fixture);
    const toolbar = _fixture.container.querySelector(
      '[role="toolbar"][aria-label="Writing tools"]',
    )!;
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

  it("shows the list menu in the Markdown menu's shape, with its shortcuts", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "A paragraph.");
    const toolbar = _fixture.container.querySelector(
      '[role="toolbar"][aria-label="Writing tools"]',
    )!;
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
    await advance();
    expect(current).toContain("\\begin{itemize}");
  });

  it.for([false, true] as const)(
    "opens and applies an existing theorem's exact source after insertion=%s",
    async (insertBefore, testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const raw =
        "\\begin{theorem}[Energy estimate and decay]\nAssume \\eqref{eq:bc} and $u_0 \\in L^2(\\Omega)$.\n\\[\\|u(t)\\|^2 \\le \\|u_0\\|^2\\]\n\\custom{Keep}\n\\end{theorem}";
      await mount(_fixture, raw);
      if (insertBefore)
        await act(() =>
          editor(_fixture).commands.insertContentAt(0, {
            type: "paragraph",
            content: [{ type: "text", text: "Before" }],
          }),
        );
      const block = _fixture.container.querySelector<HTMLElement>(".scient-latex-visual-raw pre")!;
      expect(block.textContent).toBe(raw);
      await act(() => block.click());
      const source = _fixture.container.querySelector<HTMLTextAreaElement>(
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
      const apply = [..._fixture.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Apply LaTeX",
      );
      expect(apply).toBeDefined();
      await act(() => apply!.click());
      await advance();
      expect(current).toContain(raw.replace("Assume", "Suppose"));
      if (insertBefore) expect(current).toContain("Before");
    },
  );

  it("keeps an accepted raw edit recoverable when Cancel and Escape cannot checkpoint it", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const raw = "\\custom{Original}";
    const draft = "\\custom{Retained}";
    const finish: { current: (() => boolean) | null } = { current: null };
    await mount(_fixture, raw, "", null, (callback) => {
      finish.current = callback;
    });
    await act(() =>
      _fixture.container.querySelector<HTMLElement>(".scient-latex-visual-raw pre")!.click(),
    );
    const field = () =>
      _fixture.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Block LaTeX source']",
      );
    await setField(field()!, draft);
    expect(readStoredRecovery("synthetic-editor-test")?.text).toContain(draft);
    const quota = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Synthetic quota failure", "QuotaExceededError");
    });
    const button = (name: string) =>
      [..._fixture.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === name,
      )!;
    await act(() => button("Apply LaTeX").click());
    await advance();
    expect(current).toBe(tex(draft));
    expect(writes).toHaveBeenCalledOnce();
    expect(readPersistedVisualDraft("synthetic-editor-test")).toBeNull();
    await act(() => button("Cancel").click());
    expect(field()?.value).toBe(draft);
    expect(readStoredRecovery("synthetic-editor-test")?.text).toContain(draft);
    await act(() =>
      field()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(field()?.value).toBe(draft);
    expect(finish.current?.()).toBe(false);
    quota.mockRestore();
    await act(() => button("Cancel").click());
    expect(field()).toBeNull();
    expect(readPersistedVisualDraft("synthetic-editor-test")?.source).toBe(tex(draft));
    expect(readStoredRecovery("synthetic-editor-test")).toBeNull();
    expect(writes).toHaveBeenCalledOnce();
    expect(finish.current?.()).toBe(true);
  });

  it("edits prose and nested equations in the supplied theorem/proof/remark document", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const marker = "\\begin{document}";
    const body = scientificStatementsFixture
      .slice(
        scientificStatementsFixture.indexOf(marker) + marker.length,
        scientificStatementsFixture.lastIndexOf("\\end{document}"),
      )
      .trim();
    await mount(_fixture, body);
    expect(_fixture.container.querySelectorAll(".scient-latex-scientific-structure")).toHaveLength(
      4,
    );
    expect(_fixture.container.querySelector(".scient-latex-visual-raw")).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    const before = current;
    let prose = -1;
    editor(_fixture).state.doc.descendants((node, position) => {
      if (node.isText && node.text?.startsWith("Assume")) prose = position;
    });
    expect(prose).toBeGreaterThan(0);
    const published = nextWriteReceipt(
      _fixture,
      (source) => source === before.replace("Assume", "We Assume"),
    );
    await act(() => {
      editor(_fixture).commands.setTextSelection(prose);
      editor(_fixture).commands.insertContent("We ");
    });
    await settleTyping(published);
    expect(current).toBe(before.replace("Assume", "We Assume"));
    let math = -1;
    editor(_fixture).state.doc.descendants((node, position) => {
      if (node.type.name === "latexDisplayMath" && String(node.attrs.tex).includes("\\sup"))
        math = position;
    });
    await act(() => {
      editor(_fixture).commands.setNodeSelection(math);
      editor(_fixture).commands.updateAttributes("latexDisplayMath", {
        tex: String(editor(_fixture).state.doc.nodeAt(math)!.attrs.tex).replace("\\sup", "\\max"),
      });
    });
    await advance();
    expect(current).toBe(before.replace("Assume", "We Assume").replace("\\sup", "\\max"));
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(before.replace("Assume", "We Assume"));
  });

  it("splits a paragraph inside a theorem while keeping its environment", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\begin{theorem}[Result]\nFirst second\n\\end{theorem}");
    await act(() => {
      editor(_fixture).commands.setTextSelection(7);
      editor(_fixture).commands.splitBlock();
    });
    expect(editor(_fixture).state.doc.firstChild!.type.name).toBe("latexScientific");
    expect(editor(_fixture).state.doc.firstChild!.childCount).toBe(2);
    await advance();
    expect(current).toContain("\\begin{theorem}[Result]\nFirst\n\n second\n\\end{theorem}");
  });

  it("restores exact CRLF and list trivia through native split undo and redo", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\begin{itemize}\r\n  \\item First words\r\n\r\n  \\item Second.\r\n\\end{itemize}",
    );
    const original = current;
    let caret = -1;
    editor(_fixture).state.doc.descendants((node, position) => {
      if (node.isText && node.text === "First words") caret = position + "First".length;
    });
    expect(caret).toBeGreaterThan(0);
    await act(() => {
      editor(_fixture).commands.setTextSelection(caret);
      expect(editor(_fixture).commands.splitListItem("listItem")).toBe(true);
    });
    await advance();
    const split = current;
    expect(split).not.toBe(original);
    expect(projectLatexVisualDocument(split).content.content![0]!.content).toHaveLength(3);
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original);
    await act(() => editor(_fixture).commands.redo());
    await advance();
    expect(current).toBe(split);
  });

  it.for([0, 1] as const)(
    "splits repeated live list item %i with exact undo and redo",
    async (itemIndex, testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await mount(
        _fixture,
        "\\begin{itemize}\r\n\\item Same words\r\n  \\item Same words\r\n\\end{itemize}",
      );
      const original = current;
      const positions: number[] = [];
      editor(_fixture).state.doc.descendants((node, position) => {
        if (node.isText && node.text === "Same words") positions.push(position + 4);
      });
      expect(positions).toHaveLength(2);
      await act(() => {
        editor(_fixture).commands.setTextSelection(positions[itemIndex]!);
        editor(_fixture).commands.splitListItem("listItem");
      });
      await advance();
      const split = current;
      expect(split).not.toBe(original);
      const list = projectLatexVisualDocument(split).content.content![0]!;
      expect(
        list.content!.map((item) =>
          item.content![0]!.content!.map((node) => node.text ?? "").join(""),
        ),
      ).toEqual(
        itemIndex === 0 ? ["Same", "words", "Same words"] : ["Same words", "Same", "words"],
      );
      await act(() => editor(_fixture).commands.undo());
      await advance();
      expect(current).toBe(original);
      await act(() => editor(_fixture).commands.redo());
      await advance();
      expect(current).toBe(split);
    },
  );

  it("keeps distinct native undo events when two nonadjacent typing edits coalesce", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "First words.\n\nSecond words.");
    const original = current;
    let first = -1;
    let second = -1;
    editor(_fixture).state.doc.descendants((node, position) => {
      if (node.isText && node.text === "First words.") first = position;
      if (node.isText && node.text === "Second words.") second = position;
    });
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    const expected = original
      .replace("First words.", "A First words.")
      .replace("Second words.", "B Second words.");
    const published = nextWriteReceipt(_fixture, (source) => source === expected);
    await act(() => {
      editor(_fixture).commands.setTextSelection(first);
      editor(_fixture).commands.insertContent("A ");
      editor(_fixture).commands.setTextSelection(second + 2);
      editor(_fixture).commands.insertContent("B ");
    });
    await settleTyping(published);
    expect(current).toBe(
      original
        .replace("First words.", "A First words.")
        .replace("Second words.", "B Second words."),
    );
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original.replace("First words.", "A First words."));
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original);
  });

  it("keeps separate native undo events when composition postpones their publication", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "First words.\n\nSecond words.");
    const original = current;
    let first = -1;
    let second = -1;
    editor(_fixture).state.doc.descendants((node, position) => {
      if (node.isText && node.text === "First words.") first = position;
      if (node.isText && node.text === "Second words.") second = position;
    });
    const expected = original
      .replace("First words.", "A First words.")
      .replace("Second words.", "B Second words.");
    const published = nextWriteReceipt(_fixture, (source) => source === expected);
    await act(() => {
      editor(_fixture).view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      expect(editor(_fixture).view.composing).toBe(true);
      editor(_fixture).commands.setTextSelection(first);
      editor(_fixture).commands.insertContent("A ");
      editor(_fixture).commands.setTextSelection(second + 2);
      editor(_fixture).commands.insertContent("B ");
      expect(current).toBe(original);
      editor(_fixture).view.dom.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
    });
    await settleTyping(published);
    expect(current).toBe(
      original
        .replace("First words.", "A First words.")
        .replace("Second words.", "B Second words."),
    );
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original.replace("First words.", "A First words."));
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original);
  });

  it("splits the correct native list item immediately after typing shifts its range", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\begin{itemize}\r\n  \\item First words\r\n\r\n  \\item Second words\r\n\\end{itemize}",
    );
    const original = current;
    let first = -1;
    let second = -1;
    editor(_fixture).state.doc.descendants((node, position) => {
      if (node.isText && node.text === "First words") first = position;
      if (node.isText && node.text === "Second words") second = position + "Second".length;
    });
    await act(() => {
      editor(_fixture).commands.setTextSelection(first);
      editor(_fixture).commands.insertContent("A long ");
      editor(_fixture).commands.setTextSelection(second + "A long ".length);
      expect(editor(_fixture).commands.splitListItem("listItem")).toBe(true);
    });
    await advance();
    const split = current;
    const nativeList = projectLatexVisualDocument(split).content.content![0]!;
    expect(
      nativeList.content!.map((item) =>
        item.content![0]!.content!.map((node) => node.text ?? "").join(""),
      ),
    ).toEqual(["A long First words", "Second", "words"]);
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original.replace("First words", "A long First words"));
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original);
    await act(() => editor(_fixture).commands.redo());
    await advance();
    await act(() => editor(_fixture).commands.redo());
    await advance();
    expect(current).toBe(split);
  });

  it("does not write on mount; spaces, Enter and undo save real source", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    expect(writes).not.toHaveBeenCalled();
    let published = nextWriteReceipt(_fixture, (source) => source === tex("Hello world"));
    await act(async () => {
      editor(_fixture).commands.setTextSelection(6);
      editor(_fixture).commands.insertContent(" world");
    });
    await settleTyping(published);
    expect(current).toBe(tex("Hello world"));
    await act(async () => {
      editor(_fixture).commands.splitBlock();
    });
    await advance();
    expect(current).toContain("Hello world\n\n\\par");
    published = nextWriteReceipt(_fixture, (source) => source.includes("Hello world\n\nNext"));
    await act(async () => {
      editor(_fixture).commands.insertContent("Next");
    });
    await settleTyping(published);
    expect(current).toContain("Hello world\n\nNext");
    await act(async () => {
      editor(_fixture).commands.undo();
    });
    await advance();
    expect(current).not.toContain("Next");
    await act(async () => {
      editor(_fixture).commands.redo();
    });
    await advance();
    expect(current).toContain("Next");
  });

  it("applies toolbar formatting and inserts math without a build", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await act(async () => {
      editor(_fixture).commands.setTextSelection({ from: 1, to: 6 });
      editor(_fixture).commands.toggleBold();
    });
    await advance();
    expect(current).toContain("\\textbf{Hello}");
    await act(async () => {
      editor(_fixture).commands.setTextSelection(6);
      editor(_fixture).commands.insertContent({ type: "latexInlineMath", attrs: { tex: "x^2" } });
    });
    await advance();
    expect(current).toContain("\\(x^2\\)");
  });

  it("inserts a source-backed explicit page break", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "First page");
    await insertMenuItem(_fixture, "Page break");
    expect(current).toContain("\\newpage");
    expect(
      editor(_fixture)
        .getJSON()
        .content?.some((node) => node.attrs?.kind === "pagebreak"),
    ).toBe(true);
  });

  it("zooms the fixed paper without changing LaTeX", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Stable page");
    const scroll = _fixture.container.querySelector<HTMLElement>(".scient-latex-visual-scroll")!;
    const stage = _fixture.container.querySelector<HTMLElement>(".scient-latex-page-stage")!;
    _fixture.container.style.width = `${_fixture.container.clientWidth + stage.offsetWidth + PDF_FIT_WIDTH_PADDING - scroll.clientWidth}px`;
    await expect.poll(() => scroll.clientWidth - PDF_FIT_WIDTH_PADDING).toBe(stage.offsetWidth);
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>(".scient-pdf-zoom-label")!.click(),
    );
    await act(() =>
      _fixture.container
        .querySelector<HTMLButtonElement>('button[aria-label^="Zoom out"]')!
        .click(),
    );
    expect(
      _fixture.container
        .querySelector<HTMLElement>(".scient-latex-page-stage")
        ?.style.getPropertyValue("transform"),
    ).toBe("scale(0.95)");
    expect(writes).not.toHaveBeenCalled();
  });

  it("shows editable front matter and marks only starred headings as unnumbered", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
      const owner = useLatexVisualTestOwner(source);
      return (
        <LatexVisualEditor
          draftKey="synthetic-front-matter-test"
          fileRevision="r1"
          source={source}
          sourceSnapshot={owner.snapshot}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onEdit={(request) => {
            const outcome = owner.edit(request, current === request.edit.source);
            if (!outcome.accepted) return outcome;
            current = outcome.snapshot.source;
            setSource(current);
            return outcome;
          }}
        />
      );
    }
    await renderMountedEditor(_fixture, <Harness />);
    const title = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Document title']",
    )!;
    expect(title.value).toBe("Research Guide");
    expect(_fixture.container.querySelector("h1")?.hasAttribute("data-latex-unnumbered")).toBe(
      false,
    );
    expect(_fixture.container.querySelector("h2")?.hasAttribute("data-latex-unnumbered")).toBe(
      true,
    );
    await setField(title, "A Better Guide");
    expect(current).toContain("\\title{A Better Guide}");
    const author = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Document author']",
    )!;
    await setField(author, "");
    expect(current).toContain("\\author{}");
    expect(editor(_fixture).state.doc.firstChild!.attrs.authorEnabled).toBe(false);
    const date = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Document date']",
    )!;
    await setField(date, "");
    expect(current).toContain("\\date{}");
    expect(_fixture.container.querySelector("textarea[aria-label='Document date']")).toBeNull();
  });

  it("opens formula source without replacing the rendered equation", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Inline $x^2$ here");
    await selectKind(_fixture, "latexInlineMath");
    const equation = _fixture.container.querySelector(
      ".scient-latex-visual-inline-math",
    ) as HTMLElement;
    await act(async () => equation.click());
    const sourceButton = document.body.querySelector<HTMLButtonElement>(
      "[aria-label='Edit formula as LaTeX']",
    )!;
    expect(sourceButton.getAttribute("aria-expanded")).toBe("false");
    await act(async () => sourceButton.click());
    const source = _fixture.container.querySelector(
      "textarea[aria-label='LaTeX formula code']",
    ) as HTMLTextAreaElement;
    expect(source.value).toBe("x^2");
    expect(sourceButton.getAttribute("aria-expanded")).toBe("true");
    expect(_fixture.container.textContent).toContain("x^2");
    expect(document.body.querySelector("[aria-label='Math tools']")).not.toBeNull();
    expect(document.body.querySelector("[aria-label='Edit formula as LaTeX']")).not.toBeNull();
    await setField(source, "y^3");
    expect(current).toContain("$y^3$");
    const resizeHandle = _fixture.container.querySelector<HTMLDivElement>(
      '[aria-label="Resize LaTeX code editor"]',
    )!;
    await act(() => {
      resizeHandle.focus();
      resizeHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(
      _fixture.container.querySelector("textarea[aria-label='LaTeX formula code']"),
    ).toBeNull();
    expect(sourceButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the selected equation and its source editor through whole footer clicks", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(
        _fixture,
        "\\begin{equation}\nx^2\n\\end{equation}\n\nOther text.",
        "",
        headerSlot,
      );
      await selectKind(_fixture, "latexDisplayMath");
      await act(() =>
        _fixture.container.querySelector<HTMLElement>(".scient-latex-visual-display-math")!.click(),
      );
      await act(() =>
        _fixture.container
          .querySelector<HTMLButtonElement>('[aria-label="Edit formula as LaTeX"]')!
          .click(),
      );
      const selected = editor(_fixture).state.selection.toJSON();
      const footer = _fixture.container.querySelector<HTMLElement>(".scient-document-footer")!;
      for (const selector of [
        ".scient-document-footer-options",
        ".scient-document-footer-status",
        ".scient-document-footer-count",
      ]) {
        const target = footer.querySelector<HTMLElement>(selector)!;
        expect(target).not.toBeNull();
        await act(() => target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
        expect(
          _fixture.container.querySelector('textarea[aria-label="LaTeX formula code"]'),
        ).not.toBeNull();
        expect(editor(_fixture).state.selection.toJSON()).toEqual(selected);
      }
      await act(() => footer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      expect(_fixture.container.querySelector('[aria-label="Math tools"]')).not.toBeNull();
      expect(writes).not.toHaveBeenCalled();
      await act(() =>
        _fixture.container
          .querySelector(".ProseMirror p")!
          .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
      );
      expect(
        _fixture.container.querySelector('textarea[aria-label="LaTeX formula code"]'),
      ).toBeNull();
      expect(_fixture.container.querySelector('[aria-label="Math tools"]')).toBeNull();
    } finally {
      headerSlot.remove();
    }
  });

  it("saves a label on blur after a footer click while keeping its equation controls", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(_fixture, "\\begin{equation}\nx^2\n\\end{equation}", "", headerSlot);
      await selectKind(_fixture, "latexDisplayMath");
      const field = await focusReferenceLabel(_fixture, "Equation reference label");
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          field,
          "eq:new",
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(current).not.toContain("\\label{eq:new}");
      await act(() => {
        _fixture.container
          .querySelector(".scient-document-footer-count")!
          .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        field.blur();
      });
      await advance();
      expect(current).toContain("\\label{eq:new}");
      expect(_fixture.container.querySelector('[aria-label="Math tools"]')).not.toBeNull();
      expect(editor(_fixture).state.selection.$from.nodeAfter?.type.name).toBe("latexDisplayMath");
    } finally {
      headerSlot.remove();
    }
  });

  it("adds an equation label in its visible footer field without losing the selected equation", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\begin{equation}\nx^2\n\\end{equation}");
    await selectKind(_fixture, "latexDisplayMath");
    await act(() =>
      _fixture.container.querySelector<HTMLElement>(".scient-latex-visual-display-math")!.click(),
    );
    const field = _fixture.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Equation reference label"]',
    )!;
    expect(field).not.toBeNull();
    expect(field.placeholder).toBe("Add label");
    await act(() =>
      _fixture.container
        .querySelector<HTMLButtonElement>('[aria-label="Edit formula as LaTeX"]')!
        .click(),
    );
    expect(
      _fixture.container.querySelector('textarea[aria-label="LaTeX formula code"]'),
    ).not.toBeNull();
    await act(() => field.focus());
    expect(
      _fixture.container.querySelector('textarea[aria-label="LaTeX formula code"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("");
    await setField(field, "eq:new");
    expect(current).toContain("\\label{eq:new}");
    expect(editor(_fixture).state.selection.$from.nodeAfter?.type.name).toBe("latexDisplayMath");
    expect(_fixture.container.querySelector('[aria-label="Math tools"]')).not.toBeNull();
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).not.toContain("\\label{eq:new}");
    expect(field.value).toBe("");
  });

  it("retains invalid equation label edits on blur and cancels them with Escape", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\begin{equation}\nx^2\\label{eq:first}\n\\end{equation}\n\n\\begin{equation}\ny^2\\label{eq:second}\n\\end{equation}",
    );
    await selectKind(_fixture, "latexDisplayMath");
    await act(() =>
      _fixture.container.querySelector<HTMLElement>(".scient-latex-visual-display-math")!.click(),
    );
    const field = () =>
      _fixture.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Equation reference label"]',
      )!;
    const saved = current;
    await setField(field(), "eq:second");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().value).toBe("eq:second");
    expect(current).toBe(saved);
    await act(() => {
      field().focus();
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(field().value).toBe("eq:first");
    expect(field().getAttribute("aria-invalid")).toBe("false");
    expect(field().hasAttribute("data-local-draft")).toBe(false);
    expect(current).toBe(saved);
    await setField(field(), "bad label");
    expect(current).toBe(saved);
    await act(() => {
      field().focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        "eq:summary",
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await advance();
    expect(current).toContain("\\label{eq:summary}");
    expect(field().getAttribute("aria-invalid")).toBe("false");
  });

  it("changes a display wrapper from the compact source popover", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\[\nx^2\n\\]");
    await selectKind(_fixture, "latexDisplayMath");
    const equation = _fixture.container.querySelector(
      ".scient-latex-visual-display-math",
    ) as HTMLElement;
    await act(async () => equation.click());
    await act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Math tools"] [data-latex-number-toggle]')!
        .click(),
    );
    await advance();
    expect(current).toContain("\\begin{equation}\nx^2\n\\end{equation}");
  });

  it("changes centered math to a standalone inline formula", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\[\nx^2\n\\]");
    await selectKind(_fixture, "latexDisplayMath");
    const equation = _fixture.container.querySelector(
      ".scient-latex-visual-display-math",
    ) as HTMLElement;
    await act(async () => equation.click());
    const math = _fixture.container.querySelector<HTMLButtonElement>(
      '[aria-label="Writing tools"] button[aria-label="Math"]',
    )!;
    await act(() => math.click());
    const inline = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.trim() === "Inline math",
    )!;
    await act(() => inline.click());
    await advance();
    expect(current).toBe(tex("\\(x^2\\)"));
  });

  it("offers bounded command and environment completions", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(mathSourceCompletions("\\[\n\\fra", 7)[0]).toMatchObject({
      label: "\\frac",
      replacement: "\\frac{}{}",
    });
    expect(mathSourceCompletions("\\[\n\\begin{ali", 13)[0]).toMatchObject({
      label: "\\begin{align}",
      replacement: "\\begin{align}\n\n\\end{align}",
    });
  });

  it("converts a completely typed supported math environment", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Replace me");
    const matrix = "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}";
    const typingPublished = nextWriteReceipt(_fixture);
    const published = nextWriteReceipt(_fixture, (source) =>
      source.includes(`\\[\n${matrix}\n\\]`),
    );
    await act(async () => {
      editor(_fixture).commands.selectAll();
      editor(_fixture).commands.insertContent(matrix);
    });
    await settleTyping(typingPublished);
    await advance();
    await published();
    expect(editor(_fixture).getJSON().content?.[0]?.type).toBe("latexDisplayMath");
    expect(current).toContain(`\\[\n${matrix}\n\\]`);
  });

  it("edits prose and inserts both kinds of math inside an abstract", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\begin{abstract}\nAbstract text.\n\\end{abstract}");
    const host = _fixture.container.querySelector('[aria-label="Abstract"]');
    expect(host?.closest('[contenteditable="false"]')).toBeNull();
    let position = 0;
    editor(_fixture).state.doc.descendants((node, at) => {
      if (node.type.name === "paragraph") position = at + 1;
    });
    await act(() =>
      editor(_fixture)
        .chain()
        .setTextSelection(position)
        .insertContent({ type: "latexInlineMath", attrs: { tex: "x", wrapper: "paren" } })
        .run(),
    );
    await act(() =>
      editor(_fixture).commands.insertContentAt(
        editor(_fixture).state.doc.firstChild!.nodeSize - 1,
        {
          type: "latexDisplayMath",
          attrs: { tex: "a=b", wrapper: "bracket" },
        },
      ),
    );
    await advance();
    expect(current).toContain("\\(x\\)Abstract text.");
    expect(current).toMatch(/\\\[\s*a=b\s*\\\]/u);
    expect(current.match(/\\begin\{abstract\}/g)).toHaveLength(1);
    expect(projectLatexVisualDocument(current).rawBlocks).toBe(0);
  });

  it.for([
    ["bold", 0, "textbf"],
    ["italic", 1, "textit"],
    ["code", 2, "texttt"],
  ] as const)(
    "follows the cell caret for %s availability, checked state and menu actions",
    async ([mark, index, command], testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await mount(
        _fixture,
        `\\begin{tabular}{ll}\n\\${command}{Marked} Plain & Other\\\\\n\\end{tabular}`,
      );
      await selectKind(_fixture, "table");
      const field = _fixture.container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
      const inner = (field as HTMLElement & { editor: Editor }).editor;
      await focusCellEditor(_fixture, inner);
      await act(() => inner.commands.setTextSelection({ from: 1, to: 7 }));
      let items = await openCellFormatting(_fixture);
      expect(items.every((item) => item.getAttribute("aria-disabled") !== "true")).toBe(true);
      expect(items[index]!.getAttribute("aria-checked")).toBe("true");
      await act(() => items[index]!.click());
      expect(inner.isActive(mark)).toBe(false);
      await advance();
      expect(current).not.toContain(`\\${command}{Marked}`);
      await focusCellEditor(_fixture, inner);
      await act(() => inner.commands.setTextSelection({ from: 8, to: 13 }));
      items = await openCellFormatting(_fixture);
      expect(items[index]!.getAttribute("aria-checked")).toBe("false");
      await act(() => items[index]!.click());
      expect(inner.isActive(mark)).toBe(true);
      await advance();
      expect(current).toContain(`Marked \\${mark === "italic" ? "emph" : command}{Plain}`);
      // A different cell has its own marks, even though the outer selection stays a table.
      const other = (
        _fixture.container.querySelector('[data-table-cell="0-1"]') as HTMLElement & {
          editor: Editor;
        }
      ).editor;
      await focusCellEditor(_fixture, other);
      await act(() => other.commands.selectAll());
      items = await openCellFormatting(_fixture);
      expect(items[index]!.getAttribute("aria-checked")).toBe("false");
    },
  );

  it.for(["MacIntel", "Win32"] as const)(
    "respects default, disabled and remapped cell formatting shortcuts on %s",
    async (platform, testContext) => {
      await using _fixture = _createFixture(testContext);
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      reloadKeyboardPreferences();
      await mount(_fixture, "\\begin{tabular}{l}\nCell text\\\\\n\\end{tabular}");
      const field = _fixture.container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
      const inner = (field as HTMLElement & { editor: Editor }).editor;
      await focusCellEditor(_fixture, inner);
      await act(() => inner.commands.selectAll());
      const press = async (key: string, shiftKey = false) =>
        await act(() =>
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
  );

  it("counts a cell text selection in the footer and follows cell selection changes", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const headerSlot = document.createElement("div");
    document.body.append(headerSlot);
    try {
      await mount(
        _fixture,
        "\\begin{tabular}{ll}\nHello brave $x$ world & Other\\\\\n\\end{tabular}",
        "",
        headerSlot,
      );
      const inner = (
        _fixture.container.querySelector('[data-table-cell="0-0"]') as HTMLElement & {
          editor: Editor;
        }
      ).editor;
      await focusCellEditor(_fixture, inner);
      await act(() => inner.commands.setTextSelection({ from: 1, to: 12 }));
      const footer = _fixture.container.querySelector(".scient-document-footer-count")!;
      expect(footer.textContent).toBe("2 of 4 words");
      await act(() => inner.commands.setTextSelection({ from: 1, to: 6 }));
      expect(footer.textContent).toBe("1 of 4 words");
      await act(() => inner.commands.setTextSelection(1));
      expect(footer.textContent).toBe("4 words");
    } finally {
      headerSlot.remove();
    }
  });

  it("routes the Math menu to the caret inside a table cell and shares document undo", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\begin{tabular}{ll}\nBefore after & Keep\\\\\n\\end{tabular}");
    const field = _fixture.container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    expect(inner).toBeDefined();
    await focusCellEditor(_fixture, inner);
    await act(() => inner.commands.setTextSelection(8));
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Math"]')!.click(),
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
    await advance();
    expect(current).toContain("Before \\(q^2\\)after & Keep");
    expect(editor(_fixture).state.doc.childCount).toBe(1);
    expect(projectLatexVisualDocument(current).rawBlocks).toBe(0);
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
  });

  it("expands a cell's Select All to the whole table and restores a deleted table with undo", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\begin{tabular}{ll}\nOne & Two\\\\\n\\end{tabular}");
    const before = current;
    const field = _fixture.container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    await focusCellEditor(_fixture, inner);
    await act(() => inner.commands.selectAll());
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    // The cell's complete document is a scope before the table's cell range.
    expect(inner.state.selection.from).toBe(0);
    expect(inner.state.selection.to).toBe(inner.state.doc.content.size);
    expect(current).toBe(before);
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    const cell = _fixture.container.querySelector<HTMLElement>('[data-table-selection="cells"]');
    expect(cell).not.toBeNull();
    await act(() =>
      cell!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    const table = _fixture.container.querySelector<HTMLElement>('[data-table-selection="whole"]');
    expect(table).not.toBeNull();
    expect(current).toBe(before);
    await act(() =>
      table!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      ),
    );
    await advance();
    expect(current).not.toContain("\\begin{tabular}");
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
    expect(current).toContain("One & Two");
  });

  it("retains rapid edits in different table cells", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\begin{tabular}{ll}\nOne & Two\\\\\n\\end{tabular}");
    const fields = [..._fixture.container.querySelectorAll<HTMLElement>("[data-table-cell]")].map(
      (field) => (field as HTMLElement & { editor: Editor }).editor,
    );
    await act(() => {
      fields[0]!.chain().selectAll().insertContent("First").run();
      fields[1]!.chain().selectAll().insertContent("Second").run();
    });
    await advance();
    expect(current).toContain("First & Second");
  });

  it("clears a rectangular selection of rich cells and restores it without another table", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\begin{tabular}{ll}\nAlpha & Text $x$\\\\\nKeep & Last\\\\\n\\end{tabular}",
    );
    const field = _fixture.container.querySelector<HTMLElement>('[data-table-cell="0-0"]')!;
    const inner = (field as HTMLElement & { editor: Editor }).editor;
    await focusCellEditor(_fixture, inner);
    await act(() => inner.commands.setTextSelection(inner.state.doc.content.size - 1));
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
    const table = _fixture.container.querySelector<HTMLElement>('[data-table-selection="cells"]');
    expect(table).not.toBeNull();
    await act(() =>
      table!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
      ),
    );
    expect(editor(_fixture).state.doc.firstChild!.attrs.rows).toEqual([
      ["", ""],
      ["Keep", "Last"],
    ]);
    await act(() => editor(_fixture).commands.undo());
    expect(editor(_fixture).state.doc.firstChild!.attrs.rows).toEqual([
      ["Alpha", "Text $x$"],
      ["Keep", "Last"],
    ]);
    await advance();
    expect(current.match(/\\begin\{tabular\}/g)).toHaveLength(1);
    await focusCellEditor(_fixture, inner);
    await act(() => inner.commands.setTextSelection(inner.state.doc.content.size - 1));
    expect(_fixture.container.querySelector("[data-table-selection]")).toBeNull();
    expect(inner.state.selection.empty).toBe(true);
  });

  it("edits description and table structures without opening source", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      `\\begin{description}[style=nextline]
\\item[Algorithms] Design and prove algorithms.
\\item[Complexity] Study computational limits.
\\end{description}

\\begin{table}
\\caption{Research options.}
\\begin{tabular}{ll}
Area & Evidence \\\\
Theory & Proofs \\\\
\\end{tabular}
\\end{table}`,
    );
    expect(_fixture.container.querySelectorAll(".scient-latex-rich-preview")).toHaveLength(2);
    expect(_fixture.container.querySelector(".scient-latex-visual-raw")).toBeNull();
    const descriptionLabel = _fixture.container.querySelector<HTMLInputElement>(
      "input[aria-label='Description item 1 label']",
    )!;
    const descriptionBody = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Description item 1 body']",
    )!;
    expect(descriptionLabel.value).toBe("Algorithms");
    expect(descriptionBody.value).toBe("Design and prove algorithms.");
    await setField(descriptionLabel, "Algorithms & proofs");
    await setField(descriptionBody, "Design verified algorithms.");
    expect(current).toContain("\\item[Algorithms \\& proofs] Design verified algorithms.");
    await selectKind(_fixture, "table");
    const caption = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Table caption']",
    )!;
    expect(caption.value).toBe("Research options.");
    await setField(caption, "Research areas & evidence.");
    expect(current).toContain("\\caption{Research areas \\& evidence.}");
    const evidence = _fixture.container.querySelector<HTMLElement>(
      "[contenteditable][aria-label='Table row 2 column 2']",
    )!;
    const fieldEditor = (evidence as HTMLElement & { editor: Editor }).editor;
    await focusCellEditor(_fixture, fieldEditor);
    await act(() => fieldEditor.chain().selectAll().insertContent("Verified proofs").run());
    await advance();
    expect(current).toContain("Theory & Verified proofs");
    expect(
      _fixture.container.querySelector("[contenteditable][aria-label='Table row 2 column 2']"),
    ).toBe(evidence);
    await contextMenuAction(_fixture, "Rows & columns", "Rows", "Insert below");
    expect(current).toContain(" &  \\\\");
    expect(
      _fixture.container.querySelector("[contenteditable][aria-label='Table row 3 column 1']"),
    ).not.toBeNull();
    await contextMenuAction(_fixture, "Rows & columns", "Columns", "Insert right");
    expect(
      _fixture.container.querySelector("[contenteditable][aria-label='Table row 1 column 3']"),
    ).not.toBeNull();
    await contextMenuAction(_fixture, "Appearance", "Rules", "Full grid");
    expect(current).toContain("\\hline");
    expect(current).toContain("\\caption{Research areas \\& evidence.}");
    await selectKind(_fixture, "table");
    const reference = await focusReferenceLabel(_fixture, "Table reference label");
    await setField(reference, "tab:research");
    expect(current).toContain("\\label{tab:research}");
  });

  it("inserts a table from the document toolbar picker", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Before");
    const original = current;
    await insertMenuItem(_fixture, "Table");
    const insert = document.body.querySelector<HTMLElement>(
      "[data-scient-table-size-cell-row='3'][data-scient-table-size-cell-column='4']",
    )!;
    await act(async () => insert.click());
    await advance();
    expect(current).toContain("\\begin{table}[htbp]");
    expect(current).toContain("\\begin{tabular}");
    expect(
      _fixture.container.querySelector("[contenteditable][aria-label='Table row 3 column 4']"),
    ).not.toBeNull();
    const inserted = current;
    await act(() => editor(_fixture).commands.undo());
    await advance();
    expect(current).toBe(original);
    expect(
      _fixture.container.querySelector("[contenteditable][aria-label='Table row 3 column 4']"),
    ).toBeNull();
    await act(() => editor(_fixture).commands.redo());
    await advance();
    expect(current).toBe(inserted);
    expect(
      _fixture.container.querySelector("[contenteditable][aria-label='Table row 3 column 4']"),
    ).not.toBeNull();
  });

  it("inserts and edits theorem-like scientific statements", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Before");
    await insertMenuItem(_fixture, "Claim");
    const position = await selectKind(_fixture, "latexScientific");
    await act(() =>
      _fixture.container
        .querySelector<HTMLButtonElement>('button[aria-label="Add statement title"]')!
        .click(),
    );
    const title = _fixture.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Scientific statement title']",
    )!;
    await setField(title, "Central claim");
    const published = nextWriteReceipt(_fixture, (source) =>
      source.includes("The visual source remains authoritative."),
    );
    await act(() => {
      const statement = editor(_fixture).state.doc.nodeAt(position)!;
      editor(_fixture).commands.setTextSelection({
        from: position + 2,
        to: position + statement.nodeSize - 2,
      });
      editor(_fixture).commands.insertContent("The visual source remains authoritative.");
    });
    await settleTyping(published);
    expect(current).toContain("\\newtheorem{claim}{Claim}");
    expect(current).toContain("\\begin{claim}[Central claim]");
    expect(current).toContain("The visual source remains authoritative.");
  });

  it("inserts, edits and deletes a visual figure", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Before");
    const figure = latexFigureSource({
      documentPath: "main.tex",
      assetPath: "images/image.png",
      source: current,
    });
    await act(() =>
      editor(_fixture).commands.insertContent(
        projectLatexVisualDocument(tex(figure)).content.content!,
      ),
    );
    await advance();
    expect(current).toContain("\\usepackage{graphicx}");
    const position = await selectKind(_fixture, "figure");
    await act(() =>
      editor(_fixture).view.dispatch(
        editor(_fixture).state.tr.setNodeMarkup(position, undefined, {
          ...editor(_fixture).state.doc.nodeAt(position)!.attrs,
          path: "images/result.png",
        }),
      ),
    );
    await advance();
    expect(current).toContain("\\includegraphics[width=0.8\\textwidth]{images/result.png}");
    await contextMenuAction(_fixture, "Figure appearance", null, "Delete figure");
    expect(current).not.toContain("\\begin{figure}");
  });

  it("inserts a source-backed reference from the writing toolbar", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Target \\label{sec:target}");
    await insertMenuItem(_fixture, "Cross-reference");
    const key = document.body.querySelector<HTMLInputElement>(
      ".scient-writing-reference-key input",
    )!;
    await setField(key, "sec:target");
    await act(() =>
      key.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await advance();
    expect(current).toContain("\\ref{sec:target}");
  });

  it("provides a compact writing toolbar and collapsed document outline", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "\\section{Methods}\nThe method remains editable.");
    expect(_fixture.container.querySelector("button[aria-label='Insert']")).not.toBeNull();
    expect(_fixture.container.querySelector("[aria-label='Document navigation']")).toBeNull();
    const outline = _fixture.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Show Document sidebar']",
    )!;
    await act(() => outline.click());
    expect(
      _fixture.container.querySelector("[aria-label='Document navigation']")?.textContent,
    ).toContain("Methods");
  });

  it("never inserts a printed title block unless the writer asks for one", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Body", "\\title{Existing metadata}\n");
    const original = current;
    await act(() =>
      _fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Document"]')!.click(),
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

  it("rejects a destructive transaction spanning protected source", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "Hello\n\n\\custom{keep}");
    const before = current;
    const beforeDocument = editor(_fixture).state.doc;
    await act(async () => {
      editor(_fixture).commands.selectAll();
      editor(_fixture).commands.deleteSelection();
    });
    expect(current).toBe(before);
    expect(editor(_fixture).state.doc).toBe(beforeDocument);
    expect(_fixture.container.textContent).toContain("This edit is unavailable in Visual");
  });

  it("discards obsolete undo history when external source is adopted", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const renderEditor = (source: string) => {
      const owner = createLatexVisualTestOwner(source);
      return (
        <LatexVisualEditor
          draftKey="synthetic-editor-test"
          fileRevision="external-test"
          source={source}
          sourceSnapshot={owner.snapshot}
          disabled={false}
          onEdit={(request) => {
            const outcome = owner.edit(request);
            if (outcome.accepted) {
              writes(request.edit.source, outcome.snapshot.source);
              publishWriteReceipt(outcome.snapshot.source);
            }
            return outcome;
          }}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
        />
      );
    };
    await renderMountedEditor(_fixture, renderEditor(tex("Hello")));
    const published = nextWriteReceipt(_fixture, (source) => source === tex("Old Hello"));
    await act(async () => {
      editor(_fixture).commands.insertContent("Old ");
    });
    await settleTyping(published);
    expect(editor(_fixture).can().undo()).toBe(true);
    const external = tex("External replacement");
    await renderMountedEditor(_fixture, renderEditor(external));
    expect(editor(_fixture).getText()).toBe("External replacement");
    expect(editor(_fixture).can().undo()).toBe(false);
  });

  it("keeps the body caret after an external source change so typing cannot replace the title", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const titled = (body: string) =>
      `\\documentclass{article}\n\\title{Keep this title}\n\\begin{document}\n\\maketitle\n\n${body}\n\\end{document}\n`;
    const renderEditor = (source: string) => {
      const owner = createLatexVisualTestOwner(source);
      return (
        <LatexVisualEditor
          draftKey="synthetic-title-selection-test"
          fileRevision="external-title-test"
          source={source}
          sourceSnapshot={owner.snapshot}
          disabled={false}
          onEdit={(request) => {
            const outcome = owner.edit(request);
            if (outcome.accepted) {
              writes(request.edit.source, outcome.snapshot.source);
              publishWriteReceipt(outcome.snapshot.source);
            }
            return outcome;
          }}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
        />
      );
    };
    await renderMountedEditor(_fixture, renderEditor(titled("First paragraph")));
    let bodyPosition = -1;
    editor(_fixture).state.doc.descendants((node, position) => {
      if (node.isText && node.text?.includes("First paragraph")) bodyPosition = position + 5;
    });
    expect(bodyPosition).toBeGreaterThan(0);
    await act(async () => editor(_fixture).commands.setTextSelection(bodyPosition));

    const external = titled("Changed paragraph");
    await renderMountedEditor(_fixture, renderEditor(external));
    expect(editor(_fixture).getText()).toContain("Changed paragraph");
    expect(editor(_fixture).state.selection.empty).toBe(true);
    expect(editor(_fixture).state.selection.$from.parent.type.name).toBe("paragraph");
    const published = nextWriteReceipt(
      _fixture,
      (source) => source === titled("ChangedX paragraph"),
    );
    await act(async () => editor(_fixture).commands.insertContent("X"));
    await settleTyping(published);
    expect(writes).toHaveBeenCalledWith(external, expect.stringContaining("\\maketitle"));
    expect(writes.mock.lastCall?.[1]).toContain("\\title{Keep this title}");
    expect(writes.mock.lastCall?.[1]).toContain("ChangedX paragraph");
  });

  it("edits labelled equation math while retaining numbering and refusing new outer rows", async (testContext) => {
    await using _fixture = _createFixture(testContext);
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(
      _fixture,
      "\\begin{align}\n  x &= y \\label{eq:first} \\\\\n  a &= b \\notag\n\\end{align}",
    );
    const before = current;
    expect(editor(_fixture).state.doc.firstChild?.type.name).toBe("latexDisplayMath");
    await act(async () => {
      editor(_fixture).commands.setNodeSelection(0);
      editor(_fixture).commands.updateAttributes("latexDisplayMath", {
        tex: String(editor(_fixture).state.doc.firstChild!.attrs.tex).replace("x &=", "z &="),
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(current).toBe(before.replace("x &=", "z &="));
    const saved = current;
    const math = editor(_fixture).state.doc.firstChild!.attrs.tex;
    await act(async () => {
      editor(_fixture).commands.updateAttributes("latexDisplayMath", { tex: math + " \\\\ q = r" });
    });
    expect(editor(_fixture).state.doc.firstChild!.attrs.tex).toBe(math);
    expect(current).toBe(saved);
  });
});

function _createFixture(context: TestContext) {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    context,
    restoreFonts: () => {},

    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    clock: undefined as Disposable | undefined,
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
