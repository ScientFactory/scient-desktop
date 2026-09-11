// @vitest-environment happy-dom
import {
  act,
  createRef,
  StrictMode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  collectComposerCitations,
  expandComposerCitationsForProvider,
} from "@t3tools/shared/composerCitations";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
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
const editor = createRef<ComposerPromptEditorHandle>();
let controller: ScientMarkdownEditorView;
let onUserSourceChange: ReturnType<typeof vi.fn<() => void>>;
let accepted = true;
function Fixture({ initial = "My question. " }: { initial?: string }) {
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [mounted, setMounted] = useState(false);
  const mountHost = useCallback((host: HTMLDivElement | null) => {
    if (!host) return;
    controller.mount(host);
    setMounted(true);
    return () => controller.destroy();
  }, []);
  return (
    <>
      <div className="scient-markdown-document-shell" ref={mountHost} />
      {mounted ? (
        <MarkdownCitationActions
          controller={controller}
          source={source}
          onCite={(citation, anchor) => {
            if (!accepted) return false;
            const previous = draftRef.current;
            const next = previous + formatCitationForComposer(citation, citation.comment);
            editor.current!.requestCitationComment({
              previousValue: previous,
              value: next,
              citationStart: previous.length,
              sourceAnchor: anchor,
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
        terminalContexts={[]}
        skills={[]}
        disabled={false}
        placeholder="Write a prompt"
        onRemoveTerminalContext={() => {}}
        onChange={setDraft}
        onPaste={() => {}}
        editorRef={editor}
      />
      <output>{draft}</output>
    </>
  );
}

describe("select Markdown -> Ask in chat -> real composer", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let frames: Map<number, FrameRequestCallback>;
  let frameId = 0;
  beforeEach(() => {
    accepted = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const rect = new DOMRect(30, 30, 180, 20);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue({
      length: 1,
      item: () => rect,
      [Symbol.iterator]: function* () {
        yield rect;
      },
    } as unknown as DOMRectList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    onUserSourceChange = vi.fn();
    controller = new ScientMarkdownEditorView({
      source: "A selected paragraph.\n",
      revision: "fixture",
      mode: "write",
      ariaLabel: "Markdown",
      onUserSourceChange,
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    frames.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function selectAndShowToolbar() {
    const node = controller.view!.dom.querySelector("p")!.firstChild!;
    const selection = window.getSelection()!;
    await act(() => {
      const range = document.createRange();
      range.setStart(node, 2);
      range.setEnd(node, 10);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    // The real selection observer defers until gesture completion. Only layout
    // measurements and animation scheduling are stubbed in this DOM test.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
    return document.querySelector<HTMLButtonElement>('[aria-label="Ask in chat"]');
  }

  it("inserts one bound file quote, preserves the draft, opens comment, and can remove the whole citation", async () => {
    await act(() => root.render(<Fixture />));
    const cite = await selectAndShowToolbar();
    expect(cite).not.toBeNull();
    await act(() => cite!.click());
    const value = host.querySelector("output")!.textContent!;
    expect(value.startsWith("My question. ")).toBe(true);
    const quotes = collectComposerCitations(value);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.citation).toMatchObject({
      kind: "file",
      path: "notes.md",
      text: "selected",
      cwd: "/project",
    });
    expect(editor.current!.readSnapshot().value).toBe(value);
    expect(
      document.querySelector('textarea[aria-label="Comment on selected text"]'),
    ).not.toBeNull();
    expect(host.querySelectorAll("[data-file-citation-chip]")).toHaveLength(1);
    expect(expandComposerCitationsForProvider(value)).toContain('"text": "selected"');
    expect(controller.createSaveIntent()).toBeNull();
    expect(onUserSourceChange).not.toHaveBeenCalled();
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Remove file citation"]')!;
    await act(() => remove.click());
    expect(collectComposerCitations(editor.current!.readSnapshot().value)).toHaveLength(0);
    expect(editor.current!.readSnapshot().value.startsWith("My question.")).toBe(true);
  });

  it("keeps the source selection and draft when the composer refuses insertion", async () => {
    accepted = false;
    await act(() => root.render(<Fixture />));
    const cite = await selectAndShowToolbar();
    expect(cite).not.toBeNull();
    await act(() => cite!.click());
    expect(host.querySelector("output")!.textContent).toBe("My question. ");
    expect(window.getSelection()!.toString()).toBe("selected");
  });

  it("reveals once settled under Strict Mode and removes its highlight on unmount", async () => {
    const markdown = document.createElement("div");
    document.body.append(markdown);
    controller.mount(markdown);
    const registry = new Map<string, Set<Range>>();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const quote = createMarkdownCitation(controller.session, source, 3, 11)!;
    try {
      await act(() =>
        root.render(
          <StrictMode>
            <MarkdownCitationActions
              controller={controller}
              source={source}
              reveal={quote}
              revealId={1}
            />
          </StrictMode>,
        ),
      );
      await act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
      });
      expect(registry.get("scient-file-citation")?.size).toBe(1);
      expect([...registry.get("scient-file-citation")!][0]!.toString()).toBe("selected");
      await act(() => root.render(null));
      expect(registry.has("scient-file-citation")).toBe(false);
      expect(onUserSourceChange).not.toHaveBeenCalled();
    } finally {
      controller.destroy();
      markdown.remove();
    }
  });
});
