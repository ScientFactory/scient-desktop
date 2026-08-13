import { describe, expect, it } from "@effect/vitest";

import {
  normalizeScientSourceAbstract,
  normalizeScientSourceAbstractDocument,
} from "./abstract.ts";

describe("Scient source abstract normalization", () => {
  it("preserves ordinary text and paragraph boundaries", () => {
    expect(normalizeScientSourceAbstract("  First line\nwraps here.\n\nSecond paragraph.  ")).toBe(
      "First line wraps here.\n\nSecond paragraph.",
    );
  });

  it("converts structured JATS into readable headings and paragraphs", () => {
    const document = normalizeScientSourceAbstractDocument(
      '<jats:sec id="a"><jats:title>Importance</jats:title><jats:p>First &amp; second.</jats:p></jats:sec>' +
        '<jats:sec id="b"><jats:title>Results</jats:title><jats:p>Useful <jats:italic>evidence</jats:italic>.</jats:p></jats:sec>',
    );
    expect(document?.text).toBe("Importance\n\nFirst & second.\n\nResults\n\nUseful evidence.");
    expect(document?.sections).toEqual([
      { title: "Importance", paragraphs: ["First & second."] },
      { title: "Results", paragraphs: ["Useful evidence."] },
    ]);
  });

  it("preserves Europe PMC bodies that are bare text after explicit headings", () => {
    const document = normalizeScientSourceAbstractDocument(
      "<h4>Background</h4>Short stays may be avoidable." +
        "<h4>Methods</h4>This was a multicentre study." +
        "<h4>Results</h4>Short stays were common." +
        "<h4>Interpretation</h4>Care outside working hours may help.",
    );

    expect(document?.sections).toEqual([
      { title: "Background", paragraphs: ["Short stays may be avoidable."] },
      { title: "Methods", paragraphs: ["This was a multicentre study."] },
      { title: "Results", paragraphs: ["Short stays were common."] },
      { title: "Interpretation", paragraphs: ["Care outside working hours may help."] },
    ]);
  });

  it("keeps loose body text intact across inline markup", () => {
    expect(
      normalizeScientSourceAbstractDocument(
        "<h4>Results</h4>The finding was <i>clinically</i> important.",
      )?.sections,
    ).toEqual([{ title: "Results", paragraphs: ["The finding was clinically important."] }]);
  });

  it("rejects a structured abstract containing only empty headings", () => {
    expect(
      normalizeScientSourceAbstractDocument("<h4>Background</h4><h4>Methods</h4><h4>Results</h4>"),
    ).toBeNull();
  });

  it("removes a redundant abstract wrapper while preserving its content", () => {
    const document = normalizeScientSourceAbstractDocument(
      "<jats:title>Abstract</jats:title>" +
        "<jats:sec><jats:title>Background</jats:title><jats:p>Context.</jats:p></jats:sec>",
    );

    expect(document?.text).toBe("Background\n\nContext.");
    expect(document?.sections).toEqual([{ title: "Background", paragraphs: ["Context."] }]);
    expect(
      normalizeScientSourceAbstractDocument(
        "<jats:title>Abstract</jats:title><jats:p>Unstructured summary.</jats:p>",
      )?.sections,
    ).toEqual([{ title: null, paragraphs: ["Unstructured summary."] }]);
  });

  it("does not guess that a short plain-text paragraph is a heading", () => {
    expect(
      normalizeScientSourceAbstractDocument("Objective\n\nMeasure the outcome.")?.sections,
    ).toEqual([{ title: null, paragraphs: ["Objective", "Measure the outcome."] }]);
  });

  it("removes unsafe markup content instead of rendering it", () => {
    expect(
      normalizeScientSourceAbstract(
        "<p>Visible text.</p><script>steal()</script><style>p{display:none}</style><p>Still visible.</p>",
      ),
    ).toBe("Visible text.\n\nStill visible.");
  });

  it("returns null for empty markup", () => {
    expect(normalizeScientSourceAbstract("<p> </p>")).toBeNull();
    expect(normalizeScientSourceAbstract(null)).toBeNull();
  });
});
