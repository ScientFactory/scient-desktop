import { describe, expect, it } from "vite-plus/test";

import { createScientMarkdownProjection } from "./prosemirror/projection";
import {
  nextScientMarkdownFootnoteLabel,
  scientMarkdownFootnoteDefinitionId,
  scientMarkdownFootnotePresentation,
  scientMarkdownFootnoteReferenceId,
} from "./footnotes";

describe("Markdown footnotes", () => {
  it("numbers labels by first use while retaining every reference and definition position", () => {
    const { document } = createScientMarkdownProjection(
      "First[^shared], second[^other], repeated[^shared].\n\n[^other]: Other.\n\n[^shared]: Shared.\n",
    );
    const presentation = scientMarkdownFootnotePresentation(document);

    expect(presentation.get("shared")).toMatchObject({ number: 1 });
    expect(presentation.get("shared")?.referencePositions).toHaveLength(2);
    expect(presentation.get("shared")?.definitionPosition).not.toBeNull();
    expect(presentation.get("other")).toMatchObject({ number: 2 });
    expect(presentation.get("other")?.referencePositions).toHaveLength(1);
  });

  it("keeps unreferenced definitions unnumbered and allocates a collision-free authoring label", () => {
    const { document } = createScientMarkdownProjection(
      "Existing[^note-1].\n\n[^note-1]: Used.\n\n[^note-3]: Retained.\n",
    );
    const presentation = scientMarkdownFootnotePresentation(document);

    expect(presentation.get("note-3")).toMatchObject({ number: null });
    expect(nextScientMarkdownFootnoteLabel(document)).toBe("note-2");
  });

  it("builds deterministic internal anchors without exposing the label as presentation", () => {
    expect(scientMarkdownFootnoteDefinitionId("résumé note")).toBe(
      "scient-footnote-r%C3%A9sum%C3%A9%20note",
    );
    expect(scientMarkdownFootnoteReferenceId("résumé note", 2)).toBe(
      "scient-footnote-r%C3%A9sum%C3%A9%20note-reference-2",
    );
  });
});
