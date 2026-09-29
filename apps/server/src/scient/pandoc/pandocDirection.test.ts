import { describe, expect, it } from "@effect/vitest";

import {
  attr,
  attrValue,
  div,
  para,
  textInlines,
  type PandocDocument,
  type PandocNode,
} from "./pandocAst.ts";
import { applyDirection, firstStrongDirection } from "./pandocDirection.ts";

const doc = (blocks: Array<PandocNode>): PandocDocument => ({
  "pandoc-api-version": [1, 23, 1, 2],
  meta: {},
  blocks,
});

const dirOf = (node: PandocNode) => (node.t === "Div" ? attrValue(node, "dir") : null);

describe("firstStrongDirection", () => {
  it("follows the first letter and skips digits, punctuation, and math", () => {
    expect(firstStrongDirection("123, שלום world")).toBe("rtl");
    expect(firstStrongDirection("(Pandoc) ו-Word")).toBe("ltr");
    expect(firstStrongDirection("مرحبا")).toBe("rtl");
    expect(firstStrongDirection("42 — ...")).toBeNull();
  });
});

describe("applyDirection", () => {
  it("marks right-to-left blocks, list items, and table cells in a left-to-right document", () => {
    const cell = (text: string) => [
      attr(),
      { t: "AlignDefault" },
      1,
      1,
      [{ t: "Plain", c: textInlines(text) }],
    ];
    const document = doc([
      para(textInlines("English first.")),
      para(textInlines("פסקה בעברית עם Pandoc.")),
      {
        t: "BulletList",
        c: [[{ t: "Plain", c: textInlines("פריט") }], [{ t: "Plain", c: textInlines("item") }]],
      },
      {
        t: "Table",
        c: [
          attr(),
          [null, []],
          [[{ t: "AlignDefault" }, { t: "ColWidthDefault" }]],
          [attr(), [[attr(), [cell("עמודה")]]]],
          [[attr(), 0, [], [[attr(), [cell("value")]]]]],
          [attr(), []],
        ],
      },
    ]);
    const report = applyDirection(document, "ltr");
    expect(report.rtlDocument).toBe(false);
    expect(document.meta.dir).toBeUndefined();
    expect(document.blocks.map(dirOf)).toEqual([null, "rtl", null, null]);
    const items = document.blocks[2]!.c as Array<Array<PandocNode>>;
    expect(dirOf(items[0]![0]!)).toBe("rtl");
    expect(dirOf(items[1]![0]!)).toBeNull();
    expect(report.markedBlocks).toBe(3);
  });

  it("makes a right-to-left document rtl and marks its left-to-right blocks", () => {
    const document = doc([
      para(textInlines("שלום")),
      para(textInlines("English inside.")),
      div(attr([], [["dir", "ltr"]]), [para(textInlines("Explicit."))]),
    ]);
    const report = applyDirection(document, "rtl");
    expect(report.rtlDocument).toBe(true);
    expect(document.meta.dir).toEqual({ t: "MetaString", c: "rtl" });
    expect(document.blocks.map(dirOf)).toEqual([null, "ltr", "ltr"]);
  });

  it("decides an automatic direction by the majority of text blocks", () => {
    const hebrew = doc([
      para(textInlines("אחת")),
      para(textInlines("שתיים")),
      para(textInlines("three")),
    ]);
    expect(applyDirection(hebrew, "auto").rtlDocument).toBe(true);
    const english = doc([
      para(textInlines("one")),
      para(textInlines("שתיים")),
      para(textInlines("three")),
    ]);
    expect(applyDirection(english, "auto").rtlDocument).toBe(false);
  });

  it("keeps a footnote's paragraph first and marks its text in the calling direction", () => {
    const note: PandocNode = { t: "Note", c: [para(textInlines("Checked numerically."))] };
    const document = doc([para([...textInlines("טענה"), note])]);
    applyDirection(document, "ltr");
    const noteBlocks = note.c as Array<PandocNode>;
    expect(noteBlocks[0]!.t).toBe("Para");
    const span = (noteBlocks[0]!.c as Array<PandocNode>)[0]!;
    expect(span.t).toBe("Span");
    expect(attrValue(span, "dir")).toBe("ltr");
  });
});
