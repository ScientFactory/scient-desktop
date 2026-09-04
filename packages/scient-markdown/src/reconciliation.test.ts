import { describe, expect, it } from "vite-plus/test";
import { reconcileMarkdown } from "./reconciliation.ts";
import { applyMarkdownSourcePatches } from "./sourceLedger.ts";

describe("conservative Markdown reconciliation", () => {
  const base = "First paragraph.\n\nSecond paragraph.\n";
  it("combines independent edits and returns exact local-to-merged patches", () => {
    const local = base.replace("First", "My first");
    const disk = base.replace("Second", "Their second");
    const result = reconcileMarkdown(base, local, disk)!;
    expect(result.source).toBe("My first paragraph.\n\nTheir second paragraph.\n");
    expect(applyMarkdownSourcePatches(local, result.patches)).toBe(result.source);
  });
  it("accepts an independent appendix without duplicating identical edits", () => {
    const local = base.replace("First", "My first");
    const disk = local + "\n## Agent appendix\n\nNew content.\n";
    expect(reconcileMarkdown(base, local, disk)?.source).toBe(disk);
  });
  it("combines an edit to the last block with a separated appendix", () => {
    const original = base + "\n";
    const local = original.replace("Second", "My second");
    const disk = original + "## Appendix\n";
    expect(reconcileMarkdown(original, local, disk)?.source).toBe(local + "## Appendix\n");
  });
  it("keeps same-block, delete/edit and same-position insertions unresolved", () => {
    expect(
      reconcileMarkdown(base, base.replace("First", "Mine"), base.replace("paragraph.", "theirs.")),
    ).toBeNull();
    expect(
      reconcileMarkdown(base, "Second paragraph.\n", base.replace("First", "Theirs")),
    ).toBeNull();
    expect(reconcileMarkdown(base, base + "\nMine\n", base + "\nTheirs\n")).toBeNull();
  });
  it("does not guess repeated block identities or changing global definitions", () => {
    const repeated = "Same\n\nSame\n\nLast\n";
    expect(
      reconcileMarkdown(repeated, repeated.replace("Last", "Local"), repeated + "\nRemote\n"),
    ).toBeNull();
    const references = base + "\n[ref]: /old\n";
    expect(
      reconcileMarkdown(
        references,
        references.replace("First", "Mine"),
        references.replace("/old", "/new"),
      ),
    ).toBeNull();
  });
  it("preserves BOM, CRLF, mixed direction, emoji and exact punctuation", () => {
    const original = "\uFEFFשלום 😀\r\n\r\nمرحبا **world**\r\n";
    const local = original.replace("שלום", "שלום!");
    const disk = original.replace("world", "earth");
    const result = reconcileMarkdown(original, local, disk)!;
    expect(result.source).toBe(local.replace("world", "earth"));
    expect(applyMarkdownSourcePatches(local, result.patches)).toBe(result.source);
  });
  it("recognizes nested reference context without blocking unchanged definitions", () => {
    for (const definitions of [
      "> [ref]: /old\n",
      "- Item\n\n  [ref]: /old\n",
      "[^note]: Old note\n",
    ]) {
      const original = base + "\n" + definitions;
      const local = original.replace("First", "Mine");
      expect(reconcileMarkdown(original, local, original.replace(/old|Old/u, "new"))).toBeNull();
      expect(reconcileMarkdown(original, local, original.replace("Second", "Theirs"))?.source).toBe(
        local.replace("Second", "Theirs"),
      );
    }
  });
  it("preserves exact slices for every disjoint pair of compound-block edits", () => {
    const blocks = [
      "# Heading\n\n",
      "Paragraph 😀 with **bold** and שלום.\n\n",
      "- [ ] Task one\n- [ ] Task two\n\n",
      "| Left | Right |\n| :--- | ---: |\n| One | Two |\n\n",
      "````ts\nconst value = 1;\n````\n\n",
      "$$\na^2 + b^2 = c^2\n$$\n\n",
      "> Quoted words.\n\n",
    ];
    const original = blocks.join("");
    for (let localIndex = 0; localIndex < blocks.length; localIndex++) {
      for (let remoteIndex = 0; remoteIndex < blocks.length; remoteIndex++) {
        if (localIndex === remoteIndex) continue;
        const localBlocks = [...blocks];
        const remoteBlocks = [...blocks];
        localBlocks[localIndex] = blocks[localIndex]!.replace(/[A-Za-z]/u, "Local");
        remoteBlocks[remoteIndex] = blocks[remoteIndex]!.replace(/[A-Za-z]/u, "Remote");
        const expected = [...localBlocks];
        expected[remoteIndex] = remoteBlocks[remoteIndex]!;
        const result = reconcileMarkdown(original, localBlocks.join(""), remoteBlocks.join(""))!;
        expect(result?.source).toBe(expected.join(""));
        expect(applyMarkdownSourcePatches(localBlocks.join(""), result.patches)).toBe(
          result.source,
        );
      }
    }
  });
  it("treats compound tables, lists and code blocks as indivisible", () => {
    for (const source of [
      "- One\n- Two\n",
      "| One | Two |\n| --- | --- |\n| A | B |\n",
      "```\nOne\nTwo\n```\n",
    ]) {
      expect(
        reconcileMarkdown(source, source.replace("One", "Mine"), source.replace("Two", "Theirs")),
      ).toBeNull();
    }
  });
  it("bounds work instead of freezing on an oversized draft", () => {
    const source = "a".repeat(256_001);
    expect(reconcileMarkdown(source, source + "b", source + "c")).toBeNull();
  });
});
