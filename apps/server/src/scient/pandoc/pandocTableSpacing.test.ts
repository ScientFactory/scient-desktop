import { describe, expect, it } from "@effect/vitest";

import { attr, attrValue, div, para, textInlines, type PandocNode } from "./pandocAst.ts";
import { spaceTextAroundTables } from "./pandocTableSpacing.ts";

const paragraph = (text: string) => para(textInlines(text));
const table = (): PandocNode => ({ t: "Table", c: [] });
const styleOf = (block: PandocNode) => attrValue(block, "custom-style");

describe("spaceTextAroundTables", () => {
  it("adds table-facing spacing to ordinary paragraphs without blank blocks", () => {
    const blocks = [paragraph("Before"), table(), paragraph("After"), paragraph("Later")];
    spaceTextAroundTables(blocks);
    expect(blocks).toHaveLength(4);
    expect(styleOf(blocks[0]!)).toBe("Scient Before Table");
    expect(blocks[1]?.t).toBe("Table");
    expect(styleOf(blocks[2]!)).toBe("Scient After Table");
    expect(blocks[3]?.t).toBe("Para");
    spaceTextAroundTables(blocks);
    expect(styleOf(blocks[0]!)).toBe("Scient Before Table");
    expect(styleOf(blocks[2]!)).toBe("Scient After Table");
  });

  it("preserves direction wrappers and styles paragraphs between two tables", () => {
    const rtl = div(attr([], [["dir", "rtl"]]), [paragraph("שלום")]);
    const blocks = [table(), rtl, table()];
    spaceTextAroundTables(blocks);
    expect(styleOf(blocks[1]!)).toBe("Scient Between Tables");
    const child = (blocks[1]!.c as [unknown, Array<PandocNode>])[1][0]!;
    expect(attrValue(child, "dir")).toBe("rtl");
  });

  it("does not replace heading or list styles", () => {
    const blocks: Array<PandocNode> = [
      { t: "Header", c: [2, attr(), textInlines("Heading")] },
      table(),
      { t: "BulletList", c: [[paragraph("Item")]] },
    ];
    spaceTextAroundTables(blocks);
    expect(blocks.map((block) => block.t)).toEqual(["Header", "Table", "BulletList"]);
  });
});
