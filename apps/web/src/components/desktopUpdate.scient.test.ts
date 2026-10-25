import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";

// Restored from the upstream-deleted desktopUpdate.toast.test.tsx against the live helpers: the
// toast is gone, and the update-ready notice now opens release notes through these.
const downloaded: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.6.7",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.6.8",
  downloadedVersion: "0.6.8",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
};

describe("desktop update release notes", () => {
  // regression: 555fb6f821 fix(web): follow configured desktop update repository (#21210)
  it("opens release notes from the configured repository", () => {
    expect(getDesktopUpdateReleaseUrl("0.6.8", "JustYannicc/t3code")).toBe(
      "https://github.com/JustYannicc/t3code/releases/tag/v0.6.8",
    );
  });

  // regression: 41124c7260 fix(desktop): link release notes from the update downloaded toast (#4771)
  it("falls back to the version the download was started for", () => {
    // The `update-downloaded` event can land after the download RPC resolves.
    expect(getDesktopUpdateDownloadedVersion({ ...downloaded, downloadedVersion: null })).toBe(
      "0.6.8",
    );
  });
});
