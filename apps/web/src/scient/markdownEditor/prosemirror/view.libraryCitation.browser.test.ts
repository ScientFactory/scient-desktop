import { TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vite-plus/test";
import "../../../index.css";

import { act } from "../../../../test/render";
import type { LibraryCitationCandidate } from "~/scient/sources/libraryCitations";
import { ScientMarkdownEditorView } from "./view";

const library: ReadonlyArray<LibraryCitationCandidate> = [
  { sourceId: "a", citationKey: "lovelace1843notes", label: "Lovelace 1843", title: "Notes" },
  { sourceId: "b", citationKey: "turing1950computing", label: "Turing 1950", title: "Computing" },
];

function mount(
  source: string,
  onOpenCitation?: (keys: ReadonlyArray<string>) => boolean,
  mode: "write" | "read" = "write",
) {
  const host = document.createElement("div");
  document.body.append(host);
  const controller = new ScientMarkdownEditorView({
    source,
    revision: "r0",
    mode,
    ariaLabel: "Markdown document",
    ...(onOpenCitation ? { onOpenCitation } : {}),
  });
  const view = controller.mount(host);
  controller.setLibraryCitations(library);
  return {
    controller,
    view,
    async [Symbol.asyncDispose]() {
      await act(() => controller.destroy());
      host.remove();
    },
  };
}

function keyDown(view: ReturnType<typeof mount>["view"], key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return view.someProp("handleKeyDown", (handler) => handler(view, event)) ?? false;
}

describe("Library citations in the Markdown editor", () => {
  it("offers Library sources after [@ and inserts the chosen key", async () => {
    await using editor = mount("See\n");
    const { controller, view } = editor;
    await act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      view.dispatch(view.state.tr.insertText(" [@tur"));
    });
    expect(controller.getSnapshot().citationItems.map((item) => item.citationKey)).toEqual([
      "turing1950computing",
    ]);

    await act(() => expect(keyDown(view, "Enter")).toBe(true));
    expect(controller.session.session.draftSource).toBe("See [@turing1950computing]\n");
    expect(controller.getSnapshot().citationItems).toEqual([]);
  });

  it("closes on Escape and leaves the typed text alone", async () => {
    await using editor = mount("See\n");
    const { controller, view } = editor;
    await act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      view.dispatch(view.state.tr.insertText(" [@"));
    });
    expect(controller.getSnapshot().citationItems).toHaveLength(2);
    await act(() => expect(keyDown(view, "Escape")).toBe(true));
    expect(controller.getSnapshot().citationItems).toEqual([]);
    await act(() => view.dispatch(view.state.tr.insertText("l")));
    expect(controller.getSnapshot().citationItems).toEqual([]);
    expect(controller.session.session.draftSource).toBe("See [@l\n");
  });

  it("opens the source of a clicked citation while reading", async () => {
    const onOpenCitation = vi.fn(() => true);
    await using editor = mount("See [@lovelace1843notes; @other].\n", onOpenCitation, "read");
    const { view } = editor;
    let citationPosition = -1;
    view.state.doc.descendants((node, position) => {
      if (node.type.name === "citation") citationPosition = position;
    });
    const citation = view.state.doc.nodeAt(citationPosition);
    if (!citation) throw new Error("Expected a citation node.");
    // ProseMirror's click handler, called directly: a click placed by coordinates depends on
    // what else a CI shard has left on the page.
    const click = new MouseEvent("click", { bubbles: true, button: 0 });
    await act(() =>
      expect(
        view.someProp("handleClickOn", (handler) =>
          handler(view, citationPosition, citation, citationPosition, click, true),
        ),
      ).toBe(true),
    );
    expect(onOpenCitation).toHaveBeenCalledWith(["lovelace1843notes", "other"]);
  });

  it("follows a citation on Control-click while writing", async () => {
    const onOpenCitation = vi.fn(() => true);
    await using editor = mount("See [@lovelace1843notes].\n", onOpenCitation);
    const field = editor.view.dom.querySelector<HTMLInputElement>(
      '[data-scient-markdown-reference="citation"] input',
    );
    if (!field) throw new Error("Expected the citation source field.");
    await act(() => {
      field.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: true }));
    });
    expect(onOpenCitation).toHaveBeenCalledWith(["lovelace1843notes"]);
  });
});
