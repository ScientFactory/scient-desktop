// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
import { clearVisualDraft } from "./visualDrafts";
import { clearTypingDraft, readTypingDraft } from "./visualTyping";
import { readStoredRecovery } from "./visualRecovery";

const KEY = "pending-field-source-owner";
const SOURCE =
  "\\documentclass{article}\n\\newtheorem{theorem}{Theorem}\n\\begin{document}\n\\begin{theorem}[Original title]\nBody.\n\\end{theorem}\n\\end{document}\n";

describe("pending fields across outside document changes", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let shown: string;
  let finish: (() => boolean) | null;
  const writes = vi.fn();
  const pending = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    writes.mockReset();
    pending.mockReset();
    localStorage.clear();
    shown = SOURCE;
    finish = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    clearVisualDraft(KEY);
    clearTypingDraft(KEY);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = () =>
    act(() =>
      root.render(
        <LatexVisualEditor
          draftKey={KEY}
          fileRevision="r1"
          source={shown}
          disabled={false}
          onEditingChange={() => {}}
          onOpenSource={() => {}}
          onLocalDraftChange={pending}
          registerFinishEditing={(callback) => {
            finish = callback;
          }}
          onEdit={(expected, next) => {
            writes(expected, next);
            if (expected !== shown) return false;
            shown = next;
            return true;
          }}
        />,
      ),
    );
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const editor = () =>
    (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  const field = () =>
    container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Scientific statement title"]',
    )!;
  async function mount() {
    await render();
    await advance(40);
    let position = -1;
    editor().state.doc.descendants((node, offset) => {
      if (node.type.name === "latexScientific") position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    await act(() => editor().commands.setNodeSelection(position));
    expect(field()).not.toBeNull();
  }
  async function typeTitle() {
    await act(() => {
      field().focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        "Local unfinished title",
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
      expect(pending).toHaveBeenLastCalledWith(true);
    });
    expect(writes).not.toHaveBeenCalled();
  }

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
      await mount();
      await typeTitle();
      shown = outside!;
      await render();
      await advance(500);
      expect(shown).toBe(outside);
      expect(writes.mock.calls.every(([expected]) => expected === SOURCE)).toBe(true);
      const typing = readTypingDraft(KEY);
      const recovery = readStoredRecovery(KEY);
      if (typing) {
        expect(typing.baseSource).toBe(SOURCE);
        expect(JSON.stringify(typing.content)).toContain("Local unfinished title");
      } else {
        expect(recovery?.source).toContain("Local unfinished title");
        expect(recovery?.baseRevision).toBe("r1");
      }
    },
  );

  it("blocks a synchronous finish request while IME owns pending input", async () => {
    await mount();
    await act(() => {
      field().focus();
      field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(pending).toHaveBeenLastCalledWith(true);
      expect(finish?.()).toBe(false);
    });
    await typeTitle();
    shown = SOURCE.replace("Original title", "Agent title");
    await render();
    await advance(500);
    expect(writes).not.toHaveBeenCalled();
    expect(field().value).toBe("Local unfinished title");
    await act(() =>
      field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await advance(500);
    expect(shown).toContain("Agent title");
    expect(readTypingDraft(KEY)?.baseSource).toBe(SOURCE);
  });

  it("adopts the deferred source once the local field edit is canceled", async () => {
    await mount();
    await typeTitle();
    shown = SOURCE.replace("Original title", "Agent title");
    await render();
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field(),
        "Original title",
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await advance(500);
    expect(writes).not.toHaveBeenCalled();
    expect(editor().state.doc.firstChild?.attrs.title).toBe("Agent title");
    expect(readTypingDraft(KEY)).toBeNull();
    expect(readStoredRecovery(KEY)).toBeNull();
  });
});
