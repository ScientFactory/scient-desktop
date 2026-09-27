import { describe, expect, it } from "@effect/vitest";

import {
  attr,
  attrValue,
  bulletList,
  div,
  inlineText,
  para,
  str,
  textInlines,
  type PandocNode,
} from "./pandocAst.ts";
import {
  SCIENT_WORD_STYLES,
  applyScientStructure,
  conversionNotesBlocks,
  landscapeWideTables,
  mermaidDiagramAssetId,
  unlistedWarnings,
} from "./pandocPreparation.ts";
import { PNG_BYTES, bytesAsset } from "./pandocTestSupport.ts";

const raw = (html: string): PandocNode => ({ t: "RawBlock", c: ["html", html] });
const header = (level: number, text: string): PandocNode => ({
  t: "Header",
  c: [level, attr(), textInlines(text)],
});
const plain = (text: string): PandocNode => ({ t: "Plain", c: textInlines(text) });
const code = (classes: Array<string>, text: string): PandocNode => ({
  t: "CodeBlock",
  c: [attr(classes), text],
});
const EXPORT = "7f3c9a2e41b8";

const style = (node: PandocNode) => attrValue(node, "custom-style");

function table(columns: number, rows: Array<Array<string>>): PandocNode {
  const cell = (text: string) => [attr(), { t: "AlignDefault" }, 1, 1, [plain(text)]];
  const row = (cells: Array<string>) => [attr(), cells.map(cell)];
  return {
    t: "Table",
    c: [
      attr(),
      [null, []],
      Array.from({ length: columns }, () => [{ t: "AlignDefault" }, { t: "ColWidthDefault" }]),
      [attr(), [row(rows[0]!)]],
      [[attr(), 0, [], rows.slice(1).map(row)]],
      [attr(), []],
    ],
  };
}

describe("applyScientStructure", () => {
  it("styles speakers and work-log and reasoning parts, and removes the markers", () => {
    const blocks: Array<PandocNode> = [
      raw(`<!-- scient:message export=${EXPORT} n=1 role=user time=2026-09-27T14:05:00.000Z -->\n`),
      header(2, "You · 27 Sep 2026, 14:05 UTC"),
      para(textInlines("Question")),
      raw(
        `<!-- scient:message export=${EXPORT} n=2 role=assistant time=2026-09-27T14:06:00.000Z turn=1 -->\n`,
      ),
      header(2, "Assistant · 27 Sep 2026, 14:06 UTC"),
      para(textInlines("Answer")),
      raw(`<!-- scient:part export=${EXPORT} kind=work-log -->\n`),
      raw("<details>\n<summary>Work log · 2 steps</summary>\n"),
      bulletList([[plain("Ran pytest · completed")], [plain("Edited sums.py")]]),
      raw("</details>\n"),
      raw(`<!-- scient:part export=${EXPORT} kind=reasoning -->\n`),
      raw("<details>\n<summary>Reasoning</summary>\n"),
      para(textInlines("Thinking &amp; checking")),
      raw("</details>\n"),
    ];
    const report = applyScientStructure(blocks, { profile: "chat", assets: [] });

    expect(blocks.map((block) => block.t)).toEqual([
      "Header",
      "Para",
      "Header",
      "Para",
      "Div",
      "Div",
    ]);
    const speaker = (index: number) =>
      style(((blocks[index]!.c as Array<unknown>)[2] as Array<PandocNode>)[0]!);
    expect(speaker(0)).toBe(SCIENT_WORD_STYLES.speakerUser);
    expect(speaker(2)).toBe(SCIENT_WORD_STYLES.speakerAssistant);

    const workLog = blocks[4]!;
    expect(style(workLog)).toBe(SCIENT_WORD_STYLES.workLog);
    const workLogBlocks = (workLog.c as [unknown, Array<PandocNode>])[1];
    // The summary survives as a bold paragraph; steps are paragraphs, not a list.
    expect(workLogBlocks.map((block) => block.t)).toEqual(["Para", "Para", "Para"]);
    expect(inlineText(workLogBlocks[0]!.c)).toBe("Work log · 2 steps");
    expect(inlineText(workLogBlocks[2]!.c)).toBe("Edited sums.py");

    const reasoning = blocks[5]!;
    expect(style(reasoning)).toBe(SCIENT_WORD_STYLES.reasoning);
    expect(inlineText((reasoning.c as [unknown, Array<PandocNode>])[1][0]!.c)).toBe("Reasoning");
    expect(report.workLogBlocks).toBe(1);
    expect(report.reasoningBlocks).toBe(1);
  });

  it("ignores markers from another export and markers in document files", () => {
    const quoted = [
      raw(`<!-- scient:message export=${EXPORT} n=1 role=user time=2026-09-27T14:05:00.000Z -->`),
      header(2, "You"),
      raw(
        `<!-- scient:message export=aaaaaaaaaaaa n=1 role=assistant time=2026-09-27T14:05:00.000Z -->`,
      ),
      header(2, "Quoted"),
    ];
    applyScientStructure(quoted, { profile: "chat", assets: [] });
    expect(quoted).toHaveLength(2);
    expect((quoted[1]!.c as Array<unknown>)[2]).toEqual(textInlines("Quoted"));

    const document = [
      raw(`<!-- scient:message export=${EXPORT} n=1 role=user time=2026-09-27T14:05:00.000Z -->`),
      header(2, "Heading"),
    ];
    applyScientStructure(document, { profile: "document", assets: [] });
    expect((document[1]!.c as Array<unknown>)[2]).toEqual(textInlines("Heading"));
  });

  it("keeps the summary of ordinary details blocks and closes unclosed ones", () => {
    const blocks: Array<PandocNode> = [
      raw("<details open><summary>Show <b>more</b> &lt;here&gt;</summary></details>"),
      raw("<details>\n<summary>Outer</summary>\n"),
      raw("<details>\n<summary>Inner</summary>\n"),
      para(textInlines("nested")),
      raw("</details>\n"),
      para(textInlines("tail")),
    ];
    applyScientStructure(blocks, { profile: "document", assets: [] });
    expect(blocks).toHaveLength(2);
    expect(inlineText((blocks[0]!.c as [unknown, Array<PandocNode>])[1][0]!.c)).toBe(
      "Show more <here>",
    );
    const outer = (blocks[1]!.c as [unknown, Array<PandocNode>])[1];
    expect(outer.map((block) => block.t)).toEqual(["Para", "Div", "Para"]);
  });

  it("maps alerts and task lists explicitly", () => {
    const blocks: Array<PandocNode> = [
      div(attr(["warning"]), [
        div(attr(["title"]), [para([str("Warning")])]),
        para([str("Careful")]),
      ]),
      bulletList([[plain("☐ open")], [plain("☒ done")]]),
      bulletList([[plain("☐ task")], [plain("plain item")]]),
    ];
    applyScientStructure(blocks, { profile: "document", assets: [] });
    expect(style(blocks[0]!)).toBe(SCIENT_WORD_STYLES.alert);
    const alert = (blocks[0]!.c as [unknown, Array<PandocNode>])[1];
    expect(alert[0]).toEqual(para([{ t: "Strong", c: [str("Warning")] }]));
    expect(style(blocks[1]!)).toBe(SCIENT_WORD_STYLES.taskList);
    const tasks = (blocks[1]!.c as [unknown, Array<PandocNode>])[1];
    expect(tasks.map((block) => inlineText(block.c))).toEqual(["☐ open", "☑ done"]);
    // A list that is not entirely tasks stays a list.
    expect(blocks[2]!.t).toBe("BulletList");
  });

  it("uses the bundle's rendered Mermaid image, or shows the source with a placeholder", () => {
    const rendered = "graph TD; A-->B";
    const blocks: Array<PandocNode> = [
      code(["mermaid"], rendered),
      code(["mermaid"], "graph LR; X-->Y"),
      code(["python"], "print(1)"),
    ];
    const report = applyScientStructure(blocks, {
      profile: "document",
      assets: [
        bytesAsset({
          id: mermaidDiagramAssetId(`${rendered}\n`),
          bytes: PNG_BYTES,
          role: "rendered-diagram",
        }),
      ],
    });
    expect(blocks.map((block) => block.t)).toEqual(["Para", "Para", "CodeBlock", "CodeBlock"]);
    const imageNode = (blocks[0]!.c as Array<PandocNode>)[0]!;
    expect(imageNode.t).toBe("Image");
    expect(((imageNode.c as Array<unknown>)[2] as Array<string>)[0]).toBe(
      `scient-asset:${mermaidDiagramAssetId(rendered)}`,
    );
    expect(inlineText(blocks[1]!.c)).toContain("Mermaid diagram source (image unavailable)");
    expect(report.diagramsRendered).toBe(1);
    expect(report.diagramsMissing).toBe(1);
    expect(report.warnings[0]?.code).toBe("resource-unresolved");
  });

  it("gives wide tables proportional column widths", () => {
    const wide = table(6, [
      ["a", "b", "c", "d", "e", "f"],
      ["x", "a-much-longer-cell-value", "y", "z", "w", "v"],
    ]);
    const narrow = table(2, [["a", "b"]]);
    applyScientStructure([wide, narrow], { profile: "document", assets: [] });
    const widths = ((wide.c as Array<unknown>)[2] as Array<[PandocNode, PandocNode]>).map(
      (spec) => spec[1],
    );
    expect(widths.every((width) => width.t === "ColWidth")).toBe(true);
    const values = widths.map((width) => Number(width.c));
    expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
    expect(values[1]!).toBeGreaterThan(values[0]!);
    expect(((narrow.c as Array<unknown>)[2] as Array<[PandocNode, PandocNode]>)[0]![1].t).toBe(
      "ColWidthDefault",
    );
  });
});

describe("mermaidDiagramAssetId", () => {
  it("names a fence by its source, ignoring the final newline", () => {
    expect(mermaidDiagramAssetId("graph TD; A-->B")).toMatch(/^mermaid-[0-9a-f]{16}$/u);
    expect(mermaidDiagramAssetId("graph TD; A-->B\n")).toBe(
      mermaidDiagramAssetId("graph TD; A-->B"),
    );
    expect(mermaidDiagramAssetId("graph TD; A-->C")).not.toBe(
      mermaidDiagramAssetId("graph TD; A-->B"),
    );
  });
});

describe("landscapeWideTables", () => {
  it("puts very wide tables on a landscape section and leaves others alone", () => {
    const blocks: Array<PandocNode> = [
      para([str("intro")]),
      table(12, [Array.from({ length: 12 }, (_, index) => `c${index}`)]),
      table(10, [Array.from({ length: 10 }, (_, index) => `d${index}`)]),
      para([str("after")]),
      table(3, [["a", "b", "c"]]),
    ];
    expect(landscapeWideTables(blocks, true)).toBe(2);
    expect(blocks.map((block) => block.t)).toEqual([
      "Para",
      "RawBlock",
      "Table",
      "Table",
      "RawBlock",
      "Para",
      "Table",
    ]);
    const breakXml = (index: number) => (blocks[index]!.c as [string, string])[1];
    expect(breakXml(1)).not.toContain("landscape");
    expect(breakXml(4)).toContain('w:orient="landscape"');
    expect(breakXml(4)).toContain("<w:bidi/>");
  });
});

describe("unlistedWarnings", () => {
  it("keeps only the warnings the document does not already show", () => {
    const blocks: Array<PandocNode> = [
      para([{ t: "Strong", c: textInlines("Export notes") }]),
      bulletList([[plain("This export includes the work log, which can contain secrets.")]]),
    ];
    expect(
      unlistedWarnings(blocks, [
        {
          code: "sensitive-content-included",
          message: "This export includes the work log,  which can contain secrets.",
        },
        { code: "resource-unresolved", message: "Image “plot.png” was not included." },
      ]),
    ).toEqual([{ code: "resource-unresolved", message: "Image “plot.png” was not included." }]);
  });
});

describe("conversionNotesBlocks", () => {
  it("lists warnings under a bold heading, and nothing when there are none", () => {
    expect(conversionNotesBlocks([])).toEqual([]);
    const blocks = conversionNotesBlocks([{ code: "resource-unresolved", message: "One note." }]);
    expect(inlineText(blocks[0]!.c)).toBe("Conversion notes");
    expect(blocks[1]!.t).toBe("BulletList");
  });
});
