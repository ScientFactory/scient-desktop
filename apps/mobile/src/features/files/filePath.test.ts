import { describe, expect, it } from "vite-plus/test";

import {
  resolveFileLinkTarget,
  resolveHostFilePath,
  fileHeaderSubtitle,
  isSvgImagePreviewFile,
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

describe("resolveFileLinkPath", () => {
  it.each([
    ["/home/maria/project", "~/.agents/AGENTS.md", "/home/maria/.agents/AGENTS.md"],
    ["/Users/maria/project", "~/notes.md", "/Users/maria/notes.md"],
    ["C:\\Users\\maria\\project", "~\\.agents\\AGENTS.md", "C:\\Users\\maria\\.agents\\AGENTS.md"],
  ])("expands a home link from %s", (cwd, path, expected) => {
    expect(resolveFileLinkPath(cwd, path)).toBe(expected);
    expect(fileRoutePathSegments(expected).join("/")).toBe(expected);
  });

  it("does not turn an unresolved home into a workspace path", () => {
    expect(resolveFileLinkPath("/repo", "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath(null, "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath("/repo", "../notes.md")).toBeNull();
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("recognizes home links inside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/home/maria/project", "~/project/src/main.ts")).toBe(
      "src/main.ts",
    );
    expect(
      resolveWorkspaceRelativeFilePath("/home/maria/project", "~/.agents/AGENTS.md"),
    ).toBeNull();
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "/repo/../outside.txt")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("file preview types", () => {
  it("identifies SVG images that need web rendering", () => {
    expect(isSvgImagePreviewFile("assets/diagram.svg#icon")).toBe(true);
    expect(isSvgImagePreviewFile("assets/photo.png")).toBe(false);
  });
});

describe("fileHeaderSubtitle", () => {
  it("places a workspace file under its project", () => {
    expect(
      fileHeaderSubtitle("t3code", "apps/mobile/src/features/threads/fileChipMenu.test.ts"),
    ).toBe("t3code · apps/mobile/src/features/threads");
  });

  it("shows only the directory for a host file outside the workspace", () => {
    expect(fileHeaderSubtitle("t3code", "/tmp/report.md")).toBe("/tmp");
  });

  it("shows only the project for a file at the workspace root", () => {
    expect(fileHeaderSubtitle("t3code", "README.md")).toBe("t3code");
  });
});

describe("resolveHostFilePath", () => {
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
