import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vite-plus/test";
import "../../../index.css";

import { act } from "../../../../test/render";
import { markdownQuote } from "~/scient/annotations/quoteFormat";
import { ScientMarkdownEditorView } from "./view";

function mount(source: string, mode: "write" | "read" = "write") {
  const host = document.createElement("div");
  document.body.append(host);
  const controller = new ScientMarkdownEditorView({
    source,
    revision: "r0",
    mode,
    ariaLabel: "Markdown document",
  });
  const view = controller.mount(host);
  return {
    controller,
    view,
    async [Symbol.asyncDispose]() {
      await act(() => controller.destroy());
      host.remove();
    },
  };
}

const passage = {
  quote: "Deep sleep doubled\nrecall.",
  pages: [4],
  citationKey: "smith2024sleep",
  fileName: "sleep.pdf",
};

describe("quoting a PDF passage in the Markdown editor", () => {
  it("adds a block quote with its Library citation after the paragraph being written", async () => {
    await using editor = mount("First paragraph.\n\nSecond paragraph.\n");
    const { controller, view } = editor;
    await act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
      expect(controller.insertQuotation(markdownQuote(passage))).toBe(true);
    });
    expect(controller.session.session.draftSource).toBe(
      "First paragraph.\n\n> Deep sleep doubled recall. [@smith2024sleep, p. 4]\n\nSecond paragraph.\n",
    );
  });

  it("writes the file and page as text without a key, and refuses a read-only document", async () => {
    await using editor = mount("Notes.\n");
    await act(() => {
      expect(
        editor.controller.insertQuotation(markdownQuote({ ...passage, citationKey: null })),
      ).toBe(true);
    });
    expect(editor.controller.session.session.draftSource).toBe(
      "Notes.\n\n> Deep sleep doubled recall. (sleep.pdf, p. 4)\n",
    );
    await using reader = mount("Notes.\n", "read");
    expect(reader.controller.insertQuotation(markdownQuote(passage))).toBe(false);
  });
});
