import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCloneProjectSourceInput,
  canAcceptProjectFolderDrop,
  getAvailableNewFolderName,
  inferCloneDirectoryName,
  isProjectFolderDrag,
  joinProjectPath,
  resolveDroppedProjectFolder,
} from "./AddProjectDialog.logic";

function makeFile(name: string): File {
  return new File([new Blob([])], name);
}

function makeDropItem(file: File, options?: { directory?: boolean }) {
  return {
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory: options?.directory === true }),
  };
}

describe("AddProjectDialog logic", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes OS file drags without treating internal text drags as folders", () => {
    expect(isProjectFolderDrag(["Files", "text/plain"])).toBe(true);
    expect(isProjectFolderDrag(["text/plain"])).toBe(false);
  });

  it("offers acceptance feedback only for one real directory", () => {
    const folder = makeFile("Research");
    const file = makeFile("notes.md");

    expect(
      canAcceptProjectFolderDrop({
        items: [makeDropItem(folder, { directory: true })],
        files: [folder],
      }),
    ).toBe(true);
    expect(canAcceptProjectFolderDrop({ items: [makeDropItem(file)], files: [file] })).toBe(false);
    expect(
      canAcceptProjectFolderDrop({
        items: [
          makeDropItem(folder, { directory: true }),
          makeDropItem(makeFile("Second"), { directory: true }),
        ],
        files: [folder],
      }),
    ).toBe(false);
  });

  it("resolves one dropped directory through the Electron path bridge", () => {
    const folder = makeFile("Research");
    vi.stubGlobal("window", {
      desktopBridge: {
        getPathForFile: () => "/Users/tester/Research (2)",
      },
    });

    expect(
      resolveDroppedProjectFolder({
        items: [makeDropItem(folder, { directory: true })],
        files: [folder],
      }),
    ).toEqual({ path: "/Users/tester/Research (2)" });
  });

  it("rejects files, ambiguous multi-folder drops, and unavailable absolute paths", () => {
    const file = makeFile("notes.md");
    const folder = makeFile("Research");
    vi.stubGlobal("window", { desktopBridge: { getPathForFile: () => null } });

    expect(resolveDroppedProjectFolder({ items: [makeDropItem(file)], files: [file] })).toEqual({
      error: "Drop a folder, not a file.",
    });
    expect(
      resolveDroppedProjectFolder({
        items: [
          makeDropItem(folder, { directory: true }),
          makeDropItem(makeFile("Second"), { directory: true }),
        ],
        files: [folder],
      }),
    ).toEqual({ error: "Drop one folder at a time." });
    expect(
      resolveDroppedProjectFolder({
        items: [makeDropItem(folder, { directory: true })],
        files: [folder],
      }),
    ).toEqual({ error: "Could not read the folder's path. Use browse below instead." });
  });

  it("rejects a dropped path that downstream project normalization would trim", () => {
    const folder = makeFile("Research ");
    vi.stubGlobal("window", {
      desktopBridge: {
        getPathForFile: () => "/Users/tester/Research ",
      },
    });

    expect(
      resolveDroppedProjectFolder({
        items: [makeDropItem(folder, { directory: true })],
        files: [folder],
      }),
    ).toEqual({
      error: "Folders with names ending in whitespace cannot be dropped. Use browse below instead.",
    });
  });

  it("derives stable destination folder names from supported repository inputs", () => {
    expect(inferCloneDirectoryName("git-url", "https://github.com/owner/repo.git")).toBe("repo");
    expect(inferCloneDirectoryName("git-url", "git@gitlab.com:group/repo.git")).toBe("repo");
    expect(inferCloneDirectoryName("github", "owner/repo")).toBe("repo");
    expect(inferCloneDirectoryName("gitlab", "group/nested/repo.git")).toBe("repo");
  });

  it("joins Unix and Windows project paths without mixed separators", () => {
    expect(joinProjectPath("/Users/tester/projects/", "repo")).toBe("/Users/tester/projects/repo");
    expect(joinProjectPath("C:\\Users\\tester\\projects\\", "repo")).toBe(
      "C:\\Users\\tester\\projects\\repo",
    );
  });

  it("chooses a collision-safe new folder name across case-sensitive filesystems", () => {
    expect(getAvailableNewFolderName([])).toBe("New folder");
    expect(getAvailableNewFolderName(["New folder", "New folder 2"])).toBe("New folder 3");
    expect(getAvailableNewFolderName(["NEW FOLDER"])).toBe("New folder 2");
  });

  it("builds the source-specific clone payload", () => {
    expect(
      buildCloneProjectSourceInput({
        source: "git-url",
        repositoryInput: " https://example.com/repo.git ",
        destinationPath: "/tmp/repo",
      }),
    ).toEqual({
      source: "git-url",
      remoteUrl: "https://example.com/repo.git",
      destinationPath: "/tmp/repo",
    });
    expect(
      buildCloneProjectSourceInput({
        source: "gitlab",
        repositoryInput: " group/repo ",
        destinationPath: "/tmp/repo",
      }),
    ).toEqual({
      source: "gitlab",
      repository: "group/repo",
      destinationPath: "/tmp/repo",
    });
  });
});
