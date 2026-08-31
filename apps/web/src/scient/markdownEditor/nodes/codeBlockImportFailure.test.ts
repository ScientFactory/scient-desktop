// @vitest-environment happy-dom
import type { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scientMarkdownSchema } from "../prosemirror/schema";
import { createScientCodeBlockNodeView } from "./codeBlockNodeView";

vi.mock("./codeMirrorCodeEditor", async () => {
  throw new Error("The lazy editor module could not be loaded");
});
vi.mock("~/lib/syntaxHighlighting", () => ({
  getSyntaxHighlighterPromise: async () => ({ codeToHtml: () => "code" }),
}));

describe("failed lazy code editor import", () => {
  afterEach(() => document.body.replaceChildren());

  it.each(["selected", "deselected", "destroyed", "read-only"])(
    "settles safely when the block is %s",
    async (state) => {
      const node = scientMarkdownSchema.nodes.code_block!.create(
        { params: "text" },
        scientMarkdownSchema.text("code"),
      );
      const dispatch = vi.fn();
      const view = { editable: true, focus: vi.fn(), dispatch };
      const nodeView = createScientCodeBlockNodeView(node, view as unknown as EditorView, () => 0);
      const dom = nodeView.dom as HTMLElement;
      document.body.append(dom);
      try {
        nodeView.selectNode!();
        if (state === "deselected") nodeView.deselectNode!();
        if (state === "destroyed") nodeView.destroy!();
        if (state === "read-only") view.editable = false;
        await vi.dynamicImportSettled();

        const notice = dom.querySelector<HTMLElement>(".scient-markdown-code-load-error")!;
        expect(notice.hidden).toBe(state !== "selected");
        expect(dom.querySelector<HTMLElement>(".scient-markdown-code-render")?.hidden).toBe(false);
        expect(dom.querySelector<HTMLElement>(".scient-markdown-code-editor")?.hidden).toBe(true);
        expect(dispatch).not.toHaveBeenCalled();
        expect(view.focus).not.toHaveBeenCalled();

        // An unavailable module may remain unavailable on retry. Keep the
        // original code usable and the recovery notice truthful in that case.
        notice.querySelector<HTMLButtonElement>("button")!.click();
        await vi.dynamicImportSettled();
        expect(notice.hidden).toBe(state !== "selected");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        if (state !== "destroyed") nodeView.destroy!();
      }
    },
  );
});
