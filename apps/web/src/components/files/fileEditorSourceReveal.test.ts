import { expect, it, vi } from "vite-plus/test";
import type { Editor } from "@pierre/diffs/edit";
import { revealFileEditorSelection } from "./fileEditorSourceReveal";

it("moves the source model selection while retaining its viewport and preview focus", () => {
  const source = "first\r\nselected word";
  const editor = {
    getFile: () => ({ contents: source }),
    getText: () => source,
    getViewState: () => ({ view: { scrollLeft: 19, scrollTop: 600 } }),
    setViewState: vi.fn(),
    setSelections: vi.fn(),
    focus: vi.fn(),
  };
  expect(
    revealFileEditorSelection(editor as unknown as Editor<"file", unknown, undefined>, {
      source,
      from: 7,
      to: 15,
      requestId: 1,
    }),
  ).toBe(true);
  expect(editor.setViewState).toHaveBeenCalledWith({
    selections: [
      { start: { line: 1, character: 0 }, end: { line: 1, character: 8 }, direction: 1 },
    ],
    view: { scrollLeft: 19, scrollTop: 600 },
  });
  expect(editor.setSelections).not.toHaveBeenCalled();
  expect(editor.focus).not.toHaveBeenCalled();
});

it("refuses stale source or an unattached editor", () => {
  const editor = { getFile: () => undefined, getText: () => "changed", setViewState: vi.fn() };
  expect(
    revealFileEditorSelection(editor as unknown as Editor<"file", unknown, undefined>, {
      source: "old",
      from: 0,
      to: 3,
      requestId: 1,
    }),
  ).toBe(false);
  expect(editor.setViewState).not.toHaveBeenCalled();
});
