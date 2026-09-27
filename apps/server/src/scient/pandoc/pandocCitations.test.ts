import { describe, expect, it } from "@effect/vitest";

import { inlineText, para, textInlines, type PandocNode } from "./pandocAst.ts";
import { applyCitations, bibliographyFromCitations } from "./pandocCitations.ts";
import { CITATIONS } from "./pandocWordFixtures.ts";

const cites = (blocks: ReadonlyArray<PandocNode>) =>
  (blocks[0]!.c as Array<PandocNode>).filter((node) => node.t === "Cite");

type Citation = {
  readonly citationId: string;
  readonly citationPrefix: Array<PandocNode>;
  readonly citationSuffix: Array<PandocNode>;
  readonly citationMode: { readonly t: string };
};
const citationsOf = (cite: PandocNode) => (cite.c as [Array<Citation>, Array<PandocNode>])[0];

describe("bibliographyFromCitations", () => {
  it("keys CSL-JSON references by citation key and skips key-only citations", () => {
    const bibliography = bibliographyFromCitations([
      ...CITATIONS,
      { _tag: "bibliographic", id: "c9", key: "keyonly", reference: null },
      { _tag: "message-excerpt", id: "c10", text: "quote", comment: null },
    ]);
    expect([...bibliography.keys()]).toEqual(["einstein1905", "smoluchowski1906", "perrin1909"]);
    expect(bibliography.get("einstein1905")?.id).toBe("einstein1905");
    expect(bibliography.get("einstein1905")?.["container-title"]).toBe("Annalen der Physik");
  });
});

describe("applyCitations", () => {
  const bibliography = bibliographyFromCitations(CITATIONS);

  it("turns a bracketed group into a Cite with prefixes, suffixes, and suppressed authors", () => {
    const blocks = [
      para(textInlines("As shown [see @smoluchowski1906, p. 3; -@perrin1909] before.")),
    ];
    const report = applyCitations(blocks, bibliography);
    const [cite] = cites(blocks);
    expect(cite).toBeDefined();
    const items = citationsOf(cite!);
    expect(items.map((item) => item.citationId)).toEqual(["smoluchowski1906", "perrin1909"]);
    expect(inlineText(items[0]!.citationPrefix)).toBe("see");
    expect(inlineText(items[0]!.citationSuffix)).toBe(", p. 3");
    expect(items.map((item) => item.citationMode.t)).toEqual(["NormalCitation", "SuppressAuthor"]);
    expect((blocks[0]!.c as Array<PandocNode>).map((node) => node.t)).toEqual([
      "Str",
      "Space",
      "Str",
      "Space",
      "Cite",
      "Space",
      "Str",
    ]);
    expect([...report.citedKeys]).toEqual(["smoluchowski1906", "perrin1909"]);
    expect(report.warnings).toEqual([]);
  });

  it("keeps groups with an unknown key as written and reports the key", () => {
    const blocks = [
      para(textInlines("Known [@einstein1905] and unknown [@einstein1905; @ghost2020].")),
    ];
    const report = applyCitations(blocks, bibliography);
    expect(cites(blocks)).toHaveLength(1);
    expect(inlineText(blocks[0]!.c)).toContain("[@einstein1905; @ghost2020]");
    expect(report.warnings[0]?.message).toContain("@ghost2020");
  });

  it("never reads mail addresses, code, or links as citations", () => {
    const blocks: Array<PandocNode> = [
      para([
        ...textInlines("Write to [me@einstein1905] or "),
        { t: "Code", c: [["", [], []], "[@einstein1905]"] },
        ...textInlines(" and nothing else."),
      ]),
    ];
    const report = applyCitations(blocks, bibliography);
    expect(cites(blocks)).toHaveLength(0);
    expect(report.citedKeys.size).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it("finds citations in list items, table cells, and footnotes", () => {
    const blocks: Array<PandocNode> = [
      { t: "BulletList", c: [[{ t: "Plain", c: textInlines("item [@einstein1905]") }]] },
      para([...textInlines("claim"), { t: "Note", c: [para(textInlines("See [@perrin1909]."))] }]),
    ];
    const report = applyCitations(blocks, bibliography);
    expect([...report.citedKeys].toSorted()).toEqual(["einstein1905", "perrin1909"]);
  });
});
