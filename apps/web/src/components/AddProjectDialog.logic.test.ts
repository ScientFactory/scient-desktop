import { describe, expect, it } from "vitest";

import {
  buildCloneProjectSourceInput,
  getAvailableNewFolderName,
  inferCloneDirectoryName,
  joinProjectPath,
} from "./AddProjectDialog.logic";

describe("AddProjectDialog logic", () => {
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
