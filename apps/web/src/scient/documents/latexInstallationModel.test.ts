import type {
  ScientLatexManagedInstallState,
  ScientLatexToolchainReport,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { latexInstallationView } from "./latexInstallationModel";

function report(overrides: Partial<ScientLatexToolchainReport> = {}): ScientLatexToolchainReport {
  return {
    kind: null,
    executable: null,
    version: null,
    probedAtEpochMs: 1,
    canInstallManaged: true,
    ...overrides,
  };
}

function install(state: ScientLatexManagedInstallState["state"]): ScientLatexManagedInstallState {
  return {
    state,
    version: "2026.08",
    bytesReceived: null,
    totalBytes: null,
    failureReason: state === "failed" ? "download-failed" : null,
    updatedAtEpochMs: 1,
  };
}

const view = (input: Partial<Parameters<typeof latexInstallationView>[0]>) =>
  latexInstallationView({ report: null, requesting: false, error: null, ...input });

describe("the LaTeX installation line", () => {
  it("names the engine and where it came from", () => {
    expect(
      view({
        report: report({
          kind: "latexmk",
          executable: "latexmk",
          version: "4.85",
          source: "system",
        }),
      }),
    ).toMatchObject({
      kind: "ready",
      summary: "Installed",
      detail: "latexmk 4.85 · System installation",
    });
    expect(
      view({
        report: report({
          kind: "latexmk",
          executable: "x",
          version: null,
          source: "scient-managed",
        }),
      }).detail,
    ).toBe("latexmk · TinyTeX, installed by Scient");
    expect(
      view({ report: report({ kind: "tectonic", executable: "tectonic", version: "0.15.0" }) })
        .detail,
    ).toBe("Tectonic 0.15.0 · System installation");
  });

  it("offers TinyTeX when nothing is installed", () => {
    expect(view({ report: report() })).toMatchObject({
      kind: "missing",
      summary: "Not installed",
      detail: "Not found",
      actionLabel: "Install TinyTeX",
    });
  });

  it("points elsewhere when Scient cannot install on this computer", () => {
    expect(view({ report: report({ canInstallManaged: false }) })).toMatchObject({
      kind: "missing",
      actionLabel: null,
    });
  });

  it("shows progress, with nothing to press, while installing", () => {
    for (const input of [
      { report: report(), requesting: true },
      { report: report({ managedInstall: install("downloading") }) },
      { report: report({ managedInstall: install("installing-packages") }) },
    ]) {
      expect(view(input)).toMatchObject({ kind: "installing", actionLabel: null, busy: true });
    }
  });

  it("offers another try after a failed install", () => {
    expect(view({ report: report({ managedInstall: install("failed") }) })).toMatchObject({
      kind: "failed",
      actionLabel: "Try again",
    });
  });

  it("lets a status that could not be read be read again", () => {
    expect(view({ error: "Offline" })).toMatchObject({
      kind: "unreadable",
      detail: "Offline",
      actionLabel: "Check again",
    });
    expect(view({}).kind).toBe("checking");
  });
});
