import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  // regression: 409ff90a14 Nightly release channel (#2012)
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Scient",
            stageLabel: "Nightly",
            displayName: "Scient (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("Scient");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Scient (Nightly)");
  });

  // regression: aa8b9f2286 Deploy hosted web app from release workflow (#2507)
  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Scient (Nightly)");
  });

  // regression: 2b180a2b2d Refine T3 Connect authorization surfaces (#4159)
  it("does not label the latest hosted app channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Latest");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("Scient");
  });
});

describe("branding logic", () => {
  it("identifies a Beta server explicitly", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.6.23-beta.20261010.1",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Beta");
  });

  // regression: 8d61172f8b Cosmetic fix: Sync web title with nightly server branding (#3219)
  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Scient",
        fallbackDisplayName: "Scient (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("Scient (Nightly)");
  });

  // regression: 8d61172f8b Cosmetic fix: Sync web title with nightly server branding (#3219)
  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Scient",
        fallbackDisplayName: "Scient (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("Scient (Alpha)");
  });

  // regression: 8d61172f8b Cosmetic fix: Sync web title with nightly server branding (#3219)
  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Scient",
        fallbackDisplayName: "Scient (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("Scient (Alpha)");
  });
});
