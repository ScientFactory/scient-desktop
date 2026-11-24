import { TextSelection } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import { describe, expect, it } from "vite-plus/test";
import {
  runScientMarkdownCommand,
  runScientMarkdownDocumentFont,
  type ScientMarkdownCommand,
} from "./commands";
import { scientMarkdownSchema } from "./schema";
import { selectionMarkValue } from "./selectionMarkValue";
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
    expect(session.state.doc.firstChild!.type.name).toBe("raw_block");
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

  it("retains a list with same-kind nested spans as editable source", () => {
    const item = '- <span style="font-size:12pt">x <span style="font-size:20pt">y</span> z</span>';
    const session = open(item + "\n\nNext\n");
    expect(session.state.doc.firstChild!.type.name).toBe("raw_block");
    session.applyTransaction(
      session.state.tr.insertText("!", session.state.doc.content.size - 1),
      "user",
    );
    expect(session.session.draftSource).toBe(item + "\n\nNext!\n");
  });

  it("lets a size span sit inside a font span", () => {
    const session = open(
      `<span style="font-family:'Arial'">a <span style="font-size:20pt">b</span> c</span>\n`,
    );
    expect(markedText(session, "font_family")).toEqual(["a ", "b", " c"]);
    expect(markedText(session, "font_size")).toEqual(["b"]);
  });

  it("writes new front matter at the first byte, even before leading blank lines", () => {
    const session = open("\uFEFF\n\nHello\n");
    runScientMarkdownDocumentFont({ fontFamily: "Arial", fontSize: "12pt" }, session.state, (tr) =>
      session.applyTransaction(tr, "user"),
    );
    expect(session.session.draftSource).toBe(
      "\uFEFF---\nfontsize: 12pt\nmainfont: Arial\n---\n\n\nHello\n",
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

/** Insert text at a text offset of the first paragraph, as typing does (it inherits the marks). */
function type(session: ScientProseMirrorSession, offset: number, text: string) {
  session.applyTransaction(session.state.tr.insertText(text, 1 + offset), "user");
}

describe("Whitespace is not styled content", () => {
  it("accepts a space typed after a sized word and keeps typing unchanged", () => {
    const session = open("un bien mot\n");
    select(session, 3, 7);
    run(session, "font-size-14");
    type(session, 7, " ");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe('un <span style="font-size:14pt">bien</span>  mot\n');
    expect(markedText(session, "font_size")).toEqual(["bien"]);
    expect(markedText(open(session.session.draftSource), "font_size")).toEqual(["bien"]);
  });

  it("accepts a space typed after a bold word", () => {
    const session = open("a **b** c\n");
    type(session, 3, " ");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe("a **b**  c\n");
  });

  it("accepts italic over two sizes", () => {
    const session = open("aa bb cc\n");
    select(session, 0, 2);
    run(session, "font-size-14");
    select(session, 3, 5);
    run(session, "font-size-20");
    select(session, 1, 4);
    run(session, "italic");
    expect(session.pendingWriteback).toBeNull();
    // The space carries no style, and size tags stay outside the italic delimiters.
    expect(session.session.draftSource).toBe(
      '<span style="font-size:14pt">a*a*</span> <span style="font-size:20pt">*b*b</span> cc\n',
    );
  });

  it("accepts removing bold from the last word of a bold phrase", () => {
    const session = open("**one two**\n");
    select(session, 4, 7);
    run(session, "bold");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe("**one** two\n");
  });

  it("accepts another size on the text after a sized line break", () => {
    const session = open("one  \ntwo three\n");
    select(session, 0, 13);
    run(session, "font-size-14");
    select(session, 4, 9);
    run(session, "font-size-20");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe(
      '<span style="font-size:14pt">one</span>\\\n<span style="font-size:20pt">two t</span><span style="font-size:14pt">hree</span>\n',
    );
  });

  it.each([
    [
      "two line breaks then sized text",
      '<span style="font-size:14pt">ab\\\n\\\ncd</span>\n',
      0,
      '\\\n\\\n<span style="font-size:14pt">cd</span>\n',
    ],
    ["two line breaks then bold text", "**ab\\\n\\\ncd**\n", 0, "\\\n\\\n**cd**\n"],
    [
      "two line breaks between two sizes",
      '<span style="font-size:14pt">x</span><span style="font-size:20pt">ab\\\n\\\ncd</span>\n',
      1,
      '<span style="font-size:14pt">x</span>\\\n\\\n<span style="font-size:20pt">cd</span>\n',
    ],
  ])(
    "accepts deleting the text before %s: the whole run of whitespace leaves the tag",
    (_name, source, start, expected) => {
      const session = open(source);
      session.applyTransaction(session.state.tr.delete(1 + start, 1 + start + 2), "user");
      expect(session.pendingWriteback).toBeNull();
      expect(session.session.draftSource).toBe(expected);
    },
  );

  it("accepts a size on two bold words separated by a plain space", () => {
    const session = open("**a** **b**\n");
    select(session, 0, 3);
    run(session, "font-size-14");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe(
      '<span style="font-size:14pt">**a**</span> <span style="font-size:14pt">**b**</span>\n',
    );
    expect(markedText(open(session.session.draftSource), "font_size")).toEqual(["a", "b"]);
  });

  it("moves an edge space out of a tag when the paragraph is edited", () => {
    const session = open('a <span style="font-size:14pt"> two</span> b\n');
    select(session, 3, 6);
    run(session, "font-size-20");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe('a  <span style="font-size:20pt">two</span> b\n');
  });

  it("leaves the bytes of an untouched paragraph with edge spaces in its tag", () => {
    const source = 'a <span style="font-size:14pt"> two </span> b\n\nsecond\n';
    const session = open(source);
    session.applyTransaction(
      session.state.tr.insertText("X", session.state.doc.content.size - 1),
      "user",
    );
    expect(session.session.draftSource).toBe(source.replace("second", "secondX"));
  });

  it("applies a size around inline code, never to the code itself", () => {
    const session = open("aa `bb` cc\n");
    select(session, 0, 8);
    run(session, "font-size-14");
    expect(session.pendingWriteback).toBeNull();
    expect(markedText(session, "font_size")).toEqual(["aa", "cc"]);
    expect(markedText(open(session.session.draftSource), "font_size")).toEqual(["aa", "cc"]);
    expect(session.session.draftSource).toContain("`bb`");
    expect(session.session.draftSource).not.toMatch(/<span[^>]*>`/u);
  });

  it("does not set a typing size or font inside inline code", () => {
    const session = open("aa `bb` cc\n");
    select(session, 4, 4);
    run(session, "font-size-14");
    expect(session.state.storedMarks).toBeNull();
  });
});

describe("Size and font shown for a selection", () => {
  it("ignores the spaces between words sized one by one", () => {
    const session = open("one two three\n");
    for (const [from, to] of [
      [0, 3],
      [4, 7],
      [8, 13],
    ] as const) {
      select(session, from, to);
      run(session, "font-size-14");
    }
    select(session, 0, 13);
    expect(selectionMarkValue<number>(session.state, "font_size", "size", "number")).toEqual({
      value: 14,
      mixed: false,
    });
  });

  it("still reports a selection that mixes two sizes", () => {
    const session = open("one two\n");
    select(session, 0, 3);
    run(session, "font-size-14");
    select(session, 4, 7);
    run(session, "font-size-20");
    select(session, 0, 7);
    expect(selectionMarkValue<number>(session.state, "font_size", "size", "number")).toEqual({
      value: null,
      mixed: true,
    });
  });

  it("shows no size for a selection of spaces only", () => {
    const session = open("a   b\n");
    select(session, 1, 4);
    expect(selectionMarkValue<number>(session.state, "font_size", "size", "number")).toEqual({
      value: null,
      mixed: false,
    });
  });
});

describe("Whitespace rule: other marks and characters", () => {
  it("keeps a link whole across bold text when the paragraph is edited", () => {
    const session = open("[one **two** three](old.md) end\n");
    type(session, 17, "X");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe("[one **two** three](old.md) endX\n");
  });

  it("drops the size when inline code is turned on over sized text, and accepts it", () => {
    const session = open("aa bb cc\n");
    select(session, 0, 8);
    run(session, "font-size-14");
    select(session, 3, 5);
    run(session, "inline-code");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toContain("`bb`");
    expect(markedText(session, "font_size")).not.toContain("bb");
    expect(markedText(session, "code")).toEqual(["bb"]);
  });

  it("does not carry a typing size into inline code turned on at a caret", () => {
    const session = open("aa bb\n");
    select(session, 0, 2);
    run(session, "font-size-14");
    select(session, 2, 2);
    run(session, "inline-code");
    const stored = session.state.storedMarks ?? [];
    expect(stored.map((mark) => mark.type.name)).toEqual(["code"]);
  });

  it("sizes a word whose accent is a combining character as a whole", () => {
    const session = open("cafe\u0301 ok\n");
    select(session, 2, 2);
    run(session, "font-size-14");
    expect(session.session.draftSource).toBe('<span style="font-size:14pt">cafe\u0301</span> ok\n');
  });

  it("sizes a Hebrew word and leaves the space after it unsized", () => {
    const session = open("שלום עולם\n");
    select(session, 0, 5);
    run(session, "font-size-14");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe('<span style="font-size:14pt">שלום</span> עולם\n');
  });

  it("leaves a non-breaking space at the edge of a selection outside the span", () => {
    const session = open("a\u00a0b c\n");
    select(session, 0, 2);
    run(session, "font-size-14");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe('<span style="font-size:14pt">a</span>\u00a0b c\n');
  });

  it("shows the shared size when the selection also holds inline code", () => {
    const session = open("aa `bb` cc\n");
    select(session, 0, 8);
    run(session, "font-size-14");
    select(session, 0, 8);
    expect(selectionMarkValue<number>(session.state, "font_size", "size", "number")).toEqual({
      value: 14,
      mixed: false,
    });
  });

  it("accepts deleting the first word of a line after a line break, as at the start of a paragraph", () => {
    const session = open("aa bb  \ncc dd ee\n");
    session.applyTransaction(session.state.tr.delete(1 + 6, 1 + 8), "user");
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe("aa bb\\\n&#32;dd ee\n");
    expect(open(session.session.draftSource).state.doc.textContent).toBe(
      session.state.doc.textContent,
    );
  });

  it("sizes a word with an apostrophe between letters as a whole, but not a lone apostrophe", () => {
    const session = open("don't 'x' l\u2019arbre\n");
    select(session, 2, 2);
    run(session, "font-size-14");
    expect(markedText(session, "font_size")).toEqual(["don't"]);
    select(session, 8, 8);
    run(session, "font-size-20");
    expect(markedText(session, "font_size")).toEqual(["don't", "x"]);
    select(session, 12, 12);
    run(session, "font-size-18");
    expect(markedText(session, "font_size")).toEqual(["don't", "x", "l\u2019arbre"]);
  });
});

const SIZE = '<span style="font-size:14pt">';

describe("Size and font tags are written outside bold, italic and strike, inside links", () => {
  it.each([
    ["un**believ**able", 4, 7, "font-size-14", `un**be**${SIZE}**lie**</span>**v**able`],
    ["un~~believ~~able", 4, 7, "font-size-14", `un~~be~~${SIZE}~~lie~~</span>~~v~~able`],
    ["un*believ*able", 4, 7, "font-size-14", `un*be*${SIZE}*lie*</span>*v*able`],
    [`unbel${SIZE}iev</span>able`, 2, 8, "bold", `un**bel**${SIZE}**iev**</span>able`],
    ["[abc](https://x.example)", 1, 2, "font-size-14", `[a${SIZE}b</span>c](https://x.example)`],
    [
      "**defg**",
      2,
      4,
      "font-family-Arial",
      `**de**<span style="font-family:'Arial'">**fg**</span>`,
    ],
  ] as const)("in %s", (source, from, to, command, expected) => {
    const session = open(`${source}\n`);
    select(session, from, to);
    run(session, command);
    expect(session.pendingWriteback).toBeNull();
    expect(session.session.draftSource).toBe(`${expected}\n`);
  });
});
