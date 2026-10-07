import { describe, expect, it } from "vite-plus/test";

import {
  canRenderProviderCitationMarkdown,
  extractCodexProseCitations,
  presentProviderCitationText,
  renderProviderCitationMarkdown,
} from "./providerCitationMarkdown.ts";

describe("provider citation Markdown", () => {
  const sources = [
    {
      id: "turn3view1",
      url: "https://example.com/guideline",
      title: 'Guideline "A"',
    },
    {
      id: "turn5view0",
      url: "https://example.org/reference",
      title: "Reference",
    },
  ] as const;

  it("renders standard clickable Markdown without disturbing RTL text", () => {
    const marker = "\uE200cite\uE202turn3view1\uE201";
    const text = `לפני ${marker} אחרי`;
    const start = text.indexOf(marker);

    expect(
      renderProviderCitationMarkdown({
        text,
        citations: [{ start, end: start + marker.length, sourceIds: ["turn3view1"] }],
        sources,
      }),
    ).toBe('לפני [1](<https://example.com/guideline> "Guideline \\"A\\"") אחרי');
  });

  it("uses stable ordinals and deduplicates repeated URLs", () => {
    const first = "\uE200cite\uE202turn3view1\uE202turn5view0\uE201";
    const second = "\uE200cite\uE202turn3view1\uE201";
    const text = `A${first} B${second}`;
    const secondStart = text.indexOf(second, 1);

    expect(
      renderProviderCitationMarkdown({
        text,
        citations: [
          { start: 1, end: 1 + first.length, sourceIds: ["turn3view1", "turn5view0"] },
          {
            start: secondStart,
            end: secondStart + second.length,
            sourceIds: ["turn3view1"],
          },
        ],
        sources,
      }),
    ).toBe(
      'A[1](<https://example.com/guideline> "Guideline \\"A\\"")[2](<https://example.org/reference> "Reference") B[1](<https://example.com/guideline> "Guideline \\"A\\"")',
    );
  });

  it("reports incomplete source metadata without claiming it is renderable", () => {
    const text = "xMARKERy";
    const citations = [{ start: 1, end: 7, sourceIds: ["missing"] }] as const;

    expect(canRenderProviderCitationMarkdown({ citations, sources })).toBe(false);
    expect(renderProviderCitationMarkdown({ text, citations, sources })).toBe(
      "x[citation unavailable]y",
    );
  });

  it("rejects non-web source URLs", () => {
    expect(
      canRenderProviderCitationMarkdown({
        citations: [{ start: 0, end: 1, sourceIds: ["unsafe"] }],
        sources: [{ id: "unsafe", url: "file:///etc/passwd" }],
      }),
    ).toBe(false);
  });
});

describe("raw citation presentation", () => {
  const marker = "\uE200cite\uE202known\uE201";
  const missing = "\uE200cite\uE202absent\uE201";
  const provenance = {
    format: "codex-private-v1" as const,
    sources: [
      { id: "known", url: "https://example.test/evidence", title: "Evidence" },
      { id: "unsafe", url: "javascript:alert(1)" },
    ],
  };
  const present = (text: string) =>
    presentProviderCitationText({ text, citationPresentation: provenance, streaming: false });
  it("derives mixed safe links and unavailable fallback from current UTF-16 text", () => {
    const text = `שלום 😀 ${marker} ${missing} \uE200cite\uE202unsafe\uE201`;
    expect(present(text)).toBe(
      'שלום 😀 [1](<https://example.test/evidence> "Evidence") [citation unavailable] [citation unavailable]',
    );
    expect(present(`New ${missing}`)).toBe("New [citation unavailable]");
    expect(present(present(text))).toBe(present(text));
  });
  it("keeps code, HTML, math, metadata and destinations literal alongside prose", () => {
    const literal = [
      `---\nsource: ${marker}\n---`,
      "```md\n" + marker + "\n```",
      "``" + marker + " with ` embedded``",
      `<span>${marker}</span>`,
      `$${marker}$`,
      `[label](<https://example.test/${marker}>)`,
      `[ref]: <https://example.test/${marker}>`,
    ].join("\n\n");
    const text = `${literal}\n\nProse ${marker}`;
    expect(extractCodexProseCitations(text)).toHaveLength(1);
    expect(present(text)).toBe(
      `${literal}\n\nProse [1](<https://example.test/evidence> "Evidence")`,
    );
  });
  it("keeps exact ordered ranges across long formatted prose and excluded literal spans", () => {
    let text = "😀 **unrelated** _prose_ ".repeat(1_500);
    let expectedDisplay = text;
    const ranges: Array<{ start: number; end: number; sourceIds: string[] }> = [];
    const link = '[1](<https://example.test/evidence> "Evidence")';
    for (let section = 0; section < 24; section += 1) {
      const chunk = `**${marker}** \`${marker}\` [label](<https://example.test/${marker}>) _${marker}_ \uE200cite\uE202kn**own\uE201**\n\n`;
      const firstStart = text.length + 2;
      const secondStart = text.length + chunk.indexOf(`_${marker}_`) + 1;
      ranges.push(
        { start: firstStart, end: firstStart + marker.length, sourceIds: ["known"] },
        { start: secondStart, end: secondStart + marker.length, sourceIds: ["known"] },
      );
      text += chunk;
      expectedDisplay += `**${link}** \`${marker}\` [label](<https://example.test/${marker}>) _${link}_ \uE200cite\uE202kn**own\uE201**\n\n`;
    }
    expect(extractCodexProseCitations(text)).toEqual(ranges);
    expect(present(text)).toBe(expectedDisplay);
  });
  it("leaves absent provenance, streaming and malformed marker text unchanged", () => {
    for (const text of [
      marker,
      "\uE200cite\uE202\uE201",
      "\uE200cite\uE202incomplete",
      "ordinary Markdown [one](https://example.test)",
    ]) {
      expect(presentProviderCitationText({ text, streaming: false })).toBe(text);
      expect(
        presentProviderCitationText({ text, citationPresentation: provenance, streaming: true }),
      ).toBe(text);
    }
    expect(present("\uE200cite\uE202\uE201")).toBe("\uE200cite\uE202\uE201");
  });
});
