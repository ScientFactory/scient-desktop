// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LatexInlineField } from "./LatexInlineField";
import { LatexDraftContext, replaceLatexFieldDraft } from "./LatexTextField";

describe("rich-cell pending input", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let owner: Editor;
  const publish = vi.fn(() => false);
  const pending = new Set<string>();
  const reportDraft = (id: string, value: boolean) => {
    if (value) pending.add(id);
    else pending.delete(id);
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    publish.mockClear();
    pending.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    owner = new Editor({ extensions: [StarterKit], content: "<p>Owner</p>" });
  });
  afterEach(async () => {
    await act(() => root.unmount());
    owner.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });
  const render = (source = "Original") =>
    act(() =>
      root.render(
        <LatexDraftContext value={{ reportDraft, undo: () => {} }}>
          <LatexInlineField
            owner={owner}
            source={source}
            draftKey="synthetic-inline-cell"
            label="Cell"
            cell="0-0"
            width="content"
            disabled={false}
            extensions={[]}
            onFocus={() => {}}
            onChange={publish}
            onTab={() => {}}
            onExit={() => {}}
          />
        </LatexDraftContext>,
      ),
    );

  it.each(["restored"])(
    "retires %s input and its journal on an accepted grouped replacement",
    async (kind) => {
      if (kind === "restored")
        localStorage.setItem(
          "scient.latex.field:synthetic-inline-cell",
          JSON.stringify({
            base: "Original",
            text: "Unfinished",
          }),
        );
      await render();
      const field = host.querySelector<HTMLElement>("[data-table-cell]")!;
      const inner = (field as HTMLElement & { editor: Editor }).editor;
      expect(inner.state.doc.textContent).toBe("Unfinished");
      expect(pending.size).toBe(1);
      expect(localStorage.getItem("scient.latex.field:synthetic-inline-cell")).not.toBeNull();
      publish.mockClear();
      await act(() => {
        replaceLatexFieldDraft(field, "");
        expect(pending.size).toBe(0);
        expect(inner.state.doc.textContent).toBe("");
      });
      await render("");
      expect(publish).not.toHaveBeenCalled();
      expect(localStorage.getItem("scient.latex.field:synthetic-inline-cell")).toBeNull();
      // Subsequent document Undo/source updates can replace the field again.
      await render();
      expect(inner.state.doc.textContent).toBe("Original");
      expect(pending.size).toBe(0);
    },
  );

  it("paints typing before publication and retains a refused cell draft", async () => {
    await render();
    const element = host.querySelector<HTMLElement>("[data-table-cell]")!;
    const field = (element as HTMLElement & { editor: Editor }).editor;
    await act(() => field.commands.setTextSelection({ from: 2, to: 5 }));
    await act(() => field.commands.insertContent("Unavailable"));
    expect(field.state.doc.textContent).toContain("Unavailable");
    expect(publish).not.toHaveBeenCalled();
    await act(() => element.dispatchEvent(new Event("scient-latex-flush-field")));
    expect(publish).toHaveBeenCalled();
    expect(field.state.doc.textContent).toContain("Unavailable");
    expect(pending.size).toBe(1);
    expect(localStorage.getItem("scient.latex.field:synthetic-inline-cell")).toContain(
      "Unavailable",
    );
  });
});
