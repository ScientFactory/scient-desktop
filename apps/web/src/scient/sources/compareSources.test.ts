import { describe, expect, it } from "vite-plus/test";

import { COMPARE_SOURCES_LIMIT, compareSourcesInsertion } from "./compareSources";

const lead = "Compare these sources from my Library with the compare-sources skill:";

describe("compareSourcesInsertion", () => {
  it("names each source by title and key, or its ID when it has no key", () => {
    expect(
      compareSourcesInsertion("", [
        { sourceId: "src_a", title: "Sleep and\n  memory", citationKey: "smith2020" },
        { sourceId: "src_b", title: null },
      ]),
    ).toEqual({
      kind: "insert",
      text: `${lead} Sleep and memory (smith2020); Untitled source (src_b). Question: `,
      listed: 2,
    });
  });

  it("lists at most the limit and says how many were selected", () => {
    const sources = Array.from({ length: COMPARE_SOURCES_LIMIT + 3 }, (_, index) => ({
      sourceId: `src_${index}`,
      title: `Paper ${index}`,
    }));
    const insertion = compareSourcesInsertion("", sources);
    expect(insertion.kind === "insert" && insertion.listed).toBe(COMPARE_SOURCES_LIMIT);
    const text = insertion.kind === "insert" ? insertion.text : "";
    expect(text).toContain(`Paper ${COMPARE_SOURCES_LIMIT - 1} (src_${COMPARE_SOURCES_LIMIT - 1})`);
    expect(text).not.toContain(`(src_${COMPARE_SOURCES_LIMIT})`);
    expect(text).toContain(
      `I selected ${COMPARE_SOURCES_LIMIT + 3}; these are the first ${COMPARE_SOURCES_LIMIT}. Question: `,
    );
  });

  it("keeps a draft that already asks for this comparison and refuses to stack another", () => {
    const sources = [
      { sourceId: "src_a", title: "A", citationKey: "a2020" },
      { sourceId: "src_b", title: "B", citationKey: "b2021" },
    ];
    const first = compareSourcesInsertion("", sources);
    const typed = first.kind === "insert" ? `${first.text}Which used actigraphy?` : "";
    expect(compareSourcesInsertion(typed, sources)).toEqual({ kind: "present" });
    expect(compareSourcesInsertion(typed, sources.slice(0, 1).concat(sources[0]!))).toEqual({
      kind: "other-request",
    });
    expect(compareSourcesInsertion("Which used actigraphy?", sources).kind).toBe("insert");
  });
});
