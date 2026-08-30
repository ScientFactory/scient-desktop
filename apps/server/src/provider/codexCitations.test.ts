import { describe, expect, it } from "vite-plus/test";

import { extractCodexCitationSources, extractCodexTextCitations } from "./codexCitations.ts";

describe("Codex citations", () => {
  it("normalizes current and legacy web-search result shapes", () => {
    expect(
      extractCodexCitationSources({
        data: {
          item: {
            results: [
              {
                ref_id: "turn3view1",
                url: "https://example.com/clinical-guideline",
                title: "Clinical guideline",
              },
              [
                "turn5view0",
                {
                  link: "https://example.org/reference",
                  name: "Reference",
                },
              ],
              {
                source: {
                  referenceId: "turn5view2",
                  href: "https://example.net/source",
                  title: "Nested source",
                },
              },
              {
                ref_id: "unsafe",
                url: "javascript:alert(1)",
              },
              {
                ref_id: "turn3view1",
                url: "https://duplicate.example.com",
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        id: "turn3view1",
        url: "https://example.com/clinical-guideline",
        title: "Clinical guideline",
      },
      {
        id: "turn5view0",
        url: "https://example.org/reference",
        title: "Reference",
      },
      {
        id: "turn5view2",
        url: "https://example.net/source",
        title: "Nested source",
      },
    ]);
  });

  it("maps private markers to UTF-16 ranges after RTL text and emoji", () => {
    const prefix = "עברית 🩺 ";
    const marker = "\uE200cite\uE202turn3view1\uE202turn5view0\uE201";
    const text = `${prefix}${marker} המשך`;

    expect(extractCodexTextCitations(text)).toEqual([
      {
        start: prefix.length,
        end: prefix.length + marker.length,
        sourceIds: ["turn3view1", "turn5view0"],
      },
    ]);
  });

  it("ignores malformed markers without valid source references", () => {
    expect(extractCodexTextCitations("before \uE200cite\uE202\uE201 after")).toEqual([]);
  });
});
