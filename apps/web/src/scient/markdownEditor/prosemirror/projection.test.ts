import { describe, expect, it } from "vite-plus/test";

import {
  createScientMarkdownProjection,
  serializeScientMarkdownProjection,
  withProjectedDocument,
} from "./projection";
import { ScientProseMirrorSession } from "./session";

const SOURCE = [
  "---",
  'title: "Source fidelity"',
  "---",
  "",
  "# Results",
  "",
  "Paragraph with  deliberate spacing.",
  "",
  "- first",
  "  - nested",
  "",
  "| Group | Mean |",
  "| :--- | ---: |",
  "| A | 2.4 |",
  "",
].join("\n");

describe("Scient ProseMirror projection", () => {
  it("returns exact Markdown when the projected document is untouched", () => {
    const projection = createScientMarkdownProjection(SOURCE);
    expect(serializeScientMarkdownProjection(projection, projection.document)).toBe(SOURCE);
  });

  it("serializes only an edited paragraph and preserves unsupported blocks verbatim", () => {
    const projection = createScientMarkdownProjection(SOURCE);
    let paragraphPosition: number | null = null;
    projection.document.forEach((node, offset) => {
      if (paragraphPosition === null && node.type.name === "paragraph")
        paragraphPosition = offset + 1;
    });
    expect(paragraphPosition).not.toBeNull();
    const state = new ScientProseMirrorSession({ source: SOURCE, revision: "sha256:before" });
    const transaction = state.state.tr.insertText(
      "Updated ",
      paragraphPosition!,
      paragraphPosition!,
    );
    state.applyTransaction(transaction, "user");

    const next = state.session.draftSource;
    expect(next).toContain("Updated Paragraph with  deliberate spacing.");
    expect(next).toContain("- first\n  - nested");
    expect(next).toContain("| Group | Mean |\n| :--- | ---: |\n| A | 2.4 |");
    expect(next.startsWith('---\ntitle: "Source fidelity"\n---\n')).toBe(true);
  });

  it("keeps a GFM table rendered and rewrites only its source block after a cell edit", () => {
    const state = new ScientProseMirrorSession({ source: SOURCE, revision: "sha256:before" });
    const table = state.state.doc.lastChild;
    expect(table?.type.name).toBe("table");
    expect(table?.child(0).child(0).type.name).toBe("table_header");
    expect(table?.child(1).child(1).textContent).toBe("2.4");

    let meanPosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "2.4") meanPosition = position;
    });
    expect(meanPosition).not.toBeNull();
    state.applyTransaction(
      state.state.tr.insertText("3.1", meanPosition!, meanPosition! + "2.4".length),
      "user",
    );

    const next = state.session.draftSource;
    const tableStart = SOURCE.indexOf("| Group");
    expect(next.slice(0, tableStart)).toBe(SOURCE.slice(0, tableStart));
    expect(next).toContain("| A | 3.1 |");
    expect(next).not.toContain("2.4");
  });

  it("rewrites one changed list block without touching surrounding source", () => {
    const source = "# Before\n\n- first\n  - nested\n\nAfter  with spacing.\n";
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    let nestedPosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "nested") nestedPosition = position;
    });
    expect(nestedPosition).not.toBeNull();
    state.applyTransaction(
      state.state.tr.insertText(
        "deeply nested",
        nestedPosition!,
        nestedPosition! + "nested".length,
      ),
      "user",
    );

    expect(state.session.draftSource.startsWith("# Before\n\n")).toBe(true);
    expect(state.session.draftSource).toContain("deeply nested");
    expect(state.session.draftSource.endsWith("\n\nAfter  with spacing.\n")).toBe(true);
  });

  it("preserves CRLF fences and raw blocks around a mixed-direction edit", () => {
    const source = [
      "~~~python linenos",
      'print("עברית 😀")',
      "~~~",
      "",
      "פסקה בעברית with **bold**.",
      "",
      "<!-- keep  exact -->",
      "",
    ].join("\r\n");
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    let hebrewPosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.isText && node.text?.includes("פסקה בעברית")) {
        hebrewPosition = position + "פסקה ".length;
      }
    });
    expect(hebrewPosition).not.toBeNull();
    state.applyTransaction(
      state.state.tr.insertText("חדשה", hebrewPosition!, hebrewPosition! + "בעברית".length),
      "user",
    );

    expect(state.session.draftSource).toContain(
      '~~~python linenos\r\nprint("עברית 😀")\r\n~~~\r\n\r\n',
    );
    expect(state.session.draftSource).toContain("פסקה חדשה with **bold**.");
    expect(state.session.draftSource.endsWith("\r\n\r\n<!-- keep  exact -->\r\n")).toBe(true);
  });

  it("keeps inline and display math as rich nodes and rewrites only the edited source block", () => {
    const source = [
      "Energy is $E=mc^2$.",
      "",
      "$$",
      "\\int_0^1 x \\, dx",
      "$$",
      "",
      "Untouched  spacing.",
      "",
    ].join("\n");
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    let inlineMathPosition: number | null = null;
    let displayMathPosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.type.name === "inline_math") inlineMathPosition = position;
      if (node.type.name === "display_math") displayMathPosition = position;
    });

    expect(inlineMathPosition).not.toBeNull();
    expect(displayMathPosition).not.toBeNull();
    expect(state.state.doc.nodeAt(inlineMathPosition!)?.attrs.tex).toBe("E=mc^2");
    expect(state.state.doc.nodeAt(displayMathPosition!)?.attrs.tex).toBe("\\int_0^1 x \\, dx");

    state.applyTransaction(
      state.state.tr.setNodeMarkup(inlineMathPosition!, undefined, {
        ...state.state.doc.nodeAt(inlineMathPosition!)?.attrs,
        tex: "E=mc^3",
      }),
      "user",
    );

    expect(state.session.draftSource).toBe(
      [
        "Energy is $E=mc^3$.",
        "",
        "$$",
        "\\int_0^1 x \\, dx",
        "$$",
        "",
        "Untouched  spacing.",
        "",
      ].join("\n"),
    );
  });

  it("keeps the projection immutable when replacing only the current document", () => {
    const projection = createScientMarkdownProjection("One\n");
    const next = withProjectedDocument(projection, projection.document);
    expect(next).not.toBe(projection);
    expect(next.ledger).toBe(projection.ledger);
    expect(next.baselineDocument).toBe(projection.baselineDocument);
  });
});
