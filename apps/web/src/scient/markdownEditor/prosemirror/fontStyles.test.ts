import { TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import { describe, expect, it } from "vite-plus/test";
import {
  runScientMarkdownCommand,
  runScientMarkdownDocumentFont,
  type ScientMarkdownCommand,
} from "./commands";
import { scientMarkdownSchema } from "./schema";
import { ScientProseMirrorSession } from "./session";

function open(source: string) {
  return new ScientProseMirrorSession({ source, revision: "r0" });
}

/** Select the text of the first paragraph between two text offsets. */
function select(session: ScientProseMirrorSession, from: number, to: number) {
  session.applyTransaction(
    session.state.tr.setSelection(TextSelection.create(session.state.doc, 1 + from, 1 + to)),
    "user",
  );
}

function run(session: ScientProseMirrorSession, command: ScientMarkdownCommand) {
  runScientMarkdownCommand(command, session.state, (tr) => session.applyTransaction(tr, "user"));
}

function markedText(session: ScientProseMirrorSession, markName: string) {
  const found: string[] = [];
  session.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === markName)) {
      found.push(node.text ?? "");
    }
  });
  return found;
}

describe("Markdown font size and family", () => {
  it("reads the recognised span forms as marks", () => {
    const session = open(
      `a <span style="font-size:14pt">big</span> and <span style="font-family:'Courier New'">code</span>\n`,
    );
    expect(markedText(session, "font_size")).toEqual(["big"]);
    expect(markedText(session, "font_family")).toEqual(["code"]);
    const size = session.state.doc.firstChild!.child(1).marks[0]!;
    expect(size.attrs.size).toBe(14);
  });

  it.each([
    '<span style="font-size:1.2em">x</span>',
    '<span style="font-size:300pt">x</span>',
    '<span style="color:red">x</span>',
    '<span style="font-family:Arial">x</span>',
    `<span style="font-family:'Comic Sans MS'">x</span>`,
    '<span style="font-size:14pt" class="a">x</span>',
    '<span style="font-size:14pt">unclosed',
    "plain </span> stray close",
  ])("leaves other HTML as text: %s", (source) => {
    const session = open(`${source}\n`);
    expect(markedText(session, "font_size")).toEqual([]);
    expect(markedText(session, "font_family")).toEqual([]);
    expect(session.session.draftSource).toBe(`${source}\n`);
  });

  it("keeps the outer text size when a size span sits inside another size span", () => {
    const source =
      'a <span style="font-size:12pt">x <span style="font-size:20pt">y</span> z</span>\n';
    const session = open(source);
    // The outer span stays source, so " z" keeps its meaning and the bytes are unchanged.
    expect(markedText(session, "font_size")).toEqual(["y"]);
    expect(session.session.draftSource).toBe(source);
  });

  it.each(["x `</span>` y", "x <!-- </span> --> y", "x a\\</span> b y"])(
    "leaves a span as source when its text hides a closing tag: %s",
    (inner) => {
      const source = `<span style="font-size:12pt">${inner}</span>\n`;
      const session = open(source);
      expect(markedText(session, "font_size")).toEqual([]);
      expect(session.session.draftSource).toBe(source);
    },
  );

  it("lets a size span sit inside a font span", () => {
    const session = open(
      `<span style="font-family:'Arial'">a <span style="font-size:20pt">b</span> c</span>\n`,
    );
    expect(markedText(session, "font_family")).toEqual(["a ", "b", " c"]);
    expect(markedText(session, "font_size")).toEqual(["b"]);
  });

  it("writes new front matter at the first byte, even before leading blank lines", () => {
    const session = open("\n\nHello\n");
    runScientMarkdownDocumentFont({ fontFamily: "Arial", fontSize: "12pt" }, session.state, (tr) =>
      session.applyTransaction(tr, "user"),
    );
    expect(session.session.draftSource).toBe(
      "---\nfontsize: 12pt\nmainfont: Arial\n---\n\nHello\n",
    );
  });

  it("applies, replaces and removes a size on a selection, writing the exact span", () => {
    const session = open("one two three\n");
    select(session, 4, 7);
    run(session, "font-size-14");
    expect(session.session.draftSource).toBe('one <span style="font-size:14pt">two</span> three\n');
    run(session, "font-size-9.5");
    expect(session.session.draftSource).toBe(
      'one <span style="font-size:9.5pt">two</span> three\n',
    );
    run(session, "font-size-default");
    expect(session.session.draftSource).toBe("one two three\n");
  });

  it("applies a size to the word around a caret, and removes it the same way", () => {
    const session = open("one two three\n");
    select(session, 5, 5);
    run(session, "font-size-14");
    expect(session.session.draftSource).toBe('one <span style="font-size:14pt">two</span> three\n');
    run(session, "font-size-default");
    expect(session.session.draftSource).toBe("one two three\n");
  });

  it("keeps a caret between words as typing marks and leaves the text unchanged", () => {
    const session = open("one  two\n");
    select(session, 4, 4);
    run(session, "font-size-14");
    expect(session.session.draftSource).toBe("one  two\n");
    expect(session.state.storedMarks?.map((mark) => mark.type.name)).toEqual(["font_size"]);
  });

  it("leaves whitespace at the ends of the selection outside the span", () => {
    const session = open("one two three\n");
    select(session, 3, 8);
    run(session, "font-size-18");
    expect(session.session.draftSource).toBe('one <span style="font-size:18pt">two</span> three\n');
  });

  it("never nests two sizes and keeps size and family as separate spans", () => {
    const session = open("one two three\n");
    select(session, 4, 7);
    run(session, "font-size-24");
    run(session, "font-family-Arial");
    const written = session.session.draftSource;
    expect(written.match(/font-size/gu)).toHaveLength(1);
    const reopened = open(written);
    expect(markedText(reopened, "font_size")).toEqual(["two"]);
    expect(markedText(reopened, "font_family")).toEqual(["two"]);
    expect(reopened.session.draftSource).toBe(written);
  });

  it("keeps bytes outside the edited range unchanged", () => {
    const session = open("# Title\n\nkeep   __this__ exactly\n\nsecond paragraph\n");
    session.applyTransaction(
      session.state.tr.setSelection(TextSelection.create(session.state.doc, 10, 14)),
      "user",
    );
    run(session, "font-size-16");
    const written = session.session.draftSource;
    expect(written.startsWith("# Title\n\n")).toBe(true);
    expect(written.endsWith("\n\nsecond paragraph\n")).toBe(true);
  });

  it("applies a size to every selected table cell", () => {
    const session = open("| A | B |\n| --- | --- |\n| c | d |\n");
    const cells: number[] = [];
    session.state.doc.descendants((node, position) => {
      if (node.type.name === "table_header") cells.push(position);
      return node.type.name === "table" || node.type.name === "table_row";
    });
    session.applyTransaction(
      session.state.tr.setSelection(CellSelection.create(session.state.doc, cells[0]!, cells[1]!)),
      "user",
    );
    run(session, "font-size-14");
    expect(markedText(session, "font_size")).toEqual(["A", "B"]);
  });

  it("round-trips a span inside bold, a list item and a table cell", () => {
    for (const source of [
      '**a <span style="font-size:16pt">b</span> c**\n',
      `- item <span style="font-family:'Times New Roman'">x</span>\n`,
      '| A |\n| --- |\n| <span style="font-size:8pt">t</span> |\n',
    ]) {
      const session = open(source);
      expect(
        markedText(session, source.includes("family") ? "font_family" : "font_size"),
      ).toHaveLength(1);
      const reopened = open(session.session.draftSource);
      expect(
        markedText(reopened, source.includes("family") ? "font_family" : "font_size"),
      ).toHaveLength(1);
    }
  });

  it.each([
    '- a <span style="font-size:12pt">x `</span>` y</span>',
    '- a <span style="font-size:12pt">x `<span>` y</span>',
    '- <span style="font-size:12pt">[</span>](https://example.com) y</span>',
  ])("keeps a block whose span text contains tags in code or links: %s", (block) => {
    const source = `${block}\n\nsecond paragraph\n`;
    const session = open(source);
    // Edit the other paragraph: the block above must come back byte for byte.
    session.applyTransaction(
      session.state.tr.setSelection(
        TextSelection.create(session.state.doc, session.state.doc.content.size - 8),
      ),
      "user",
    );
    session.applyTransaction(session.state.tr.insertText("X"), "user");
    const written = session.session.draftSource;
    expect(written).toContain("X");
    expect(written.startsWith(`${block}\n\n`)).toBe(true);
  });

  it("defines both marks in the schema", () => {
    expect(scientMarkdownSchema.marks.font_size).toBeDefined();
    expect(scientMarkdownSchema.marks.font_family).toBeDefined();
  });

  it("ignores pasted HTML whose size or family is not a known size or font", () => {
    const parseRule = (markName: "font_size" | "font_family") => {
      const rule = scientMarkdownSchema.marks[markName]?.spec.parseDOM?.[0];
      return rule?.getAttrs as (element: { getAttribute: (name: string) => string }) => unknown;
    };
    const attribute = (value: string) => ({ getAttribute: () => value });
    expect(parseRule("font_size")(attribute("14"))).toEqual({ size: 14 });
    expect(parseRule("font_size")(attribute("1000"))).toBe(false);
    expect(parseRule("font_size")(attribute("x;background:url(https://example.invalid)"))).toBe(
      false,
    );
    expect(parseRule("font_family")(attribute("Arial"))).toEqual({ family: "Arial" });
    expect(parseRule("font_family")(attribute("Comic Sans MS"))).toBe(false);
    expect(parseRule("font_family")(attribute('Arial" onmouseover="alert(1)'))).toBe(false);
  });
});
