import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { closeHistory, history, undo, redo } from "@tiptap/pm/history";
import { describe, expect, it } from "vite-plus/test";
import { latexParagraphDirection, setLatexParagraphDirection } from "./latexParagraphDirection";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { sourceId: { default: null }, latexNoIndent: { default: false } },
    },
    text: { group: "inline" },
    latexInlineMath: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { tex: { default: "" }, wrapper: { default: "paren" } },
    },
    latexScientific: {
      group: "block",
      content: "block+",
      attrs: {
        environment: { default: "" },
        title: { default: "" },
        titleSource: { default: null },
        titleRemoved: { default: false },
        raw: { default: "" },
        sourceId: { default: null },
        layout: { default: null },
        layoutGap: { default: null },
      },
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: {
        level: { default: 1 },
        sourceId: { default: null },
        unnumbered: { default: false },
        referenceLabel: { default: null },
      },
    },
  },
  marks: { bold: {}, italic: {} },
});
const setup =
  "\\documentclass{article}\n\\usepackage{polyglossia}\n\\setdefaultlanguage{hebrew}\n\\setotherlanguage{english}\n";
const document = (body: string) => setup + "\\begin{document}\n" + body + "\n\\end{document}\n";

function fixture(body: string, rootSetup = setup) {
  const source = rootSetup + "\\begin{document}\n" + body + "\n\\end{document}\n";
  const projection = projectLatexVisualDocument(source);
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(projection.content),
    plugins: [history()],
  });
  const dispatch = (tr: Parameters<EditorState["apply"]>[0]) => {
    state = state.apply(tr);
  };
  const select = (from: number, to = from) =>
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  const set = (direction: "ltr" | "rtl") => {
    const result = setLatexParagraphDirection(state, dispatch, direction, source, rootSetup);
    dispatch(closeHistory(state.tr));
    return result;
  };
  const output = () =>
    applyLatexVisualDocumentChange(source, projection, state.doc.toJSON())?.source;
  return {
    source,
    get state() {
      return state;
    },
    dispatch,
    select,
    set,
    output,
  };
}

describe("LaTeX paragraph direction", () => {
  it("enables direction on a plain English document and saves the necessary setup", () => {
    const test = fixture(
      "Text \\textbf{bold} $x^2$.\n\nNeighbour.",
      "\\documentclass{article}\n\\usepackage{hyperref}\n",
    );
    test.select(3);
    expect(test.set("rtl")).toBe(true);
    expect(test.output()).toBe(
      "% !TEX program = xelatex\n\\documentclass{article}\n\\usepackage{hyperref}\n\\usepackage{bidi}\n\\begin{document}\n\\begin{RTL}\nText \\textbf{bold} $x^2$.\n\\end{RTL}\n\nNeighbour.\n\\end{document}\n",
    );
    expect(undo(test.state, test.dispatch)).toBe(true);
    expect(test.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(test.state.doc.textContent).toBe("Text bold .Neighbour.");
  });

  it("retains command spelling, comments and CRLF inside the selected paragraph", () => {
    const test = fixture("A \\emph{word} % retained comment\r\nand text.");
    test.select(2);
    expect(test.set("rtl")).toBe(true);
    expect(test.output()).toBe(
      document("\\begin{RTL}\r\nA \\emph{word} % retained comment\r\nand text.\r\n\\end{RTL}"),
    );
  });

  it("keeps pending typing and separates typing before and after the direction command in Undo", () => {
    const test = fixture("Text.");
    test.select(2);
    test.dispatch(test.state.tr.insertText("before"));
    expect(test.set("ltr")).toBe(true);
    test.dispatch(test.state.tr.insertText("after"));
    expect(undo(test.state, test.dispatch)).toBe(true);
    expect(test.state.doc.firstChild?.attrs.layout.direction).toBe("ltr");
    expect(test.state.doc.textContent).toBe("Tbeforeext.");
    expect(undo(test.state, test.dispatch)).toBe(true);
    expect(test.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(test.state.doc.textContent).toBe("Tbeforeext.");
    expect(undo(test.state, test.dispatch)).toBe(true);
    expect(test.output()).toBe(test.source);
  });

  it("changes only the caret paragraph and retains exact bold/math source and neighbours", () => {
    const test = fixture("\\textbf{שלום} with $x^2$\n\nNeighbour.");
    test.select(3);
    expect(latexParagraphDirection(test.state, "rtl")?.value).toBe("rtl");
    expect(test.set("ltr")).toBe(true);
    expect(test.state.doc.firstChild?.attrs.layout.direction).toBe("ltr");
    expect(test.state.selection.from).toBe(4);
    expect(test.output()).toBe(
      document("\\begin{LTR}\n\\textbf{שלום} with $x^2$\n\\end{LTR}\n\nNeighbour."),
    );
    expect(undo(test.state, test.dispatch)).toBe(true);
    expect(test.output()).toBe(test.source);
    expect(redo(test.state, test.dispatch)).toBe(true);
    expect(test.output()).toContain("\\begin{LTR}");
  });

  it("wraps selected paragraphs in one undo operation and preserves backwards selection", () => {
    const test = fixture("First.\n\nSecond.\n\nThird.");
    test.select(14, 2);
    const selectedText = test.state.doc.textBetween(
      test.state.selection.from,
      test.state.selection.to,
      "\n",
    );
    expect(test.set("ltr")).toBe(true);
    expect(test.state.selection.anchor).toBeGreaterThan(test.state.selection.head);
    expect(
      test.state.doc.textBetween(test.state.selection.from, test.state.selection.to, "\n"),
    ).toBe(selectedText);
    expect(test.output()?.match(/\\begin\{LTR\}/gu)).toHaveLength(2);
    expect(test.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(undo(test.state, test.dispatch)).toBe(true);
    expect(test.output()).toBe(test.source);
  });

  it("changes an existing paragraph override without accumulating wrappers", () => {
    const test = fixture("\\begin{LTR}\nText.\n\\end{LTR}");
    test.select(3);
    expect(test.set("rtl")).toBe(true);
    expect(test.output()).toBe(document("\\begin{RTL}\nText.\n\\end{RTL}"));
    expect(test.state.doc.firstChild?.firstChild?.type.name).toBe("paragraph");
    expect(test.set("rtl")).toBe(true);
    expect(test.state.doc.firstChild?.firstChild?.type.name).toBe("paragraph");
  });

  it("overrides one paragraph inside a language block and retains its language and sibling", () => {
    const test = fixture("\\begin{english}\nFirst.\n\nSecond.\n\\end{english}");
    test.select(3);
    expect(test.set("rtl")).toBe(true);
    expect(test.state.doc.firstChild?.attrs.layout.language).toBe("english");
    expect(test.output()).toBe(
      document("\\begin{english}\n\\begin{RTL}\nFirst.\n\\end{RTL}\n\nSecond.\n\\end{english}"),
    );
  });

  it("refuses objects and ranges containing headings", () => {
    const test = fixture("Text.\n\n\\section{Heading}\n\nEnd.");
    test.dispatch(test.state.tr.setSelection(NodeSelection.create(test.state.doc, 0)));
    expect(test.set("ltr")).toBe(false);
    test.select(2, test.state.doc.content.size - 2);
    expect(test.set("ltr")).toBe(false);
    expect(test.output()).toBe(test.source);
  });
});
