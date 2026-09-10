// @vitest-environment happy-dom
import {
  act,
  createRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
  type ComponentProps,
} from "react";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
} from "@t3tools/shared/assistantCitations";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { AssistantCitationSource } from "~/components/chat/AssistantCitationSource";
import { formatAssistantCitationForComposer } from "~/composer-logic";
import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { MermaidRenderError } from "./mermaidRuntime";

// Keep the real capsule and editor; only navigation is outside this fixture.
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: ({ children, className, onClick, "aria-label": label }: ComponentProps<"a">) => (
    <a href="#source" className={className} onClick={onClick} aria-label={label}>
      {children}
    </a>
  ),
}));

vi.mock("../presentation/useNearViewport", () => ({
  useNearViewport: () => ({ ref: null, isNearViewport: true }),
}));
vi.mock("./mermaidRuntime", async (original) => ({
  ...(await original<typeof import("./mermaidRuntime")>()),
  renderMermaidDiagram: vi.fn(async () => {
    throw new MermaidRenderError(new Error("Parse error on line 2:\nA[\n ^"));
  }),
}));

const source = "flowchart LR\nA[";
const diagnostic = "Parse error on line 2:\nA[\n ^";
const send = vi.fn();
let queuedFrames: Map<number, FrameRequestCallback>;
let frameId: number;

/** Keep the real controlled Lexical editor, callbacks and focus behavior.
 * The host mirrors ChatComposer's draft update followed by guarded frame focus.
 * A synchronous extra focus emits the OLD snapshot back through onChange.
 */
function RepairEditorFixture({
  initialDraft,
  editor,
}: {
  initialDraft: string;
  editor: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(draft);
  const handle: ComposerHandleRef = useRef(null);
  const setPrompt = useCallback((next: string) => {
    draftRef.current = next;
    setDraft(next);
  }, []);
  useImperativeHandle(
    handle,
    () =>
      ({
        readSnapshot: () => editor.current!.readSnapshot(),
        citeAssistantText: (citation: AssistantCitation) => {
          const next =
            draftRef.current +
            (draftRef.current ? " " : "") +
            formatAssistantCitationForComposer(citation, citation.comment);
          setPrompt(next);
          requestAnimationFrame(() => {
            if (draftRef.current === next) editor.current?.focusAtEnd();
          });
          return true;
        },
        focusAtEnd: () => editor.current?.focusAtEnd(),
      }) as NonNullable<ComposerHandleRef["current"]>,
    [editor, setPrompt],
  );
  return (
    <ComposerHandleContext value={handle}>
      <div data-assistant-citation-viewport>
        <AssistantCitationSource
          messageId={MessageId.make("assistant")}
          threadRef={{
            environmentId: EnvironmentId.make("local"),
            threadId: ThreadId.make("thread"),
          }}
          itemKey="assistant"
          listRef={createRef()}
          request={null}
        >
          <p>The diagram:</p>
          <MermaidDiagramCard source={source} language="mermaid" title={null} theme="light" />
        </AssistantCitationSource>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <ComposerPromptEditor
          value={draft}
          cursor={draft.length}
          terminalContexts={[]}
          skills={[]}
          disabled={false}
          placeholder="Write a prompt"
          onRemoveTerminalContext={() => {}}
          onChange={setPrompt}
          onPaste={() => {}}
          editorRef={editor}
        />
      </form>
      <output aria-label="Stored draft">{draft}</output>
    </ComposerHandleContext>
  );
}

describe("Mermaid repair with the real composer editor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    queuedFrames = new Map();
    frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queuedFrames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queuedFrames.delete(id));
    send.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    queuedFrames.clear();
    vi.unstubAllGlobals();
  });
  async function flushFocusFrame() {
    await act(() => {
      const frames = [...queuedFrames.values()];
      queuedFrames.clear();
      for (const callback of frames) callback(0);
    });
  }

  it.each(["", "Keep my question.", "@README.md בדיקה 👋"])(
    "retains the inserted repair after focus and repeated activation; draft=%s",
    async (initialDraft) => {
      const editor = createRef<ComposerPromptEditorHandle>();
      await act(() =>
        root.render(<RepairEditorFixture initialDraft={initialDraft} editor={editor} />),
      );
      const ask = container.querySelector<HTMLButtonElement>('[aria-label="Ask agent to fix"]')!;
      expect(ask).not.toBeNull();
      await act(() => ask.click());
      await flushFocusFrame();
      const storedDraft = container.querySelector("output")!.textContent!;
      const citations = collectAssistantCitations(storedDraft);
      expect(citations).toHaveLength(1);
      expect(citations[0]!.citation).toMatchObject({
        messageId: "assistant",
        environmentId: "local",
        threadId: "thread",
        text: source,
      });
      expect(citations[0]!.citation.comment).toContain(diagnostic);
      expect(storedDraft.slice(0, citations[0]!.start)).toBe(
        initialDraft ? `${initialDraft} ` : "",
      );
      expect(editor.current!.readSnapshot().value).toBe(storedDraft);
      const editable = container.querySelector<HTMLElement>('[contenteditable="true"]')!;
      expect(editable.querySelectorAll("[data-assistant-citation-chip]")).toHaveLength(1);
      expect(editable.textContent).not.toContain(source);
      expect(editable.textContent).not.toContain(diagnostic);
      expect(editable.querySelector('[aria-label="Edit citation comment"]')).not.toBeNull();
      const providerPrompt = expandAssistantCitationsForProvider(storedDraft);
      expect(providerPrompt).toContain(JSON.stringify(source));
      expect(providerPrompt).toContain("Please fix this Mermaid diagram");
      expect(providerPrompt).toContain("Parse error on line 2:");
      expect(document.activeElement).toBe(editable);
      await act(() => ask.click());
      await flushFocusFrame();
      expect(editor.current!.readSnapshot().value).toBe(storedDraft);
      expect(container.querySelector("output")?.textContent).toBe(storedDraft);
      expect(send).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Request added to the composer");
      await act(() =>
        editable
          .querySelector<HTMLButtonElement>('[aria-label="Remove assistant citation"]')!
          .click(),
      );
      expect(collectAssistantCitations(editor.current!.readSnapshot().value)).toHaveLength(0);
      expect(editor.current!.readSnapshot().value.trim()).toBe(initialDraft);
      expect(send).not.toHaveBeenCalled();
    },
  );
});
