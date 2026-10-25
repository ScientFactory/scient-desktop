import { fileHeaderSubtitle, isSvgImagePreviewFile } from "./filePath";

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

describe("fileHeaderSubtitle", () => {
  // regression: 4fed6cfb35 feat: add inline file previews and attachment chips across surfaces (#11265)
  it("places a workspace file under its project", () => {
    expect(
      fileHeaderSubtitle("t3code", "apps/mobile/src/features/threads/fileChipMenu.test.ts"),
    ).toBe("t3code · apps/mobile/src/features/threads");
  });

  // regression: 4fed6cfb35 feat: add inline file previews and attachment chips across surfaces (#11265)
  it("shows only the directory for a host file outside the workspace", () => {
    expect(fileHeaderSubtitle("t3code", "/tmp/report.md")).toBe("/tmp");
  });

  // regression: 4fed6cfb35 feat: add inline file previews and attachment chips across surfaces (#11265)
  it("shows only the project for a file at the workspace root", () => {
    expect(fileHeaderSubtitle("t3code", "README.md")).toBe("t3code");
  });
});

describe("file preview types", () => {
  // regression: 30034ecedc Add archived threads and mobile file viewer (#3155)
  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
  });
});
