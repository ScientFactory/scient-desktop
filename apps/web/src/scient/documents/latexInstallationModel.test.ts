import type {
  ScientLatexManagedInstallState,
  ScientLatexToolchainReport,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canInstallAdditionalLatexTools, latexInstallationView } from "./latexInstallationModel";

function report(overrides: Partial<ScientLatexToolchainReport> = {}): ScientLatexToolchainReport {
  return {
    kind: null,
    executable: null,
    version: null,
    probedAtEpochMs: 1,
    canInstallManaged: true,
    compilers: [],
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
const complete = ["pdflatex", "xelatex", "lualatex"].map((compiler) => ({
  compiler: compiler as "pdflatex" | "xelatex" | "lualatex",
  available: true,
  executable: compiler,
  version: null,
}));

describe("LaTeX tools status and installation eligibility", () => {
  it("offers one install for fresh setup and an additional install for Tectonic or partial TeX", () => {
    expect(view({ report: report() })).toMatchObject({
      kind: "missing",
      actionTarget: "tools",
      actionLabel: expect.any(String),
      busy: false,
    });
    for (const existing of [
      report({ kind: "tectonic" }),
      report({ kind: "latexmk", compilers: complete.slice(0, 1) }),
      report({ compilers: complete.slice(0, 1) }),
    ]) {
      expect(view({ report: existing })).toMatchObject({
        actionTarget: "additional",
        actionLabel: expect.any(String),
        additionalDetail: expect.any(String),
      });
    }
  });

  it("does not invite redundant installation when all standalone engines are available", () => {
    const existing = report({ kind: "latexmk", compilers: complete });
    expect(canInstallAdditionalLatexTools(existing)).toBe(false);
    expect(view({ report: existing })).toMatchObject({
      kind: "ready",
      actionLabel: null,
      additionalDetail: null,
    });
  });

  it("offers no managed action on unsupported platforms", () => {
    for (const kind of [null, "tectonic"] as const) {
      expect(view({ report: report({ kind, canInstallManaged: false }) })).toMatchObject({
        actionLabel: null,
        busy: false,
      });
    }
  });

  it("keeps progress ahead of old failures and preserves existing PDF readiness", () => {
    for (const input of [
      { requesting: true, managedInstall: install("failed") },
      { requesting: false, managedInstall: install("downloading") },
      { requesting: false, managedInstall: install("installing-packages") },
    ]) {
      const result = view({
        requesting: input.requesting,
        report: report({ kind: "tectonic", managedInstall: input.managedInstall }),
      });
      expect(result).toMatchObject({
        kind: "installing",
        summary: "Ready",
        actionLabel: null,
        busy: true,
        actionTarget: "additional",
        additionalDetail: expect.any(String),
      });
      expect(result.detail).toContain("Tectonic");
    }
  });

  it("keeps optional installation failures visible without marking existing PDF tools missing", () => {
    for (const input of [
      { report: report({ kind: "tectonic", managedInstall: install("failed") }) },
      { report: report({ kind: "tectonic" }), installError: "Connection interrupted" },
    ]) {
      expect(view(input)).toMatchObject({
        kind: "failed",
        summary: "Ready",
        actionTarget: "additional",
        actionLabel: expect.any(String),
        additionalDetail: expect.any(String),
        busy: false,
      });
    }
    expect(view({ report: report({ managedInstall: install("failed") }) })).toMatchObject({
      kind: "failed",
      summary: "Not installed",
      actionTarget: "tools",
      actionLabel: expect.any(String),
    });
  });

  it("only advertises Unicode support provided by Tectonic or an available Unicode engine", () => {
    expect(
      view({ report: report({ kind: "latexmk", compilers: complete.slice(0, 1) }) }).detail,
    ).not.toContain("Unicode");
    expect(view({ report: report({ kind: "tectonic" }) }).detail).toContain("Unicode");
    expect(view({ report: report({ kind: "latexmk", compilers: complete }) }).detail).toContain(
      "Unicode",
    );
  });

  it("can retry a failed status check without confusing it with an install", () => {
    expect(view({ error: "Offline" })).toMatchObject({
      kind: "unreadable",
      detail: "Offline",
      actionTarget: "tools",
      busy: false,
    });
    expect(view({})).toMatchObject({ kind: "checking", actionLabel: null, busy: true });
  });
});
