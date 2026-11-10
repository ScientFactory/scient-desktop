import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vite-plus/test";
import { runScientMarkdownCommand, type ScientMarkdownCommand } from "./commands";
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
      'a <span style="font-size:1.2em">big</span> and <span style="font-family:monospace">code</span>\n',
    );
    expect(markedText(session, "font_size")).toEqual(["big"]);
    expect(markedText(session, "font_family")).toEqual(["code"]);
    const size = session.state.doc.firstChild!.child(1).marks[0]!;
    expect(size.attrs.size).toBe("large");
  });

  it.each([
    '<span style="font-size:3em">x</span>',
    '<span style="color:red">x</span>',
    '<span style="font-family:Arial">x</span>',
    '<span style="font-size:1.2em" class="a">x</span>',
    '<span style="font-size:1.2em">unclosed',
    "plain </span> stray close",
  ])("leaves other HTML as text: %s", (source) => {
    const session = open(`${source}\n`);
    expect(markedText(session, "font_size")).toEqual([]);
    expect(markedText(session, "font_family")).toEqual([]);
    expect(session.session.draftSource).toBe(`${source}\n`);
  });

  it("applies, replaces and removes a size on a selection, writing the exact span", () => {
    const session = open("one two three\n");
    select(session, 4, 7);
    run(session, "font-size-large");
    expect(session.session.draftSource).toBe(
      'one <span style="font-size:1.2em">two</span> three\n',
    );
    run(session, "font-size-small");
    expect(session.session.draftSource).toBe(
      'one <span style="font-size:0.9em">two</span> three\n',
    );
    run(session, "font-size-default");
    expect(session.session.draftSource).toBe("one two three\n");
  });

  it("leaves whitespace at the ends of the selection outside the span", () => {
    const session = open("one two three\n");
    select(session, 3, 8);
    run(session, "font-size-LARGE");
    expect(session.session.draftSource).toBe(
      'one <span style="font-size:1.73em">two</span> three\n',
    );
  });

  it("never nests two sizes and keeps size and family as separate spans", () => {
    const session = open("one two three\n");
    select(session, 4, 7);
    run(session, "font-size-huge");
    run(session, "font-family-sans-serif");
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
    run(session, "font-size-Large");
    const written = session.session.draftSource;
    expect(written.startsWith("# Title\n\n")).toBe(true);
    expect(written.endsWith("\n\nsecond paragraph\n")).toBe(true);
  });

  it("round-trips a span inside bold, a list item and a table cell", () => {
    for (const source of [
      '**a <span style="font-size:1.44em">b</span> c**\n',
      '- item <span style="font-family:serif">x</span>\n',
      '| A |\n| --- |\n| <span style="font-size:0.5em">t</span> |\n',
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

  it("defines both marks in the schema", () => {
    expect(scientMarkdownSchema.marks.font_size).toBeDefined();
    expect(scientMarkdownSchema.marks.font_family).toBeDefined();
  });

  it("ignores pasted HTML whose size or family is not a known name", () => {
    const parseRule = (markName: "font_size" | "font_family") => {
      const rule = scientMarkdownSchema.marks[markName]?.spec.parseDOM?.[0];
      return rule?.getAttrs as (element: { getAttribute: (name: string) => string }) => unknown;
    };
    const attribute = (value: string) => ({ getAttribute: () => value });
    expect(parseRule("font_size")(attribute("huge"))).toEqual({ size: "huge" });
    expect(parseRule("font_size")(attribute("x;background:url(https://example.invalid)"))).toBe(
      false,
    );
    expect(parseRule("font_family")(attribute("monospace"))).toEqual({ family: "monospace" });
    expect(parseRule("font_family")(attribute('serif" onmouseover="alert(1)'))).toBe(false);
  });
});
