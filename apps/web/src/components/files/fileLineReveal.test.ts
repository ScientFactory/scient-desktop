import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createSourceCitation } from "~/scient/fileSurfaces/sourceCitation";
import { resolveCenteredFileLineScrollTop, resolveFileRevealLine } from "./fileLineReveal";

describe("resolveCenteredFileLineScrollTop", () => {
  it("centers an estimated virtualized line position", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 0,
        scrollHeight: 2_000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1_000, height: 20 },
      }),
    ).toBe(830);
  });

  it("corrects a stale estimate from the rendered line geometry", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 830,
        scrollHeight: 2_000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1_000, height: 20 },
        renderedLine: { top: 620, height: 20 },
      }),
    ).toBe(1_160);
  });
});

describe("resolveFileRevealLine", () => {
  const source = "header\nconst alpha = 1;\nfooter\n";
  const from = source.indexOf("alpha");
  const citation = createSourceCitation(
    {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("source"),
      cwd: "/project",
      path: "sample.ts",
    },
    source,
    source,
    from,
    from + 5,
  )!;

  it("gives the verified current quote precedence over the recorded scroll target", () => {
    const moved = "inserted\n".repeat(100) + source;
    expect(resolveFileRevealLine(moved, citation.startLine, citation)).toBe(102);
    expect(resolveFileRevealLine(moved, null, citation)).toBe(102);
  });

  it("falls back to the recorded line without choosing an ambiguous or missing quote", () => {
    expect(resolveFileRevealLine(source + source, 50, citation)).toBe(2);
    expect(resolveFileRevealLine(source.replace("alpha", "gamma"), 50, citation)).toBe(2);
    expect(resolveFileRevealLine("gone", citation.startLine, citation)).toBe(1);
  });

  it("preserves ordinary line links, including mixed line endings and an absent request", () => {
    expect(resolveFileRevealLine("one\r\ntwo\rthree\n", 3)).toBe(3);
    expect(resolveFileRevealLine("one\r\ntwo\rthree\n", 99)).toBe(4);
    expect(resolveFileRevealLine(source, null)).toBeNull();
  });
});
