import type { ScientPandocToolStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pandocToolSummary,
  formatMegabytes,
  isActivePandocInstall,
  pandocReleaseNotice,
  pandocToolView,
} from "./pandocToolModel";

function status(overrides: Partial<ScientPandocToolStatus> = {}): ScientPandocToolStatus {
  return {
    version: "3.11",
    installed: false,
    canInstall: true,
    unavailableReason: null,
    downloadBytes: 41_832_712,
    install: {
      state: "idle",
      bytesReceived: null,
      totalBytes: null,
      failureReason: null,
      updatedAtEpochMs: 1,
    },
    ...overrides,
  };
}

describe("pandocToolView", () => {
  it("offers the install with its download size", () => {
    const view = pandocToolView({ status: status(), requesting: false, error: null });
    expect(view.kind).toBe("offer");
    expect(view.actionLabel).toBe("Install Pandoc (40 MB)");
    expect(view.detail).toContain("Word export needs Pandoc (40 MB)");
  });

  it("reports download progress without an action while installing", () => {
    const view = pandocToolView({
      status: status({
        install: {
          state: "downloading",
          bytesReceived: 12 * 1024 * 1024,
          totalBytes: 41_832_712,
          failureReason: null,
          updatedAtEpochMs: 2,
        },
      }),
      requesting: false,
      error: null,
    });
    expect(view).toMatchObject({ kind: "installing", actionLabel: null, busy: true });
    expect(view.detail).toBe("Downloading Pandoc… 12 MB of 40 MB");
    expect(pandocToolView({ status: status(), requesting: true, error: null }).kind).toBe(
      "installing",
    );
  });

  it("explains a failed install and offers to try again", () => {
    const view = pandocToolView({
      status: status({
        install: {
          state: "failed",
          bytesReceived: null,
          totalBytes: null,
          failureReason: "checksum-mismatch",
          updatedAtEpochMs: 3,
        },
      }),
      requesting: false,
      error: null,
    });
    expect(view.kind).toBe("failed");
    expect(view.detail).toContain("did not match the release Scient pinned");
    expect(view.actionLabel).toBe("Try again");
  });

  it("offers a reinstall when the installed Pandoc could not be started", () => {
    const view = pandocToolView({
      status: status({ reinstallRequired: true }),
      requesting: false,
      error: null,
    });
    expect(view).toMatchObject({
      kind: "reinstall",
      actionLabel: "Reinstall Pandoc (40 MB)",
      busy: false,
    });
    expect(view.detail).toBe("Pandoc could not be started. Reinstall it to export to Word.");
    // While the reinstall runs, and if it fails, the usual progress and retry show.
    expect(
      pandocToolView({ status: status({ reinstallRequired: true }), requesting: true, error: null })
        .kind,
    ).toBe("installing");
    expect(
      pandocToolView({
        status: status({
          reinstallRequired: true,
          install: {
            state: "failed",
            bytesReceived: null,
            totalBytes: null,
            failureReason: "download-failed",
            updatedAtEpochMs: 4,
          },
        }),
        requesting: false,
        error: null,
      }).actionLabel,
    ).toBe("Try again");
  });

  it("says when Word export cannot run here, and when it is ready", () => {
    expect(
      pandocToolView({
        status: status({
          canInstall: false,
          downloadBytes: null,
          unavailableReason: "Pandoc 3.11 is not available for win32-arm64.",
        }),
        requesting: false,
        error: null,
      }),
    ).toMatchObject({ kind: "unavailable", actionLabel: null });
    expect(
      pandocToolView({ status: status({ installed: true }), requesting: false, error: null }).kind,
    ).toBe("ready");
  });

  it("lets a status that could not be read be read again", () => {
    expect(pandocToolView({ status: null, requesting: false, error: "Offline." })).toMatchObject({
      kind: "failed",
      detail: "Offline.",
      actionLabel: "Check again",
      unchecked: true,
    });
    expect(pandocToolView({ status: null, requesting: false, error: null }).kind).toBe("loading");
  });

  it("shows a failed progress poll over stale downloading status and offers a status retry", () => {
    expect(
      pandocToolView({
        status: status({
          install: {
            state: "downloading",
            bytesReceived: 12 * 1024 * 1024,
            totalBytes: 41_832_712,
            failureReason: null,
            updatedAtEpochMs: 2,
          },
        }),
        requesting: false,
        error: "Status temporarily unavailable.",
      }),
    ).toMatchObject({
      kind: "failed",
      detail: "Status temporarily unavailable.",
      actionLabel: "Try again",
    });
  });
});

describe("pandocReleaseNotice", () => {
  it("names the release, its licence, and its source", () => {
    expect(
      pandocReleaseNotice(
        status({
          license: "GPL-2.0-or-later",
          sourceUrl: "https://github.com/jgm/pandoc/archive/refs/tags/3.11.tar.gz",
        }),
      ),
    ).toEqual({
      release: "Pandoc 3.11",
      label: "Pandoc 3.11 · GPL-2.0-or-later",
      sourceUrl: "https://github.com/jgm/pandoc/archive/refs/tags/3.11.tar.gz",
    });
    // A server that predates the notice still names its release.
    expect(pandocReleaseNotice(status())).toEqual({
      release: "Pandoc 3.11",
      label: "Pandoc 3.11",
      sourceUrl: null,
    });
    expect(pandocReleaseNotice(null)).toBeNull();
  });
});

describe("helpers", () => {
  it("rounds sizes and knows the active phases", () => {
    expect(formatMegabytes(41_832_712)).toBe("40 MB");
    expect(formatMegabytes(10)).toBe("1 MB");
    expect(isActivePandocInstall(null)).toBe(false);
    expect(
      isActivePandocInstall(
        status({
          install: {
            state: "verifying",
            bytesReceived: null,
            totalBytes: null,
            failureReason: null,
            updatedAtEpochMs: 1,
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("pandocToolSummary", () => {
  it("gives the Word tab one plain word or two for every state", () => {
    const view = (kind: Parameters<typeof pandocToolSummary>[0]["kind"]) =>
      pandocToolSummary({ kind, detail: "", actionLabel: null, busy: false });
    expect(view("loading")).toBe("Checking…");
    expect(view("ready")).toBe("Ready");
    expect(view("installing")).toBe("Installing…");
    expect(view("reinstall")).toBe("Not working");
    expect(view("unavailable")).toBe("Unavailable");
    expect(view("offer")).toBe("Not installed");
    expect(view("failed")).toBe("Not installed");
  });
});
