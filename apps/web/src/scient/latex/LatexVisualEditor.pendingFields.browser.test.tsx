import "../../index.css";
import {
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";
import { waitForTestReceipt } from "../../../test/receipt";
import type { Editor } from "@tiptap/core";
import { useImperativeHandle, type Ref } from "react";

import { describe, expect, it, vi, type TestContext } from "vite-plus/test";

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
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Failure", refresh: vi.fn() }),
}));
import { LatexVisualEditor } from "./LatexVisualEditor";
import {
  createLatexVisualTestOwner,
  readMountedLatexVisualTestEditor,
  stubLatexReadingFonts,
  type LatexVisualTestOwner,
} from "./latexVisualTestOwner";
import { clearVisualDraft } from "./visualDrafts";
import { clearTypingDraft, readTypingDraft } from "./visualTyping";
import { readStoredRecovery } from "./visualRecovery";
import { projectLatexVisualDocument } from "./latexVisualDocument";

const KEY = "pending-field-source-owner";
const SOURCE =
  "\\documentclass{article}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\begin{theorem}[Original title]\nBody.\n\\end{theorem}\n\\end{document}\n";

describe("pending fields across outside document changes", () => {
  const writes = vi.fn();
  const pending = vi.fn();
  const acceptedReceipts = new Map<string, () => void>();
  const nextAcceptedSource = (_fixture: _Fixture, context: TestContext, source: string) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    acceptedReceipts.set(source, resolve);
    const dispose = () => {
      if (acceptedReceipts.get(source) === resolve) acceptedReceipts.delete(source);
    };
    _fixture.cleanup.defer(dispose);
    return () => waitForTestReceipt(context.signal, promise, dispose);
  };

  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.restoreFonts = stubLatexReadingFonts();
    writes.mockReset();
    pending.mockReset();
    localStorage.clear();
    _fixture.shown = SOURCE;
    _fixture.owner = createLatexVisualTestOwner(_fixture.shown);
    _fixture.revision = "r1";
    _fixture.finish = null;
    _fixture.acceptWrites = true;
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    clearVisualDraft(KEY);
    clearTypingDraft(KEY);
    _fixture.restoreFonts();
    vi.unstubAllGlobals();
  }
  const render = async (_fixture: _Fixture) => {
    await _fixture.root0.rerender(
      <LatexVisualEditor
        draftKey={KEY}
        fileRevision={_fixture.revision}
        source={_fixture.shown}
        sourceSnapshot={_fixture.owner.observe(_fixture.shown)}
        disabled={false}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onLocalDraftChange={pending}
        registerFinishEditing={(callback) => {
          _fixture.finish = callback;
        }}
        onEdit={(request) => {
          writes(request.edit.source, request.edit);
          const outcome = _fixture.owner.edit(
            request,
            _fixture.acceptWrites && request.edit.source === _fixture.shown,
          );
          if (outcome.accepted) {
            _fixture.shown = outcome.snapshot.source;
            acceptedReceipts.get(_fixture.shown)?.();
            acceptedReceipts.delete(_fixture.shown);
          }
          return outcome;
        }}
      />,
    );
    await vi.waitFor(() => {
      const mounted = readMountedLatexVisualTestEditor(_fixture.container);
      expect(mounted).not.toBeNull();
      expect(mounted!.view.dom.dataset.latexLoading).not.toBe("true");
    });
    _fixture.clock ??= _fixture.cleanup.use(_fixtureFakeTimers());
  };
  const advance = async (ms: number) =>
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const editor = (_fixture: _Fixture) =>
    (_fixture.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  const field = (_fixture: _Fixture) =>
    _fixture.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Scientific statement title"]',
    )!;
  async function mount(_fixture: _Fixture) {
    await render(_fixture);
    await vi.waitFor(() => expect(_fixture.container.querySelector(".ProseMirror")).not.toBeNull());
    let position = -1;
    editor(_fixture).state.doc.descendants((node, offset) => {
      if (node.type.name === "latexScientific") position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    await act(() => editor(_fixture).commands.setNodeSelection(position));
    const title = _fixture.container.querySelector<HTMLElement>(".scient-latex-statement-title");
    expect(title).not.toBeNull();
    await act(() => title!.click());
    expect(field(_fixture)).not.toBeNull();
  }
  async function typeTitle(_fixture: _Fixture) {
    await act(() => {
      field(_fixture).focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(_fixture),
        "Local unfinished title",
      );
      field(_fixture).dispatchEvent(new Event("input", { bubbles: true }));
      expect(pending).toHaveBeenLastCalledWith(true);
    });
    expect(writes).not.toHaveBeenCalled();
  }

  it("offers saved rich-cell drafts for review without installing them into a new projection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.shown = "\\begin{tabular}{ll}\nAlpha & Text $x$\\\\\nKeep & Last\\\\\n\\end{tabular}";
    const tableNode = projectLatexVisualDocument(_fixture.shown).content.content![0]!;
    const draftKeys = [0, 1].map(
      (column) =>
        `${KEY}:${tableNode.attrs!.sourceId}:table:cell:${tableNode.attrs!.rowIds[0]}:${tableNode.attrs!.columnIds[column]}`,
    );
    for (const [column, key] of draftKeys.entries())
      localStorage.setItem(
        `scient.latex.field:${key}`,
        JSON.stringify({
          base: tableNode.attrs!.rows[0][column],
          text: `Restored ${column}`,
        }),
      );
    await render(_fixture);
    await vi.waitFor(() =>
      expect(_fixture.container.querySelector("[data-table-cell='0-0']")).not.toBeNull(),
    );
    const fields = [0, 1].map((column) =>
      _fixture.container.querySelector<HTMLElement>(`[data-table-cell="0-${column}"]`)!,
    );
    const inner = fields.map((element) => (element as HTMLElement & { editor: Editor }).editor);
    expect(inner.map((cell) => cell.state.doc.textContent)).toEqual(["Alpha", "Text "]);
    expect(readStoredRecovery(KEY)?.text).toMatch(/^Restored [01]$/u);
    expect(writes).not.toHaveBeenCalled();
    expect(draftKeys.map((key) => localStorage.getItem(`scient.latex.field:${key}`))).toEqual([
      null,
      null,
    ]);
    await act(() => expect(_fixture.finish?.()).toBe(true));
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(inner[1]!.getJSON().content![0]!.content).toContainEqual({
      type: "latexInlineMath",
      attrs: expect.objectContaining({ tex: "x" }),
    });
    await act(() => expect(_fixture.finish?.()).toBe(true));
  });

  it.each([
    ["changes the same title", SOURCE.replace("Original title", "Agent title")],
    [
      "removes the statement",
      SOURCE.replace(/\\begin\{theorem\}[\s\S]*\\end\{theorem\}/u, "Replacement paragraph."),
    ],
    [
      "moves the statement",
      SOURCE.replace("\\begin{theorem}", "Inserted paragraph.\n\n\\begin{theorem}"),
    ],
  ])(
    "retains the draft on its original source when an outside update %s",
    async (_name, outside) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await mount(_fixture);
      await typeTitle(_fixture);
      _fixture.shown = outside!;
      await render(_fixture);
      await advance(500);
      expect(_fixture.shown).toBe(outside);
      expect(writes.mock.calls.every(([expected]) => expected === SOURCE)).toBe(true);
      const typing = readTypingDraft(KEY);
      const recovery = readStoredRecovery(KEY);
      if (typing) {
        expect(typing.baseSource).toBe(SOURCE);
        expect(JSON.stringify(typing.content)).toContain("Local unfinished title");
      } else {
        expect(recovery?.text).toContain("Local unfinished title");
      }
    },
  );

  it("keeps a composing field attached across a save acknowledgement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    const captured = _fixture.owner.snapshot.id;
    await act(() => {
      field(_fixture).focus();
      field(_fixture).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await typeTitle(_fixture);
    _fixture.revision = "r2";
    await render(_fixture);
    await advance(500);
    expect(_fixture.owner.snapshot.id).toBe(captured);
    expect(field(_fixture).value).toBe("Local unfinished title");
    expect(readStoredRecovery(KEY)).toBeNull();
    await act(() =>
      field(_fixture).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await advance(500);
    expect(_fixture.shown).toBe(SOURCE.replace("Original title", "Local unfinished title"));
    expect(_fixture.finish?.()).toBe(true);
  });

  it("retains field input when an outside A→B→A returns the same bytes under a new owner version", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await typeTitle(_fixture);
    const captured = _fixture.owner.snapshot.id;
    _fixture.shown = SOURCE.replace("Original title", "Outside title");
    await render(_fixture);
    _fixture.shown = SOURCE;
    await render(_fixture);
    await advance(500);
    expect(_fixture.owner.snapshot.id).not.toBe(captured);
    expect(_fixture.shown).toBe(SOURCE);
    expect(field(_fixture).value).toBe("Local unfinished title");
    expect(readStoredRecovery(KEY)?.text).toBe("Local unfinished title");
    expect(_fixture.finish?.()).toBe(false);
  });

  it("blocks a synchronous finish request while IME owns pending input", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await act(() => {
      field(_fixture).focus();
      field(_fixture).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(pending).toHaveBeenLastCalledWith(true);
      expect(_fixture.finish?.()).toBe(false);
    });
    await typeTitle(_fixture);
    _fixture.shown = SOURCE.replace("Original title", "Agent title");
    await render(_fixture);
    await advance(500);
    expect(writes).not.toHaveBeenCalled();
    expect(field(_fixture).value).toBe("Local unfinished title");
    await act(() =>
      field(_fixture).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await advance(500);
    expect(_fixture.shown).toContain("Agent title");
    expect(readStoredRecovery(KEY)?.text).toBe("Local unfinished title");
  });

  it("adopts the deferred source once the local field edit is canceled", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await typeTitle(_fixture);
    _fixture.shown = SOURCE.replace("Original title", "Agent title");
    await render(_fixture);
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(_fixture),
        "Original title",
      );
      field(_fixture).dispatchEvent(new Event("input", { bubbles: true }));
      field(_fixture).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await advance(500);
    expect(writes).not.toHaveBeenCalled();
    expect(editor(_fixture).state.doc.firstChild?.attrs.title).toBe("Agent title");
    expect(readTypingDraft(KEY)).toBeNull();
    expect(readStoredRecovery(KEY)?.text).toBe("Local unfinished title");
  });

  it("paints ordinary typing before publication and retains it if publication is refused", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.shown = "\\documentclass{article}\n\\begin{document}\nBody text.\n\\end{document}";
    await render(_fixture);
    await act(() => editor(_fixture).commands.setTextSelection({ from: 2, to: 5 }));
    const source = _fixture.shown;
    _fixture.acceptWrites = false;
    await act(() => editor(_fixture).commands.insertContent("Unavailable"));
    expect(editor(_fixture).state.doc.textContent).toContain("Unavailable");
    expect(writes).not.toHaveBeenCalled();
    expect(_fixture.shown).toBe(source);
    await advance(500);
    await vi.waitFor(() => expect(writes).toHaveBeenCalled());
    expect(_fixture.shown).toBe(source);
    expect(JSON.stringify(readTypingDraft(KEY)?.content)).toContain("Unavailable");
    expect(editor(_fixture).state.doc.textContent).toContain("Unavailable");
  });

  it("coalesces consecutive typing without a parent render and preserves title metadata", async (context) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.shown =
      "\\documentclass{article}\n\\title{Keep title}\n\\begin{document}\n\\maketitle\nBody text.\n\\end{document}";
    await render(_fixture);
    let position = 0;
    editor(_fixture).state.doc.descendants((node, at) => {
      if (node.type.name === "paragraph") position = at + 1;
    });
    const published = nextAcceptedSource(
      _fixture,
      context,
      _fixture.shown.replace("Body text.", "ABBody text."),
    );
    await act(() => {
      editor(_fixture).commands.setTextSelection(position);
      editor(_fixture).commands.insertContent("A");
      editor(_fixture).commands.insertContent("B");
    });
    expect(editor(_fixture).state.doc.textContent).toContain("ABBody text.");
    expect(writes).not.toHaveBeenCalled();
    await advance(500);
    await published();
    expect(_fixture.shown).toContain("ABBody text.");
    expect(_fixture.shown).toContain("\\title{Keep title}");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(_fixture.finish?.()).toBe(true);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  let shown: string;
  let finish: (() => boolean) | null;
  let acceptWrites: boolean;
  let owner: LatexVisualTestOwner;
  let revision: string;
  return {
    get shown() {
      return shown;
    },
    set shown(value: string) {
      shown = value;
    },
    get finish() {
      return finish;
    },
    set finish(value: (() => boolean) | null) {
      finish = value;
    },
    get acceptWrites() {
      return acceptWrites;
    },
    set acceptWrites(value: boolean) {
      acceptWrites = value;
    },
    get owner() {
      return owner;
    },
    set owner(value: LatexVisualTestOwner) {
      owner = value;
    },
    get revision() {
      return revision;
    },
    set revision(value: string) {
      revision = value;
    },

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
