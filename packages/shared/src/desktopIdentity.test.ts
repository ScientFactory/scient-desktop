import { describe, expect, it } from "vitest";

import {
  SCIENT_APP_NAME,
  SCIENT_DESKTOP_ENTRY_URL,
  SCIENT_DESKTOP_DEB_UPDATE_CHANNEL,
  SCIENT_DESKTOP_ORIGIN,
  SCIENT_DESKTOP_UPDATE_CHANNEL,
  SCIENT_DESKTOP_UPDATES_ENABLED,
  SCIENT_DEVELOPMENT_BUNDLE_ID,
  SCIENT_PRODUCTION_BUNDLE_ID,
  scientBundleId,
  scientDesktopUpdateChannel,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact Scient product name and bundle IDs", () => {
    expect(SCIENT_APP_NAME).toBe("Scient");
    expect(SCIENT_PRODUCTION_BUNDLE_ID).toBe("com.scientfactory.scient");
    expect(SCIENT_DEVELOPMENT_BUNDLE_ID).toBe("com.scientfactory.scient.dev");
    expect(scientBundleId(false)).toBe(SCIENT_PRODUCTION_BUNDLE_ID);
    expect(scientBundleId(true)).toBe(SCIENT_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SCIENT_DESKTOP_ORIGIN).toBe("scient://app");
    expect(SCIENT_DESKTOP_ENTRY_URL).toBe("scient://app/index.html");
  });

  it("enables the approved Scient-owned release channel", () => {
    expect(SCIENT_DESKTOP_UPDATE_CHANNEL).toBe("scient");
    expect(SCIENT_DESKTOP_DEB_UPDATE_CHANNEL).toBe("scient-deb");
    expect(SCIENT_DESKTOP_UPDATES_ENABLED).toBe(true);
    expect(scientDesktopUpdateChannel("linux", "deb")).toBe("scient-deb");
    expect(scientDesktopUpdateChannel("linux", "AppImage")).toBe("scient");
    expect(scientDesktopUpdateChannel("darwin", null)).toBe("scient");
  });
});
