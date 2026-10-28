import "../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  createRef,
  StrictMode,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import {
  collectComposerCitations,
  expandComposerCitationsForProvider,
} from "@t3tools/shared/composerCitations";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditorTiptap";
import { collapseExpandedComposerCursor, formatCitationForComposer } from "~/composer-logic";
import { MarkdownCitationActions } from "./MarkdownCitationActions";
import { ScientMarkdownEditorView } from "./prosemirror/view";
import { createMarkdownCitation } from "./markdownCitation";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: ({ children, className, onClick, "aria-label": label }: ComponentProps<"a">) => (
    <a href="#source" className={className} onClick={onClick} aria-label={label}>
      {children}
    </a>
  ),
}));

const source = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread"),
  cwd: "/project",
  path: "notes.md",
};

let onUserSourceChange: ReturnType<typeof vi.fn<() => void>>;
let accepted = true;
function Fixture({
  fixture: _fixture,
  initial = "My question. ",
}: {
  fixture: _Fixture;
  initial?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [mounted, setMounted] = useState(false);
  const mountHost = (host: HTMLDivElement | null) => {
    if (!host) return;
    _fixture.controller.mount(host);
    setMounted(true);
    return () => _fixture.controller.destroy();
  };
  return (
    <>
      <div className="scient-markdown-document-shell" ref={mountHost} />
      {mounted ? (
        <MarkdownCitationActions
          controller={_fixture.controller}
          source={source}
          onCite={(citation, anchor) => {
            if (!accepted) return false;
            const previous = draftRef.current;
            const next = previous + formatCitationForComposer(citation, citation.comment);
            _fixture.editor.current!.requestCitationComment({
              previousValue: previous,
              value: next,
              citationStart: previous.length,
              sourceAnchor: anchor,
              insertedSpaces: { before: false, after: false },
            });
            draftRef.current = next;
            setDraft(next);
            return true;
          }}
        />
      ) : null}
      <ComposerPromptEditor
        value={draft}
        cursor={collapseExpandedComposerCursor(draft, draft.length)}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder="Write a prompt"
        onChange={setDraft}
        onPaste={() => {}}
        editorRef={_fixture.editor}
      />
      <output>{draft}</output>
    </>
  );
}

describe("select Markdown -> Ask in chat -> real composer", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    accepted = true;

    onUserSourceChange = vi.fn();
    _fixture.controller = new ScientMarkdownEditorView({
      source: "A selected paragraph.\n",
      revision: "fixture",
      mode: "write",
      ariaLabel: "Markdown",
      onUserSourceChange,
    });
    _fixture.host = document.createElement("div");
    Object.assign(_fixture.host.style, { width: "800px", minHeight: "600px" });
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  async function flushSelectionToolbar() {
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Ask in chat"]')).not.toBeNull(),
    );
  }
  async function selectAndShowToolbar(_fixture: _Fixture) {
    const node = _fixture.controller.view!.dom.querySelector("p")!.firstChild!;
    const selection = window.getSelection()!;
    await act(() => {
      const range = document.createRange();
      range.setStart(node, 2);
      range.setEnd(node, 10);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await flushSelectionToolbar();
    return document.querySelector<HTMLButtonElement>('[aria-label="Ask in chat"]');
  }

  it("inserts one bound file quote, preserves the draft, opens comment, and can remove the whole citation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await _fixture.root0.rerender(<Fixture fixture={_fixture} />));
    const cite = await selectAndShowToolbar(_fixture);
    expect(cite).not.toBeNull();
    await act(() => cite!.click());
    const value = _fixture.host.querySelector("output")!.textContent!;
    expect(value.startsWith("My question. ")).toBe(true);
    const quotes = collectComposerCitations(value);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.citation).toMatchObject({
      kind: "file",
      path: "notes.md",
      text: "selected",
      cwd: "/project",
    });
    expect(_fixture.editor.current!.readSnapshot().value).toBe(value);
    expect(
      document.querySelector('textarea[aria-label="Comment on selected text"]'),
    ).not.toBeNull();
    expect(_fixture.host.querySelectorAll("[data-file-citation-chip]")).toHaveLength(1);
    expect(expandComposerCitationsForProvider(value)).toContain('"text": "selected"');
    expect(_fixture.controller.createSaveIntent()).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
    const addToChat = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add to chat",
    );
    expect(addToChat).toBeDefined();
    await act(() => addToChat!.click());
    expect(document.querySelector('textarea[aria-label="Comment on selected text"]')).toBeNull();
    expect(collectComposerCitations(_fixture.editor.current!.readSnapshot().value)).toHaveLength(1);
    const remove = _fixture.host.querySelector<HTMLButtonElement>(
      '[aria-label="Remove file citation"]',
    )!;
    await act(() => remove.click());
    expect(collectComposerCitations(_fixture.editor.current!.readSnapshot().value)).toHaveLength(0);
    expect(_fixture.editor.current!.readSnapshot().value.startsWith("My question.")).toBe(true);
  });

  it("keeps the source selection and draft when the composer refuses insertion", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    accepted = false;
    await act(async () => await _fixture.root0.rerender(<Fixture fixture={_fixture} />));
    const cite = await selectAndShowToolbar(_fixture);
    expect(cite).not.toBeNull();
    await act(() => cite!.click());
    expect(_fixture.host.querySelector("output")!.textContent).toBe("My question. ");
    expect(window.getSelection()!.toString()).toBe("selected");
  });

  it("opens Ask in chat for a CodeMirror selection even when CodeMirror consumes the press", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.controller = new ScientMarkdownEditorView({
      source: "```text\nzero one two\n```\n",
      revision: "code-fixture",
      mode: "write",
      ariaLabel: "Markdown",
      onUserSourceChange,
    });
    await act(async () => await _fixture.root0.rerender(<Fixture fixture={_fixture} />));
    const codeDom = _fixture.controller.view!.dom.querySelector<HTMLElement>(".cm-editor")!;
    const code = CodeMirrorView.findFromDOM(codeDom)!;
    await act(() => {
      code.focus();
      code.dispatch({ selection: { anchor: 5, head: 8 } });
    });
    const first = code.domAtPos(5);
    const last = code.domAtPos(8);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    selection.removeAllRanges();
    selection.addRange(range);

    const press = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      isPrimary: true,
    });
    press.preventDefault();
    await act(() => {
      codeDom.dispatchEvent(press);
      window.dispatchEvent(new PointerEvent("pointerup", { button: 0, isPrimary: true }));
      window.dispatchEvent(
        new MouseEvent("mouseup", { button: 0, clientX: 240, clientY: 160, detail: 1 }),
      );
    });
    await flushSelectionToolbar();

    const cite = document.querySelector<HTMLButtonElement>('[aria-label="Ask in chat"]');
    expect(cite).not.toBeNull();
    await act(() => cite!.click());
    expect(
      collectComposerCitations(_fixture.editor.current!.readSnapshot().value)[0]?.citation,
    ).toMatchObject({
      kind: "file",
      path: "notes.md",
      text: "one",
    });
    expect(_fixture.controller.createSaveIntent()).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("opens Ask in chat for visible code source when its parent is a rich fence", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.controller = new ScientMarkdownEditorView({
      source: "```text\nflowchart LR\n  A[Start] --> B[Done]\n```\n",
      revision: "mermaid-fixture",
      mode: "write",
      ariaLabel: "Markdown",
      onUserSourceChange,
    });
    await act(async () => await _fixture.root0.rerender(<Fixture fixture={_fixture} />));
    const codeDom = _fixture.controller.view!.dom.querySelector<HTMLElement>(".cm-editor")!;
    codeDom
      .closest<HTMLElement>("[data-scient-markdown-code-block]")!
      .setAttribute("data-scient-markdown-rich-fence", "mermaid");
    const code = CodeMirrorView.findFromDOM(codeDom)!;
    const from = code.state.doc.toString().indexOf("A[Start]");
    const to = from + "A[Start]".length;
    await act(() => code.dispatch({ selection: { anchor: from, head: to } }));
    const first = code.domAtPos(from);
    const last = code.domAtPos(to);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    selection.removeAllRanges();
    selection.addRange(range);

    const press = Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
      button: 0,
      isPrimary: true,
    });
    press.preventDefault();
    codeDom.dispatchEvent(press);
    window.dispatchEvent(Object.assign(new Event("pointerup"), { button: 0, isPrimary: true }));
    window.dispatchEvent(
      Object.assign(new Event("mouseup"), { button: 0, clientX: 240, clientY: 160, detail: 1 }),
    );
    await flushSelectionToolbar();

    const cite = document.querySelector<HTMLButtonElement>('[aria-label="Ask in chat"]');
    expect(cite).not.toBeNull();
    await act(() => cite!.click());
    expect(
      collectComposerCitations(_fixture.editor.current!.readSnapshot().value)[0]?.citation,
    ).toMatchObject({
      kind: "file",
      path: "notes.md",
      text: "A[Start]",
    });
    expect(_fixture.controller.createSaveIntent()).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
  });

  it("reveals once settled under Strict Mode and removes its highlight on unmount", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const markdown = document.createElement("div");
    document.body.append(markdown);
    _fixture.controller.mount(markdown);
    const registry = CSS.highlights;
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const quote = createMarkdownCitation(_fixture.controller.session, source, 3, 11)!;
    try {
      await act(
        async () =>
          await _fixture.root0.rerender(
            <StrictMode>
              <MarkdownCitationActions
                controller={_fixture.controller}
                source={source}
                reveal={quote}
                revealId={1}
              />
            </StrictMode>,
          ),
      );
      await vi.waitFor(() => expect(registry.get("scient-file-citation")?.size).toBe(1));
      expect(registry.get("scient-file-citation")?.size).toBe(1);
      expect([...registry.get("scient-file-citation")!][0]!.toString()).toBe("selected");
      await act(async () => await _fixture.root0.rerender(null));
      expect(registry.has("scient-file-citation")).toBe(false);
      expect(onUserSourceChange).not.toHaveBeenCalled();
    } finally {
      _fixture.controller.destroy();
      markdown.remove();
    }
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const editor = createRef<ComposerPromptEditorHandle>();
  return {
    editor,
    controller: undefined! as ScientMarkdownEditorView,
    host: undefined! as HTMLDivElement,
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
