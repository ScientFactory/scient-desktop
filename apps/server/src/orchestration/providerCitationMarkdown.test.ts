import { describe, expect, it } from "vite-plus/test";

import {
  canRenderProviderCitationMarkdown,
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
