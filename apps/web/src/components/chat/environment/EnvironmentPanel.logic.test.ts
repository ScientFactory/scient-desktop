import { describe, expect, it } from "vitest";

import { shouldShowStudioFolderRow, studioFolderActionLabel } from "./EnvironmentPanel.logic";

describe("Studio folder Environment row", () => {
  it("requires a selected Studio folder and the native shell", () => {
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: false,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: "  ",
        nativeShellAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: false,
      }),
    ).toBe(false);
  });

  it("names the native destination and includes the full target path", () => {
    expect(
      studioFolderActionLabel({
        studioFolderPath: "/Users/tester/Projects/demo",
        platform: "MacIntel",
      }),
    ).toBe("Open selected Studio folder in Finder: /Users/tester/Projects/demo");
    expect(
      studioFolderActionLabel({
        studioFolderPath: "C:\\Users\\tester\\demo",
        platform: "Win32",
      }),
    ).toBe("Open selected Studio folder in File Explorer: C:\\Users\\tester\\demo");
  });
});
