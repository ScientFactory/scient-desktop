import type { ContentDirection } from "@t3tools/contracts/settings";
import type { Editor } from "@tiptap/core";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { ContentDirectionScope } from "~/scient/bidi/ContentDirectionScope";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

function Prompt({ value, direction = "auto" }: { value: string; direction?: ContentDirection }) {
  const [draft, setDraft] = useState({ value, cursor: value.length });
  return (
    <ContentDirectionScope direction={direction}>
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={draft.value}
        cursor={draft.cursor}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(next, cursor) => setDraft({ value: next, cursor })}
        onPaste={() => {}}
      />
    </ContentDirectionScope>
  );
}

function editorIn(container: HTMLElement) {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

describe("composer content direction", () => {
  it.each(["rtl", "ltr"] as const)(
    "applies %s to existing and new prose and restores contextual direction",
    async (direction) => {
      await using screen = await render(<Prompt value="Hello שלום" direction={direction} />);
      const editor = editorIn(screen.container);
      const surface = screen.container.querySelector<HTMLElement>(
        "[data-scient-composer-surface]",
      )!;
      expect(surface.dataset.scientContentDirection).toBe(direction);
      expect(editor.view.dom.dir).toBe(direction);
      expect(editor.view.dom.querySelector("p")?.dir).toBe(direction);

      await act(async () => {
        editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph" });
      });
      expect([...editor.view.dom.querySelectorAll("p")].map((p) => p.dir)).toEqual([
        direction,
        direction,
      ]);

      await screen.rerender(<Prompt value="Hello שלום" direction="auto" />);
      expect(surface.hasAttribute("data-scient-content-direction")).toBe(false);
      expect(editor.view.dom.dir).toBe("ltr");
      expect([...editor.view.dom.querySelectorAll("p")].map((p) => p.dir)).toEqual(["ltr", "ltr"]);
      expect(editor.state.doc.textContent).toBe("Hello שלום");
    },
  );

  it("uses contextual paragraphs and whole lists while the root follows the caret", async () => {
    const value = `${"זהו מסמך עברי ארוך וברור מאוד ".repeat(4)}\nabcd אב\nabcdefghij א\n- Standard deviation and confidence interval\n- Review the complete report שלום`;
    await using screen = await render(<Prompt value={value} />);
    const editor = editorIn(screen.container);
    expect([...editor.view.dom.children].map((child) => child.getAttribute("dir"))).toEqual([
      "rtl",
      "rtl",
      "ltr",
      "ltr",
    ]);
    expect(editor.view.dom.querySelector("li")?.hasAttribute("dir")).toBe(false);
    await act(async () => editor.commands.setTextSelection(1));
    expect(editor.view.dom.dir).toBe("rtl");
    await act(async () => editor.commands.setTextSelection(editor.state.doc.content.size - 3));
    expect(editor.view.dom.dir).toBe("ltr");
  });

  it("keeps technical blocks LTR without counting inline code as prose", async () => {
    await using screen = await render(
      <Prompt value={"אבג `const englishTechnicalIdentifier = true`\n```\n// שלום\n```"} />,
    );
    const editor = editorIn(screen.container);
    expect(editor.view.dom.querySelector("p")?.dir).toBe("rtl");
    expect(getComputedStyle(editor.view.dom.querySelector("pre")!).direction).toBe("ltr");
    await act(async () => editor.commands.setTextSelection(1));
    expect(editor.view.dom.dir).toBe("rtl");
  });

  it("updates preferences without a surrounding surface and disposes on unmount", async () => {
    await using screen = await render(<Prompt value="Hello" direction="rtl" />);
    using _clock = fakeTimers();
    const editor = editorIn(screen.container);
    expect(editor.view.dom.dir).toBe("rtl");
    await screen.rerender(<Prompt value="Hello" direction="auto" />);
    expect(editor.view.dom.dir).toBe("ltr");
    await screen.rerender(<div />);
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(editor.isDestroyed).toBe(true);
  });
});
