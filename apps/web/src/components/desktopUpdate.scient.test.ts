import { resolveProviderAppUpdateAction } from "~/scient/desktopUpdate/providerAppUpdate.logic";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
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

it("native preparation blocks every update action even while the archive remains downloaded", () => {
  const preparing: DesktopUpdateState = {
    ...downloaded,
    status: "preparing",
    message: "Preparing update… Verifying the authorized release.",
  };
  expect(resolveDesktopUpdateButtonAction(preparing)).toBe("none");
  expect(canCheckForUpdate(preparing)).toBe(false);
  expect(isDesktopUpdateButtonDisabled(preparing)).toBe(true);
  expect(getDesktopUpdateButtonTooltip(preparing)).toBe(preparing.message);
  // The installer took over while its progress still read "preparing"; that is not a failure.
  expect(
    getDesktopUpdateActionError({ accepted: true, completed: false, state: preparing }),
  ).toBeNull();
});

describe("updating the app for a provider", () => {
  it("asks for a restart when the update is ready", () => {
    expect(resolveProviderAppUpdateAction(downloaded)).toBe("confirm-install");
  });

  it("retries a restart that the user already confirmed", () => {
    expect(
      resolveProviderAppUpdateAction({ ...downloaded, status: "error", errorContext: "install" }),
    ).toBe("retry-install");
  });

  it("downloads the available update, including after a failed download", () => {
    const available: DesktopUpdateState = {
      ...downloaded,
      downloadedVersion: null,
      status: "available",
    };
    expect(resolveProviderAppUpdateAction(available)).toBe("download");
    expect(
      resolveProviderAppUpdateAction({ ...available, status: "error", errorContext: "download" }),
    ).toBe("download");
  });

  it("checks for an update when none is offered", () => {
    expect(
      resolveProviderAppUpdateAction({
        ...downloaded,
        status: "up-to-date",
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toBe("check");
  });

  it("waits for the updater state and leaves an active or disabled updater alone", () => {
    expect(resolveProviderAppUpdateAction(null)).toBeNull();
    for (const status of ["checking", "downloading", "preparing", "disabled"] as const) {
      expect(resolveProviderAppUpdateAction({ ...downloaded, status }), status).toBeNull();
    }
  });
});
