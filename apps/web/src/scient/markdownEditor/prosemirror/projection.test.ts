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
  it("projects an empty file as one writable paragraph without changing its bytes", () => {
    const projection = createScientMarkdownProjection("");

    expect(projection.document.childCount).toBe(1);
    expect(projection.document.firstChild?.type.name).toBe("paragraph");
    expect(serializeScientMarkdownProjection(projection, projection.document)).toBe("");
  });

  it("returns exact Markdown when the projected document is untouched", () => {
    const projection = createScientMarkdownProjection(SOURCE);
    expect(serializeScientMarkdownProjection(projection, projection.document)).toBe(SOURCE);
  });

  it("round-trips 250 varied Unicode and CRLF projections without normalization", () => {
    const words = ["result", "תוצאה", "نتيجة", "😀", "e\u0301", "\u2067RTL\u2069"];
    for (let seed = 0; seed < 250; seed += 1) {
      const eol = seed % 2 === 0 ? "\n" : "\r\n";
      const left = words[seed % words.length];
      const right = words[(seed * 7 + 3) % words.length];
      const source =
        [
          ...(seed % 5 === 0 ? ["---", `title: ${left}`, "---", ""] : []),
          `${"#".repeat((seed % 6) + 1)} ${left} ${right}`,
          "",
          `Paragraph  with __${left}__ and &copy; ${right}.`,
          "",
          `- ${left}`,
          `  ${seed % 2 === 0 ? "+" : "*"} nested ${right}`,
          "",
          `| Name|Value |`,
          `|:--| --:|`,
          `| ${left} | ${seed} |`,
          "",
          seed % 3 === 0 ? `<!-- malformed -- ${right} -->` : `$$${left}_${seed}$$`,
          ...(seed % 4 === 0 ? ["", "````text meta=kept", `${left} ${right}`, "````"] : []),
        ].join(eol) + (seed % 3 === 0 ? "" : eol);
      const projection = createScientMarkdownProjection(source);
      expect(serializeScientMarkdownProjection(projection, projection.document)).toBe(source);
    }
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

  it("patches text without normalizing list markers or emphasis delimiters", () => {
    const source = "- parent\n  * nested __item__\n  * untouched  spacing\n";
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    let itemPosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "item") itemPosition = position;
    });
    expect(itemPosition).not.toBeNull();

    state.applyTransaction(
      state.state.tr.insertText("result", itemPosition!, itemPosition! + "item".length),
      "user",
    );

    expect(state.session.draftSource).toBe(
      "- parent\n  * nested __result__\n  * untouched  spacing\n",
    );
  });

  it("patches a table cell without normalizing the table source", () => {
    const source = "| Name|Value |\n|:--| --:|\n|  A  | **2.4** |\n";
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    let valuePosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "2.4") valuePosition = position;
    });
    expect(valuePosition).not.toBeNull();

    state.applyTransaction(
      state.state.tr.insertText("3.1", valuePosition!, valuePosition! + "2.4".length),
      "user",
    );

    expect(state.session.draftSource).toBe("| Name|Value |\n|:--| --:|\n|  A  | **3.1** |\n");
  });

  it("projects task lists, strikethrough, and wiki links as editable rich structure", () => {
    const source = [
      "- [x] Collected",
      "- [ ] Analyze",
      "",
      "Keep ~~obsolete~~ notes in [[Methods/Protocol|the protocol]].",
      "",
    ].join("\n");
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    const list = state.state.doc.firstChild;
    expect(list?.type.name).toBe("bullet_list");
    expect(list?.child(0).attrs.taskChecked).toBe(true);
    expect(list?.child(1).attrs.taskChecked).toBe(false);

    let strikeText = false;
    let wikiPosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "obsolete") {
        strikeText = node.marks.some((mark) => mark.type.name === "strike");
      }
      if (node.type.name === "wiki_link") wikiPosition = position;
    });
    expect(strikeText).toBe(true);
    expect(wikiPosition).not.toBeNull();
    expect(state.state.doc.nodeAt(wikiPosition!)?.attrs).toMatchObject({
      label: "the protocol",
      target: "Methods/Protocol",
    });

    state.applyTransaction(
      state.state.tr.setNodeMarkup(wikiPosition!, undefined, {
        label: "updated protocol",
        target: "Methods/Updated",
      }),
      "user",
    );
    expect(state.session.draftSource).toContain(
      "Keep ~~obsolete~~ notes in [[Methods/Updated|updated protocol]].",
    );
  });

  it("serializes a task checkbox change without touching the following block", () => {
    const source = "- [x] Complete\n- [ ] Pending\n\nFollowing  bytes.\n";
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    const list = state.state.doc.firstChild!;
    const firstItemPosition = 1;
    state.applyTransaction(
      state.state.tr.setNodeMarkup(firstItemPosition, undefined, {
        ...list.child(0).attrs,
        taskChecked: false,
      }),
      "user",
    );

    expect(state.session.draftSource).toContain("- [ ] Complete\n- [ ] Pending");
    expect(state.session.draftSource.endsWith("\n\nFollowing  bytes.\n")).toBe(true);
  });

  it("projects citations and footnotes as rich references with editable source", () => {
    const source = [
      "Evidence [@smith2020, pp. 2-3] and note[^lab].",
      "",
      "[^lab]: Collected **twice**.",
      "",
    ].join("\n");
    const state = new ScientProseMirrorSession({ source, revision: "sha256:before" });
    let citationPosition: number | null = null;
    let footnoteReferencePosition: number | null = null;
    let footnoteDefinitionPosition: number | null = null;
    state.state.doc.descendants((node, position) => {
      if (node.type.name === "citation") citationPosition = position;
      if (node.type.name === "footnote_reference") footnoteReferencePosition = position;
      if (node.type.name === "footnote_definition") footnoteDefinitionPosition = position;
    });

    expect(state.state.doc.nodeAt(citationPosition!)?.attrs.source).toBe("@smith2020, pp. 2-3");
    expect(state.state.doc.nodeAt(footnoteReferencePosition!)?.attrs.label).toBe("lab");
    expect(state.state.doc.nodeAt(footnoteDefinitionPosition!)?.attrs).toMatchObject({
      label: "lab",
      source: "[^lab]: Collected **twice**.",
    });

    state.applyTransaction(
      state.state.tr.setNodeMarkup(citationPosition!, undefined, {
        source: "@smith2020, p. 4",
      }),
      "user",
    );
    expect(state.session.draftSource).toContain("Evidence [@smith2020, p. 4] and note[^lab].");
    expect(state.session.draftSource.endsWith("\n\n[^lab]: Collected **twice**.\n")).toBe(true);
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
