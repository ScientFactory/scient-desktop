import { describe, expect, it, vi } from "vite-plus/test";
import { EditorState } from "prosemirror-state";
import { scientMarkdownParser } from "./schema";
import {
  configureScientMarkdownSearch,
  scientMarkdownSearchPlugin,
  scientMarkdownSearchState,
} from "./search";

describe("Markdown search work", () => {
  it("does not traverse the document when no search is active", () => {
    const doc = scientMarkdownParser.parse("# Title\n\nLarge body\n");
    const traverse = vi.spyOn(doc, "descendants");
    let state = EditorState.create({ doc, plugins: [scientMarkdownSearchPlugin()] });
    expect(traverse).not.toHaveBeenCalled();
    state = state.apply(
      configureScientMarkdownSearch(state.tr, {
        query: "body",
        caseSensitive: false,
        wholeWord: false,
      }),
    );
    expect(traverse).toHaveBeenCalledOnce();
    expect(scientMarkdownSearchState(state).matches).toHaveLength(1);
    traverse.mockClear();
    state = state.apply(
      configureScientMarkdownSearch(state.tr, {
        query: "",
        caseSensitive: false,
        wholeWord: false,
      }),
    );
    expect(traverse).not.toHaveBeenCalled();
    expect(scientMarkdownSearchState(state).matches).toEqual([]);
    expect(scientMarkdownSearchState(state).decorations.find()).toEqual([]);
    traverse.mockRestore();
    const transaction = state.tr.insertText("Edited ", 1);
    const editedTraverse = vi.spyOn(transaction.doc, "descendants");
    state = state.apply(transaction);
    expect(editedTraverse).not.toHaveBeenCalled();
    expect(scientMarkdownSearchState(state).matches).toEqual([]);
    editedTraverse.mockRestore();
  });
});
