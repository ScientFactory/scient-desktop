import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  act,
} from "../../../test/render";
import {
  createRef,
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

import { describe, expect, it, vi } from "vite-plus/test";

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
  const setPrompt = (next: string) => {
    draftRef.current = next;
    setDraft(next);
  };
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
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder="Write a prompt"
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
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.queuedFrames = new Map();
    _fixture.frameId = 0;
    _fixture.stack.use(
      _fixtureStubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        _fixture.queuedFrames.set(++_fixture.frameId, callback);
        return _fixture.frameId;
      }),
    );
    _fixture.stack.use(
      _fixtureStubGlobal("cancelAnimationFrame", (id: number) => _fixture.queuedFrames.delete(id)),
    );
    send.mockReset();
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    _fixture.queuedFrames.clear();
    vi.unstubAllGlobals();
  }
  async function flushFocusFrame(_fixture: _Fixture) {
    await act(() => {
      const frames = [..._fixture.queuedFrames.values()];
      _fixture.queuedFrames.clear();
      for (const callback of frames) callback(0);
    });
  }

  it.each(["", "Keep my question.", "@README.md בדיקה 👋"])(
    "retains the inserted repair after focus and repeated activation; draft=%s",
    async (initialDraft) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const editor = createRef<ComposerPromptEditorHandle>();
      await act(
        async () =>
          await _fixture.root0.rerender(
            <RepairEditorFixture initialDraft={initialDraft} editor={editor} />,
          ),
      );
      const ask = _fixture.container.querySelector<HTMLButtonElement>(
        '[aria-label="Ask agent to fix"]',
      )!;
      expect(ask).not.toBeNull();
      await act(() => ask.click());
      await flushFocusFrame(_fixture);
      const storedDraft = _fixture.container.querySelector("output")!.textContent!;
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
      const editable = _fixture.container.querySelector<HTMLElement>('[contenteditable="true"]')!;
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
      await flushFocusFrame(_fixture);
      expect(editor.current!.readSnapshot().value).toBe(storedDraft);
      expect(_fixture.container.querySelector("output")?.textContent).toBe(storedDraft);
      expect(send).not.toHaveBeenCalled();
      expect(_fixture.container.textContent).not.toContain("Request added to the composer");
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  let queuedFrames: Map<number, FrameRequestCallback>;
  let frameId: number;
  return {
    get queuedFrames() {
      return queuedFrames;
    },
    set queuedFrames(value: Map<number, FrameRequestCallback>) {
      queuedFrames = value;
    },
    get frameId() {
      return frameId;
    },
    set frameId(value: number) {
      frameId = value;
    },

    container: undefined! as HTMLDivElement,
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
