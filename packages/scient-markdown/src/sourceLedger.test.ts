import { describe, expect, it } from "vite-plus/test";

import {
  applyMarkdownSourcePatches,
  createMarkdownSourceLedger,
  replaceMarkdownSourceBlocks,
} from "./sourceLedger.ts";

const SCIENTIFIC_FIXTURE = [
  "---\r",
  "title: ניסוי\r",
  "---\r",
  "\r",
  "# Results\r",
  "\r",
  "- parent\r",
  "  - nested **item**\r",
  "\r",
  "| Group | Mean |\r",
  "| :--- | ---: |\r",
  "| A | 2.4 |\r",
  "\r",
  "$$\r",
  "E = mc^2\r",
  "$$\r",
  "\r",
  '<section data-scient="raw">keep me</section>\r',
  "",
].join("\n");

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const FUZZ_TEXT = [
  "alpha",
  "תוצאות",
  "نتائج",
  "😀",
  "e\u0301",
  "x_y",
  "A&B",
  "<tag>",
  "[link]",
  "\u2067RTL\u2069",
  "\u200fבידוד\u200e",
] as const;

function fuzzWord(random: () => number): string {
  return FUZZ_TEXT[Math.floor(random() * FUZZ_TEXT.length)] ?? "text";
}

function fuzzMarkdown(seed: number): string {
  const random = deterministicRandom(seed);
  const lineEnding = random() < 0.5 ? "\n" : "\r\n";
  const blocks: string[] = [];
  const count = 1 + Math.floor(random() * 9);
  for (let index = 0; index < count; index += 1) {
    const left = fuzzWord(random);
    const right = fuzzWord(random);
    switch (Math.floor(random() * 8)) {
      case 0:
        blocks.push(`${"#".repeat(1 + Math.floor(random() * 6))} ${left} ${right}`);
        break;
      case 1:
        blocks.push(`${left}  ${right} **${fuzzWord(random)}**`);
        break;
      case 2:
        blocks.push(`- ${left}${lineEnding}  * ${right}${lineEnding}  * __${fuzzWord(random)}__`);
        break;
      case 3:
        blocks.push(`| ${left} | ${right} |${lineEnding}| :-- | --: |${lineEnding}| 1 | 2 |`);
        break;
      case 4:
        blocks.push(`\`\`\`\`text meta=${index}${lineEnding}${left} ${right}${lineEnding}\`\`\`\``);
        break;
      case 5:
        blocks.push(`$$${lineEnding}${left}_${index} + ${right}${lineEnding}$$`);
        break;
      case 6:
        blocks.push(`<!-- ${left} -- broken > ${right} -->`);
        break;
      default:
        blocks.push(`> ${left}${lineEnding}> ## ${right}`);
        break;
    }
  }
  const separator = `${lineEnding}${lineEnding.repeat(1 + Math.floor(random() * 2))}`;
  const prefix = random() < 0.2 ? `${lineEnding}${lineEnding}` : "";
  const suffix = random() < 0.65 ? lineEnding : "";
  return `${prefix}${blocks.join(separator)}${suffix}`;
}

describe("createMarkdownSourceLedger", () => {
  it("round-trips a mixed scientific document byte-for-byte", () => {
    const ledger = createMarkdownSourceLedger(SCIENTIFIC_FIXTURE);

    expect(ledger.lineEnding).toBe("\r\n");
    expect(ledger.hasFinalLineEnding).toBe(true);
    expect(ledger.blocks.map((block) => block.kind)).toEqual([
      "yaml",
      "heading",
      "list",
      "table",
      "math",
      "html",
    ]);
    expect(replaceMarkdownSourceBlocks(ledger, [])).toBe(SCIENTIFIC_FIXTURE);
    expect(ledger.blocks.find((block) => block.kind === "list")?.logicalText).toBe(
      "parentnested item",
    );
    expect(
      ledger.blocks.find((block) => block.kind === "list")?.textSpans.filter((span) => span.direct),
    ).not.toHaveLength(0);
  });

  it("marks only exact plain-text spans as directly patchable", () => {
    const source = "Text **bold** and `code` and &copy;.\n";
    const block = createMarkdownSourceLedger(source).blocks[0]!;

    expect(block.logicalText).toBe("Text bold and code and ©.");
    expect(block.textSpans.some((span) => span.direct)).toBe(true);
    expect(block.textSpans.some((span) => !span.direct)).toBe(true);
  });

  it("preserves every outside byte when replacing one block", () => {
    const source = "# Title\n\nParagraph with  two spaces.\n\n- one\n  - two\n";
    const ledger = createMarkdownSourceLedger(source);
    const paragraph = ledger.blocks.find((block) => block.kind === "paragraph");
    expect(paragraph).toBeDefined();

    const next = replaceMarkdownSourceBlocks(ledger, [
      { id: paragraph!.id, markdown: "Changed paragraph." },
    ]);

    expect(next).toBe("# Title\n\nChanged paragraph.\n\n- one\n  - two\n");
    expect(next.slice(0, paragraph!.start)).toBe(source.slice(0, paragraph!.start));
    expect(next.endsWith("\n\n- one\n  - two\n")).toBe(true);
  });

  it("keeps trivia when a block is deleted", () => {
    const ledger = createMarkdownSourceLedger("One\n\nTwo\n");
    expect(
      replaceMarkdownSourceBlocks(ledger, [{ id: ledger.blocks[0]!.id, markdown: null }]),
    ).toBe("\n\nTwo\n");
  });

  it("retains whitespace-only documents as prefix source", () => {
    const source = " \t\r\n\r\n";
    const ledger = createMarkdownSourceLedger(source);
    expect(ledger.blocks).toEqual([]);
    expect(ledger.prefix).toBe(source);
    expect(replaceMarkdownSourceBlocks(ledger, [])).toBe(source);
  });

  it("rejects unknown and duplicate block replacements", () => {
    const ledger = createMarkdownSourceLedger("Text\n");
    expect(() => replaceMarkdownSourceBlocks(ledger, [{ id: "missing", markdown: "x" }])).toThrow(
      "Unknown Markdown source block",
    );
    expect(() =>
      replaceMarkdownSourceBlocks(ledger, [
        { id: ledger.blocks[0]!.id, markdown: "x" },
        { id: ledger.blocks[0]!.id, markdown: "y" },
      ]),
    ).toThrow("Duplicate replacement");
  });

  it("partitions and reconstructs 500 deterministic malformed Unicode documents", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const source = fuzzMarkdown(seed);
      const ledger = createMarkdownSourceLedger(source);
      expect(replaceMarkdownSourceBlocks(ledger, [])).toBe(source);
      expect(
        ledger.prefix + ledger.blocks.map((block) => block.source + block.trailing).join(""),
      ).toBe(source);
      let previousEnd = ledger.prefix.length;
      for (const block of ledger.blocks) {
        expect(block.start).toBe(previousEnd);
        expect(block.start).toBeLessThanOrEqual(block.contentEnd);
        expect(block.contentEnd).toBeLessThanOrEqual(block.end);
        expect(block.source).toBe(source.slice(block.start, block.contentEnd));
        expect(block.trailing).toBe(source.slice(block.contentEnd, block.end));
        for (const span of block.textSpans) {
          expect(span.textStart).toBeLessThanOrEqual(span.textEnd);
          expect(span.sourceStart).toBeGreaterThanOrEqual(block.start);
          expect(span.sourceEnd).toBeLessThanOrEqual(block.contentEnd);
          if (span.direct) {
            expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(
              block.logicalText.slice(span.textStart, span.textEnd),
            );
          }
        }
        previousEnd = block.end;
      }
      expect(previousEnd).toBe(source.length);
    }
  });
});

describe("applyMarkdownSourcePatches", () => {
  it("applies multiple source patches without touching surrounding Unicode", () => {
    const source = "α 😀 beta\r\nsecond line\r\n";
    const betaStart = source.indexOf("beta");
    const secondStart = source.indexOf("second");
    expect(
      applyMarkdownSourcePatches(source, [
        { start: secondStart, end: secondStart + "second".length, replacement: "שנייה" },
        { start: betaStart, end: betaStart + "beta".length, replacement: "gamma" },
      ]),
    ).toBe("α 😀 gamma\r\nשנייה line\r\n");
  });

  it("rejects overlap, split Unicode, split CRLF, and invalid bounds", () => {
    expect(() =>
      applyMarkdownSourcePatches("abcdef", [
        { start: 1, end: 4, replacement: "x" },
        { start: 3, end: 5, replacement: "y" },
      ]),
    ).toThrow("overlap");
    expect(() =>
      applyMarkdownSourcePatches("😀", [{ start: 1, end: 1, replacement: "x" }]),
    ).toThrow("surrogate pair");
    expect(() =>
      applyMarkdownSourcePatches("a\r\nb", [{ start: 2, end: 2, replacement: "x" }]),
    ).toThrow("CRLF");
    expect(() =>
      applyMarkdownSourcePatches("abc", [{ start: -1, end: 2, replacement: "x" }]),
    ).toThrow("outside");
  });

  it("matches a token oracle for 2,000 unordered Unicode patch sets", () => {
    const tokenPool = ["a", "ב", "ع", "😀", "e\u0301", "\r\n", "\n", "_", "[]"] as const;
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const random = deterministicRandom(seed * 17);
      const tokens = Array.from(
        { length: 2 + Math.floor(random() * 20) },
        () => tokenPool[Math.floor(random() * tokenPool.length)] ?? "x",
      );
      const patches: Array<{ start: number; end: number; replacement: string }> = [];
      const expected: string[] = [];
      let offset = 0;
      tokens.forEach((token, index) => {
        if (random() < 0.28) {
          const replacement = `${fuzzWord(random)}${index % 3 === 0 ? "😀" : ""}`;
          patches.push({ start: offset, end: offset + token.length, replacement });
          expected.push(replacement);
        } else {
          expected.push(token);
        }
        offset += token.length;
      });
      const source = tokens.join("");
      expect(applyMarkdownSourcePatches(source, patches.toReversed())).toBe(expected.join(""));
    }
  });
});
