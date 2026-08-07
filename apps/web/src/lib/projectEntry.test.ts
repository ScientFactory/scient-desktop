import { describe, expect, it } from "@effect/vitest";

import {
  getAvailableNewFolderName,
  joinProjectPath,
  resolveDroppedProjectFolder,
} from "./projectEntry";

describe("project entry helpers", () => {
  it("chooses a collision-safe new folder name", () => {
    expect(getAvailableNewFolderName(["New folder", "new FOLDER 2"])).toBe("New folder 3");
  });

  it("joins POSIX and Windows browse paths", () => {
    expect(joinProjectPath("/Users/me/Studies/", "New folder")).toBe(
      "/Users/me/Studies/New folder",
    );
    expect(joinProjectPath("C:\\Studies\\", "New folder")).toBe("C:\\Studies\\New folder");
  });

  it("accepts one Electron-resolved folder and rejects files", () => {
    const folder = {} as File;
    expect(
      resolveDroppedProjectFolder(
        {
          files: [folder],
          items: [
            {
              kind: "file",
              getAsFile: () => folder,
              webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }),
            },
          ],
        },
        () => "/Users/me/Study",
      ),
    ).toEqual({ path: "/Users/me/Study" });

    expect(
      resolveDroppedProjectFolder(
        {
          files: [folder],
          items: [
            {
              kind: "file",
              getAsFile: () => folder,
              webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }),
            },
          ],
        },
        () => "/Users/me/note.txt",
      ),
    ).toEqual({ error: "Drop a folder, not a file." });
  });
});
