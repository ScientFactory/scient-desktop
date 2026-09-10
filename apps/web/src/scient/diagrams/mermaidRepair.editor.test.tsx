// @vitest-environment happy-dom
import {
  act,
  createRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { buildMermaidRepairRequest } from "./mermaidRepair";
import { MermaidRenderError } from "./mermaidRuntime";

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
        insertTextAtEnd: (text: string) => {
          const next = draftRef.current + text;
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
      <MermaidDiagramCard source={source} language="mermaid" title={null} theme="light" />
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
      const expected = `${initialDraft}${initialDraft ? "\n\n" : ""}${buildMermaidRepairRequest(source, diagnostic)}`;
      await act(() => ask.click());
      await flushFocusFrame();
      expect(container.querySelector("output")?.textContent).toBe(expected);
      expect(editor.current!.readSnapshot().value).toBe(expected);
      const editable = container.querySelector<HTMLElement>('[contenteditable="true"]')!;
      expect(editable.textContent).toContain("Please fix this Mermaid diagram");
      expect(document.activeElement).toBe(editable);
      await act(() => ask.click());
      await flushFocusFrame();
      expect(editor.current!.readSnapshot().value).toBe(expected);
      expect(container.querySelector("output")?.textContent).toBe(expected);
      expect(send).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Request added to the composer");
    },
  );
});
