import { EnvironmentFilePath } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { missingFileChoices } from "./useMissingFileChoices";

const path = EnvironmentFilePath.make;
const missingPath = path("/Users/me/project/dup.md");

describe("missingFileChoices", () => {
  it("offers a single match as a choice rather than opening it", () => {
    expect(
      missingFileChoices({ _tag: "recovered", path: path("reviews/inside.md"), missingPath }),
    ).toEqual({ paths: ["reviews/inside.md"], incomplete: false });
  });

  it("offers every file in a tie", () => {
    expect(
      missingFileChoices({ _tag: "tie", paths: [path("a/dup.md"), path("b/dup.md")], missingPath }),
    ).toEqual({ paths: ["a/dup.md", "b/dup.md"], incomplete: false });
  });

  it("says when the workspace could not be searched completely", () => {
    expect(
      missingFileChoices({ _tag: "incomplete", paths: [path("a/dup.md")], missingPath }),
    ).toEqual({ paths: ["a/dup.md"], incomplete: true });
  });

  it("offers nothing when nothing matches or the path exists", () => {
    expect(missingFileChoices({ _tag: "none", missingPath })).toEqual({
      paths: [],
      incomplete: false,
    });
    expect(missingFileChoices({ _tag: "literal", path: missingPath }).paths).toEqual([]);
    expect(missingFileChoices(null).paths).toEqual([]);
  });
});
