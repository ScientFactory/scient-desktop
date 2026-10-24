import { describe, expect, it } from "vite-plus/test";

import { resolveFileLinkTarget, resolveHostFilePath } from "./filePath";

describe("resolveHostFilePath", () => {
  // regression: 79d741c351 fix(files): open the file a link means, wherever it lives
  it("places a link that climbs out of the workspace on the host", () => {
    expect(resolveHostFilePath("/Users/me/project", "../reviews/notes.md")).toBe(
      "/Users/me/reviews/notes.md",
    );
    expect(resolveHostFilePath("/Users/me/project", "/tmp/a/../report.md")).toBe("/tmp/report.md");
  });

  it("cannot place a home-relative path or a relative path without a workspace", () => {
    expect(resolveHostFilePath("/Users/me/project", "~/notes.md")).toBeNull();
    expect(resolveHostFilePath(null, "../notes.md")).toBeNull();
  });
});

describe("resolveFileLinkTarget", () => {
  // regression: 6443fdb33e fix(files): close the gaps found in review of location-independent opening
  it("keeps workspace files editable however the path is spelled", () => {
    expect(resolveFileLinkTarget("/Users/me/project", "docs/notes.md")).toEqual({
      kind: "workspace",
      path: "docs/notes.md",
    });
    expect(resolveFileLinkTarget("/Users/me/project", "../project/notes.md")).toEqual({
      kind: "workspace",
      path: "notes.md",
    });
    expect(
      resolveFileLinkTarget("/Users/me/project", "/Users/me/project/docs/../notes.md"),
    ).toEqual({ kind: "workspace", path: "notes.md" });
  });

  it("opens a file outside the workspace as a host file", () => {
    expect(resolveFileLinkTarget("/Users/me/project", "../reviews/notes.md")).toEqual({
      kind: "host",
      path: "/Users/me/reviews/notes.md",
    });
    expect(resolveFileLinkTarget("/Users/me/project", "~/notes.md")).toEqual({
      kind: "host",
      path: "/Users/me/notes.md",
    });
    expect(resolveFileLinkTarget("/Users/me/project", "~/project/src/./file.ts")).toEqual({
      kind: "workspace",
      path: "src/file.ts",
    });
    expect(resolveFileLinkTarget(undefined, "~/notes.md")).toBeNull();
  });
});
