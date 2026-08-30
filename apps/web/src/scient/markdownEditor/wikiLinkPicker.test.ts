import { describe, expect, it } from "vite-plus/test";

import {
  buildWikiLinkPickerSections,
  promoteRecentWikiLinkPath,
  sanitizeRecentWikiLinkPaths,
  wikiLinkRecentsStorageKey,
  type ScientMarkdownWikiLinkCandidate,
  WIKI_LINK_RECENT_LIMIT,
} from "./wikiLinkPicker";

const candidates: ReadonlyArray<ScientMarkdownWikiLinkCandidate> = [
  { path: "Methods/Protocol.md", target: "Methods/Protocol" },
  { path: "Notes/Background.md", target: "Notes/Background" },
  { path: "Archive/Protocol.md", target: "Archive/Protocol" },
];

describe("wiki link picker", () => {
  it("keeps a canonical bounded recent-target history", () => {
    const initial = [
      "Notes/Background.md",
      "Methods/Protocol.md",
      "Notes/Background.md",
      "../outside.md",
      "figure.png",
      ...Array.from({ length: WIKI_LINK_RECENT_LIMIT }, (_, index) => `Notes/${index}.md`),
    ];

    expect(sanitizeRecentWikiLinkPaths(initial)).toEqual([
      "Notes/Background.md",
      "Methods/Protocol.md",
      "Notes/0.md",
      "Notes/1.md",
      "Notes/2.md",
      "Notes/3.md",
    ]);
    expect(promoteRecentWikiLinkPath(initial, "Methods/Protocol.md")).toEqual([
      "Methods/Protocol.md",
      "Notes/Background.md",
      "Notes/0.md",
      "Notes/1.md",
      "Notes/2.md",
      "Notes/3.md",
    ]);
    expect(promoteRecentWikiLinkPath([], "Notes/Long-form.markdown")).toEqual([
      "Notes/Long-form.markdown",
    ]);
  });

  it("uses the visible stem for either supported plain-Markdown extension", () => {
    expect(
      buildWikiLinkPickerSections({
        candidates: [{ path: "Notes/Long-form.markdown", target: "Notes/Long-form.markdown" }],
        query: "long-form",
        recentPaths: [],
      }).results,
    ).toHaveLength(1);
  });

  it("shows available recents separately and filters stale paths", () => {
    expect(
      buildWikiLinkPickerSections({
        candidates,
        query: "",
        recentPaths: ["Notes/Background.md", "Deleted.md", "Methods/Protocol.md"],
      }),
    ).toEqual({
      recent: [candidates[1], candidates[0]],
      results: [candidates[2]],
    });
  });

  it("keeps filename relevance ahead of recency and uses recency only for ties", () => {
    const exactBeforeRecentPrefix = buildWikiLinkPickerSections({
      candidates: [
        { path: "Current/Protocol.md", target: "Current/Protocol" },
        { path: "Recent/Protocol-notes.md", target: "Recent/Protocol-notes" },
      ],
      query: "protocol",
      recentPaths: ["Recent/Protocol-notes.md"],
    });
    expect(exactBeforeRecentPrefix.results.map(({ path }) => path)).toEqual([
      "Current/Protocol.md",
      "Recent/Protocol-notes.md",
    ]);

    const recentBreaksTie = buildWikiLinkPickerSections({
      candidates: [
        { path: "Current/Protocol.md", target: "Current/Protocol" },
        { path: "Recent/Protocol.md", target: "Recent/Protocol" },
      ],
      query: "protocol",
      recentPaths: ["Recent/Protocol.md"],
    });
    expect(recentBreaksTie.results.map(({ path }) => path)).toEqual([
      "Recent/Protocol.md",
      "Current/Protocol.md",
    ]);
  });

  it("isolates persisted history by environment and workspace", () => {
    const first = wikiLinkRecentsStorageKey("local", "/workspace/one");
    expect(first).not.toBe(wikiLinkRecentsStorageKey("remote", "/workspace/one"));
    expect(first).not.toBe(wikiLinkRecentsStorageKey("local", "/workspace/two"));
  });
});
