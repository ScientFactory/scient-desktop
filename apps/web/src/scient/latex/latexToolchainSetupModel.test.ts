import type { ScientLatexManagedInstallState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isActiveLatexInstall,
  latexSetupCardModel,
  type LatexSetupCardInput,
} from "./latexToolchainSetupModel";

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

/** The card is only on screen while the probe reports no engine. */
function card(overrides: Partial<LatexSetupCardInput> = {}): LatexSetupCardInput {
  return {
    canInstallManaged: true,
    install: null,
    requesting: false,
    toolchainMissing: true,
    ...overrides,
  };
}

describe("latexSetupCardModel", () => {
  it("offers the managed install when the environment can place one", () => {
    const model = latexSetupCardModel(card());

    expect(model.kind).toBe("offer");
    expect(model.actionLabel).toBe("Install TinyTeX");
    expect(model.body).toContain("about 70 MB");
    expect(model.progressPercent).toBeNull();
    expect(model.busy).toBe(false);
  });

  it("keeps the manual instructions where Scient has nothing to install", () => {
    const model = latexSetupCardModel(card({ canInstallManaged: false }));

    expect(model.kind).toBe("instructions");
    expect(model.actionLabel).toBeNull();
    expect(model.body).toContain("TeX Live");
  });

  it("shows the download's own progress and the phases after it", () => {
    const downloading = latexSetupCardModel(
      card({
        install: install({
          state: "downloading",
          bytesReceived: 35 * 1024 * 1024,
          totalBytes: 70 * 1024 * 1024,
        }),
      }),
    );
    expect(downloading.kind).toBe("installing");
    expect(downloading.body).toBe("Downloading TinyTeX — 35 MB of 70 MB.");
    expect(downloading.progressPercent).toBe(43);
    expect(downloading.actionLabel).toBeNull();

    // Each later phase moves the bar, so it never parks while the label changes.
    const verifying = latexSetupCardModel(card({ install: install({ state: "verifying" }) }));
    const unpacking = latexSetupCardModel(card({ install: install({ state: "unpacking" }) }));
    const packages = latexSetupCardModel(
      card({ install: install({ state: "installing-packages" }) }),
    );
    expect(verifying.progressPercent).toBeGreaterThan(downloading.progressPercent ?? 0);
    expect(unpacking.progressPercent).toBeGreaterThan(verifying.progressPercent ?? 0);
    expect(packages.progressPercent).toBeGreaterThan(unpacking.progressPercent ?? 0);
    expect(verifying.body).toBe("Checking the download…");
    expect(unpacking.body).toBe("Unpacking the distribution…");
    expect(packages.kind).toBe("installing");
    expect(packages.body).toBe("Installing common LaTeX packages…");
  });

  it("carries a finished install's package note without calling it a failure", () => {
    const warning =
      "Common packages could not be preinstalled; missing ones will install on first use.";
    const model = latexSetupCardModel(
      card({
        install: install({ state: "ready", packagesWarning: warning }),
        toolchainMissing: false,
      }),
    );

    // The engine works; the note is a note, and the card still reads as done.
    expect(model.kind).toBe("installing");
    expect(model.progressPercent).toBe(100);
    expect(model.warning).toBe(warning);
    expect(latexSetupCardModel(card({ install: install({ state: "ready" }) })).warning).toBeNull();
  });

  it("keeps the bar moving before the server has reported any bytes", () => {
    const requested = latexSetupCardModel(card({ requesting: true }));
    expect(requested.kind).toBe("installing");
    expect(requested.progressPercent).toBeGreaterThan(0);

    const started = latexSetupCardModel(card({ install: install({ state: "downloading" }) }));
    expect(started.progressPercent).toBeGreaterThan(0);
    expect(started.body).toBe("Downloading TinyTeX…");
  });

  it("stays on the finished install until the toolchain poll catches up", () => {
    const model = latexSetupCardModel(
      card({ install: install({ state: "ready" }), toolchainMissing: false }),
    );

    expect(model.kind).toBe("installing");
    expect(model.progressPercent).toBe(100);
  });

  it("offers another install when a finished one left nothing that runs", () => {
    const model = latexSetupCardModel(card({ install: install({ state: "ready" }) }));

    // The server drops the probe cache before reporting `ready`, so a probe
    // that still finds nothing will keep finding nothing: a card that spun
    // here would spin for the life of the window with nothing to press.
    expect(model.busy).toBe(false);
    expect(model.progressPercent).toBeNull();
    expect(model.actionLabel).toBe("Install again");
    expect(model.body).toContain("cannot run LaTeX");
  });

  it("explains a failure in the reader's terms and offers a retry", () => {
    const mismatch = latexSetupCardModel(
      card({ install: install({ state: "failed", failureReason: "checksum-mismatch" }) }),
    );

    expect(mismatch.kind).toBe("failed");
    expect(mismatch.actionLabel).toBe("Try again");
    expect(mismatch.busy).toBe(false);
    expect(mismatch.body).toContain("discarded");

    const offline = latexSetupCardModel(
      card({ install: install({ state: "failed", failureReason: "download-failed" }) }),
    );
    expect(offline.body).toContain("connection");
    // No reason is a shipped state too: the message must still read as English.
    expect(
      latexSetupCardModel(card({ install: install({ state: "failed", failureReason: null }) }))
        .body,
    ).toBe("The installation could not be finished.");
  });

  it("shows a retry as progress again once the request is in flight", () => {
    const model = latexSetupCardModel(
      card({
        install: install({ state: "failed", failureReason: "download-failed" }),
        requesting: true,
      }),
    );

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
    // The eager package fetch is work the loop still has to watch.
    expect(isActiveLatexInstall(install({ state: "installing-packages" }))).toBe(true);
    expect(isActiveLatexInstall(install({ state: "ready" }))).toBe(false);
    expect(isActiveLatexInstall(install({ state: "failed" }))).toBe(false);
  });
});
