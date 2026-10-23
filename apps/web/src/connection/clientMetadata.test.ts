import { describe, expect, it } from "vite-plus/test";

import { clientPresentationMetadata } from "./clientMetadata";

const desktopChrome = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
  platform: "Win32",
  maxTouchPoints: 0,
};

describe("client telemetry metadata", () => {
  it("uses Electron's client platform for desktop", () => {
    expect(
      clientPresentationMetadata({
        appVersion: "1.2.3",
        hosted: false,
        identity: desktopChrome,
        desktopBridge: { getClientPlatform: () => "darwin" },
      }),
    ).toEqual({
      label: "Scient Desktop",
      deviceType: "desktop",
      os: "macOS",
      surface: "desktop",
      appVersion: "1.2.3",
    });
  });
});
