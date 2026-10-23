import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowSidebarUpdateRestartIcon } from "./SidebarUpdatePill";

const nightlyState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "nightly",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.36-nightly.3",
  downloadedVersion: null,
  releaseNotes: [{ version: "0.0.36-nightly.3", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("sidebar update restart icon", () => {
  it("hides the icon when the downloaded update is ready to restart", () => {
    expect(
      shouldShowSidebarUpdateRestartIcon({
        ...nightlyState,
        status: "downloaded",
        downloadedVersion: nightlyState.availableVersion,
      }),
    ).toBe(false);
  });

  it("shows the icon only when retrying a failed install", () => {
    expect(
      shouldShowSidebarUpdateRestartIcon({
        ...nightlyState,
        status: "error",
        errorContext: "install",
        canRetry: true,
      }),
    ).toBe(true);
    expect(
      shouldShowSidebarUpdateRestartIcon({
        ...nightlyState,
        status: "error",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBe(false);
  });
});
