import { describe, expect, it } from "vite-plus/test";
import { isDefaultCopiedFile } from "./addProjectToMachine";

describe("isDefaultCopiedFile", () => {
  it("requires explicit selection for every cross-machine file copy", () => {
    expect(
      [
        ".env",
        "apps/web/.env.local",
        ".envrc",
        ".dev.vars",
        "dist.log",
        ".environment",
        "README.md",
      ].filter(isDefaultCopiedFile),
    ).toEqual([]);
  });
});
