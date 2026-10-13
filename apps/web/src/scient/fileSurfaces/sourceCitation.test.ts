import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createSourceCitation, resolveSourceCitation } from "./sourceCitation";

const target = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("source"),
  cwd: "/project",
  path: "sample.ts",
};

describe("source citation line boundaries", () => {
  it.each(["\n", "\r\n", "\r"])("keeps a selected %j terminator on its preceding line", (eol) => {
    const source = `alpha${eol}beta${eol}`;
    const firstEnd = "alpha".length + eol.length;
    expect(createSourceCitation(target, source, source, 0, firstEnd)).toMatchObject({
      text: `alpha${eol}`,
      sourceStart: 0,
      sourceEnd: firstEnd,
      startLine: 1,
      endLine: 1,
    });
    expect(createSourceCitation(target, source, source, firstEnd, source.length)).toMatchObject({
      text: `beta${eol}`,
      startLine: 2,
      endLine: 2,
    });
    expect(createSourceCitation(target, source, source, 0, source.length)).toMatchObject({
      text: source,
      startLine: 1,
      endLine: 2,
    });
  });

  it("counts a mixed-ending selection from the complete source without changing UTF-16 offsets", () => {
    const source = "zero\r\n😀 alpha\rbeta\nlast";
    const from = source.indexOf("😀");
    const to = source.indexOf("last");
    const citation = createSourceCitation(target, source, "saved baseline", from, to)!;
    expect(citation).toMatchObject({
      text: "😀 alpha\rbeta\n",
      from,
      to,
      sourceStart: from,
      sourceEnd: to,
      startLine: 2,
      endLine: 3,
      origin: "draft",
    });
    expect(resolveSourceCitation(source, citation)).toEqual({ from, to });
    expect(createSourceCitation(target, source, source, from + 1, to)).toBeNull();
  });
});
