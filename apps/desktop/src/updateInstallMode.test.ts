import { describe, expect, it } from "vitest";

import { resolveDesktopUpdateInstallMode } from "./updateInstallMode";

describe("resolveDesktopUpdateInstallMode", () => {
  it("uses the automatic updater for signed packaged macOS releases", () => {
    expect(
      resolveDesktopUpdateInstallMode({
        platform: "darwin",
        isPackaged: true,
        signedRelease: true,
      }),
    ).toBe("automatic");
  });

  it("uses the guided manual handoff for unsigned or legacy packaged macOS releases", () => {
    expect(
      resolveDesktopUpdateInstallMode({
        platform: "darwin",
        isPackaged: true,
        signedRelease: false,
      }),
    ).toBe("manual");
    expect(
      resolveDesktopUpdateInstallMode({
        platform: "darwin",
        isPackaged: true,
        signedRelease: null,
      }),
    ).toBe("manual");
  });

  it("keeps Windows, Linux, and development builds on their normal updater paths", () => {
    expect(
      resolveDesktopUpdateInstallMode({
        platform: "win32",
        isPackaged: true,
        signedRelease: false,
      }),
    ).toBe("automatic");
    expect(
      resolveDesktopUpdateInstallMode({
        platform: "linux",
        isPackaged: true,
        signedRelease: false,
      }),
    ).toBe("automatic");
    expect(
      resolveDesktopUpdateInstallMode({
        platform: "darwin",
        isPackaged: false,
        signedRelease: false,
      }),
    ).toBe("automatic");
  });
});
