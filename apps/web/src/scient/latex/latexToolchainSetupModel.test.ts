import type { ScientLatexManagedInstallState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isActiveLatexInstall, latexSetupCardModel } from "./latexToolchainSetupModel";

function install(
  overrides: Partial<ScientLatexManagedInstallState> = {},
): ScientLatexManagedInstallState {
  return {
    state: "idle",
    version: "2026.08",
    bytesReceived: null,
    totalBytes: null,
    failureReason: null,
    updatedAtEpochMs: 1,
    ...overrides,
  };
}

describe("latexSetupCardModel", () => {
  it("offers the managed install when the environment can place one", () => {
    const model = latexSetupCardModel({
      canInstallManaged: true,
      install: null,
      requesting: false,
    });

    expect(model.kind).toBe("offer");
    expect(model.actionLabel).toBe("Install TinyTeX");
    expect(model.body).toContain("about 70 MB");
    expect(model.progressPercent).toBeNull();
    expect(model.busy).toBe(false);
  });

  it("keeps the manual instructions where Scient has nothing to install", () => {
    const model = latexSetupCardModel({
      canInstallManaged: false,
      install: null,
      requesting: false,
    });

    expect(model.kind).toBe("instructions");
    expect(model.actionLabel).toBeNull();
    expect(model.body).toContain("TeX Live");
  });

  it("shows the download's own progress and the phases after it", () => {
    const downloading = latexSetupCardModel({
      canInstallManaged: true,
      install: install({
        state: "downloading",
        bytesReceived: 35 * 1024 * 1024,
        totalBytes: 70 * 1024 * 1024,
      }),
      requesting: false,
    });
    expect(downloading.kind).toBe("installing");
    expect(downloading.body).toBe("Downloading TinyTeX — 35 MB of 70 MB.");
    expect(downloading.progressPercent).toBe(43);
    expect(downloading.actionLabel).toBeNull();

    // Each later phase moves the bar, so it never parks while the label changes.
    const verifying = latexSetupCardModel({
      canInstallManaged: true,
      install: install({ state: "verifying" }),
      requesting: false,
    });
    const unpacking = latexSetupCardModel({
      canInstallManaged: true,
      install: install({ state: "unpacking" }),
      requesting: false,
    });
    expect(verifying.progressPercent).toBeGreaterThan(downloading.progressPercent ?? 0);
    expect(unpacking.progressPercent).toBeGreaterThan(verifying.progressPercent ?? 0);
    expect(verifying.body).toBe("Checking the download…");
    expect(unpacking.body).toBe("Unpacking the distribution…");
  });

  it("keeps the bar moving before the server has reported any bytes", () => {
    const requested = latexSetupCardModel({
      canInstallManaged: true,
      install: null,
      requesting: true,
    });
    expect(requested.kind).toBe("installing");
    expect(requested.progressPercent).toBeGreaterThan(0);

    const started = latexSetupCardModel({
      canInstallManaged: true,
      install: install({ state: "downloading" }),
      requesting: false,
    });
    expect(started.progressPercent).toBeGreaterThan(0);
    expect(started.body).toBe("Downloading TinyTeX…");
  });

  it("stays on the finished install until the toolchain poll catches up", () => {
    const model = latexSetupCardModel({
      canInstallManaged: true,
      install: install({ state: "ready" }),
      requesting: false,
    });

    expect(model.kind).toBe("installing");
    expect(model.progressPercent).toBe(100);
  });

  it("explains a failure in the reader's terms and offers a retry", () => {
    const mismatch = latexSetupCardModel({
      canInstallManaged: true,
      install: install({ state: "failed", failureReason: "checksum-mismatch" }),
      requesting: false,
    });

    expect(mismatch.kind).toBe("failed");
    expect(mismatch.actionLabel).toBe("Try again");
    expect(mismatch.busy).toBe(false);
    expect(mismatch.body).toContain("discarded");

    const offline = latexSetupCardModel({
      canInstallManaged: true,
      install: install({ state: "failed", failureReason: "download-failed" }),
      requesting: false,
    });
    expect(offline.body).toContain("connection");
    // No reason is a shipped state too: the message must still read as English.
    expect(
      latexSetupCardModel({
        canInstallManaged: true,
        install: install({ state: "failed", failureReason: null }),
        requesting: false,
      }).body,
    ).toBe("The installation could not be finished.");
  });

  it("shows a retry as progress again once the request is in flight", () => {
    const model = latexSetupCardModel({
      canInstallManaged: true,
      install: install({ state: "failed", failureReason: "download-failed" }),
      requesting: true,
    });

    // The previous failure is still the server's state, but this client has
    // already asked again, so the card must not read as failed.
    expect(model.kind).toBe("installing");
  });
});

describe("isActiveLatexInstall", () => {
  it("counts only the phases with work left to watch", () => {
    expect(isActiveLatexInstall(null)).toBe(false);
    expect(isActiveLatexInstall(install({ state: "idle" }))).toBe(false);
    expect(isActiveLatexInstall(install({ state: "downloading" }))).toBe(true);
    expect(isActiveLatexInstall(install({ state: "verifying" }))).toBe(true);
    expect(isActiveLatexInstall(install({ state: "unpacking" }))).toBe(true);
    expect(isActiveLatexInstall(install({ state: "ready" }))).toBe(false);
    expect(isActiveLatexInstall(install({ state: "failed" }))).toBe(false);
  });
});
