// Tests how the font size and family are read from a selection, including mixed selections.
import type { Editor } from "@tiptap/core";
import { describe, expect, it } from "vite-plus/test";
import { latexFontState } from "./latexFontCommands";

const mark = (name: string, attrs: Record<string, unknown>) => ({ type: { name }, attrs });

/** A stub editor whose selection covers the given runs of text, each with its own marks. */
function editorOver(runs: ReadonlyArray<ReadonlyArray<ReturnType<typeof mark>>>): Editor {
  return {
    state: {
      selection: { empty: false, from: 0, to: 10 },
      storedMarks: null,
      doc: {
        nodesBetween: (_from: number, _to: number, visit: (node: unknown) => void) =>
          runs.forEach((marks) => visit({ isText: true, marks })),
      },
    },
  } as unknown as Editor;
}

const size = (points: number) => mark("latexFontSize", { points });
const family = (name: string) => mark("latexFontFamily", { family: name });

describe("latexFontState", () => {
  it("reports the shared size even when the fonts differ", () => {
    const state = latexFontState(editorOver([[size(14), family("Garamond")], [size(14)]]));
    expect(state).toMatchObject({ size: 14, sizeMixed: false, familyMixed: true });
  });

  it("reports mixed sizes as an empty value with the mixed flag", () => {
    const state = latexFontState(editorOver([[size(14)], [size(18)]]));
    expect(state).toMatchObject({ size: null, sizeMixed: true });
  });

  it("treats text without a size next to sized text as mixed", () => {
    expect(latexFontState(editorOver([[size(14)], []])).sizeMixed).toBe(true);
  });

  it("reports no size and no mix for text with no size at all", () => {
    expect(latexFontState(editorOver([[], []]))).toMatchObject({
      size: null,
      family: null,
      sizeMixed: false,
      familyMixed: false,
    });
  });
});
