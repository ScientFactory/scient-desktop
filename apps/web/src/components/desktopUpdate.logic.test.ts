import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  getScientDesktopUpdateLabel,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("Scient update labels", () => {
  // Every non-actionable status reaches the same "none" action; error is the one nearest Retry.
  it.each(["idle", "error"] as const)("keeps %s as the discovery icon", (status) =>
    expect(getScientDesktopUpdateLabel({ ...baseState, status })).toBeNull(),
  );
  it("offers download, restart, and recovery using the canonical action", () => {
    const available: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    const downloaded: DesktopUpdateState = {
      ...available,
      status: "downloaded",
      downloadedVersion: "1.1.0",
    };
    expect(getScientDesktopUpdateLabel(available)).toBe("Update");
    expect(getScientDesktopUpdateLabel(downloaded)).toBe("Restart");
    // Main-process failures retain available/downloaded rather than error status.
    expect(getScientDesktopUpdateLabel({ ...available, errorContext: "download" })).toBe("Retry");
    expect(getScientDesktopUpdateLabel({ ...downloaded, errorContext: "install" })).toBe("Retry");
  });
  it.each<[number | null, string]>([
    [40.9, "40%"],
    [100, "100%"],
    [-5, "0%"],
    [125, "100%"],
    [null, "…"],
    [NaN, "…"],
  ])("shows bounded progress for %s", (downloadPercent, label) =>
    expect(
      getScientDesktopUpdateLabel({ ...baseState, status: "downloading", downloadPercent }),
    ).toBe(label),
  );
});

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it("builds the Scient release URL for the reported downloaded version", () => {
    expect(getDesktopUpdateReleaseUrl("0.6.8")).toBe(
      "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.8",
    );
  });

  it.each([
    "",
    "   ",
    ".",
    "../repo",
    "owner/..",
    "owner/repo/extra",
    "owner#notes/repo",
    "owner/repo?tab=notes",
  ])("falls back to Scient for an invalid configured repository: %s", (repository) => {
    expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
      "https://github.com/ScientFactory/scient-desktop/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
      "https://github.com/ScientFactory/scient-desktop/releases/tag/v1.2.3",
    );
  });

  it("builds the nightly release URL without dropping its version suffix", () => {
    expect(getDesktopUpdateReleaseUrl("0.0.30-nightly.20260728.931")).toBe(
      "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.0.30-nightly.20260728.931",
    );
  });

  it("links Beta release notes and history to the isolated repository", () => {
    expect(getDesktopUpdateReleaseUrl("0.6.23-beta.20261010.1")).toBe(
      "https://github.com/ScientFactory/scient-desktop-beta/releases/tag/v0.6.23-beta.20261010.1",
    );
    expect(
      getDesktopUpdateReleaseUrl("0.6.23-beta.20261010.1", "ScientFactory/scient-desktop"),
    ).toBe(
      "https://github.com/ScientFactory/scient-desktop-beta/releases/tag/v0.6.23-beta.20261010.1",
    );
    expect(getDesktopUpdateReleaseHistoryUrl("beta", "ScientFactory/scient-desktop")).toBe(
      "https://github.com/ScientFactory/scient-desktop-beta/releases",
    );
  });

  it("builds the release history URL", () => {
    expect(getDesktopUpdateReleaseHistoryUrl()).toBe(
      "https://github.com/ScientFactory/scient-desktop/releases",
    );
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("Install update 1.1.1 and restart Scient?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("Install update and restart Scient?");
  });

  // SCIENT-FORK:START - preserve Scient main's platform-specific updater copy.
  // Only Windows adds a note; one other platform covers the shared text.
  it.each(["Win32", "MacIntel"])(
    "uses the Scient-branded install confirmation copy on %s",
    (platform) => {
      vi.stubGlobal("navigator", { platform });
      try {
        expect(
          getDesktopUpdateInstallConfirmationMessage({
            availableVersion: "1.1.0",
            downloadedVersion: "1.1.0",
          }),
        ).toBe(
          "Install update 1.1.0 and restart Scient?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing." +
            (platform === "Win32"
              ? "\n\nOn Windows, Scient may remain closed for several minutes while the update installs, and no installer window may appear. Scient will reopen automatically when installation finishes."
              : ""),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  // SCIENT-FORK:END
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});
