import type { ScientLatexToolchainReport } from "@t3tools/contracts";

import { isActiveLatexInstall, latexSetupCardModel } from "../latex/latexToolchainSetupModel";

/** The one line Settings ▸ Documents ▸ LaTeX shows about the engine on this server. */
export interface LatexInstallationView {
  readonly kind: "checking" | "ready" | "missing" | "installing" | "failed" | "unreadable";
  /** Strip detail under the LaTeX tab. */
  readonly summary: string;
  readonly detail: string;
  readonly actionLabel: string | null;
  readonly busy: boolean;
}

const ENGINE_LABELS = { latexmk: "latexmk", tectonic: "Tectonic" } as const;

export function latexInstallationView(input: {
  readonly report: ScientLatexToolchainReport | null;
  readonly requesting: boolean;
  readonly error: string | null;
}): LatexInstallationView {
  const { report, requesting, error } = input;
  if (error !== null) {
    return {
      kind: "unreadable",
      summary: "Not checked",
      detail: error,
      actionLabel: "Check again",
      busy: false,
    };
  }
  if (report === null) {
    return {
      kind: "checking",
      summary: "Checking…",
      detail: "Checking…",
      actionLabel: null,
      busy: true,
    };
  }
  const install = report.managedInstall ?? null;
  if (report.kind !== null && !requesting && !isActiveLatexInstall(install)) {
    const engine = [ENGINE_LABELS[report.kind], report.version].filter(Boolean).join(" ");
    const origin =
      report.source === "scient-managed" ? "TinyTeX, installed by Scient" : "This computer";
    return {
      kind: "ready",
      summary: "Installed",
      detail: `${engine} · ${origin}`,
      actionLabel: null,
      busy: false,
    };
  }
  const card = latexSetupCardModel({
    canInstallManaged: report.canInstallManaged,
    install,
    requesting,
    toolchainMissing: report.kind === null,
  });
  switch (card.kind) {
    case "installing":
      return {
        kind: "installing",
        summary: "Installing…",
        detail: card.body,
        actionLabel: null,
        busy: true,
      };
    case "failed":
      return {
        kind: "failed",
        summary: "Not installed",
        detail: card.body,
        actionLabel: card.actionLabel,
        busy: false,
      };
    case "instructions":
      return {
        kind: "missing",
        summary: "Not installed",
        detail: "Not found. Install TeX Live, MiKTeX, or Tectonic.",
        actionLabel: null,
        busy: false,
      };
    case "offer":
      return {
        kind: "missing",
        summary: "Not installed",
        detail: install?.state === "ready" ? card.title : "Not found",
        actionLabel: card.actionLabel,
        busy: false,
      };
  }
}
