import type { ScientLatexToolchainReport } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { isActiveLatexInstall, latexSetupCardModel } from "../latex/latexToolchainSetupModel";

export interface LatexInstallationView {
  readonly kind: "checking" | "ready" | "missing" | "installing" | "failed" | "unreadable";
  readonly summary: string;
  readonly detail: string;
  readonly additionalDetail: string | null;
  readonly actionTarget: "tools" | "additional";
  readonly actionLabel: string | null;
  readonly busy: boolean;
}

/** The managed bundle adds standalone engines, even when Tectonic already builds PDFs. */
export function canInstallAdditionalLatexTools(report: ScientLatexToolchainReport): boolean {
  return (
    report.canInstallManaged &&
    !["pdflatex", "xelatex", "lualatex"].every((compiler) =>
      report.compilers.some((entry) => entry.compiler === compiler && entry.available),
    )
  );
}

export function latexInstallationView(
  input: {
    readonly report: ScientLatexToolchainReport | null;
    readonly requesting: boolean;
    readonly error: string | null;
    readonly installError?: string | null;
  },
  resolve: MessageResolver = m,
): LatexInstallationView {
  const { report, requesting, error, installError = null } = input;
  if (error !== null || report === null) {
    return {
      kind: error === null ? "checking" : "unreadable",
      summary: error === null ? resolve(msg("Checking…")) : resolve(msg("Not checked")),
      detail: error ?? resolve(msg("Checking LaTeX tools on this server…")),
      additionalDetail: null,
      actionTarget: "tools",
      actionLabel: error === null ? null : resolve(msg("Check again")),
      busy: error === null,
    };
  }

  const ready = report.kind !== null;
  const hasTools = ready || report.compilers.some((entry) => entry.available);
  const identity =
    report.source === "scient-managed"
      ? resolve(msg("TinyTeX, installed by Scient."))
      : report.kind === "tectonic"
        ? "Tectonic."
        : resolve(msg("System TeX."));
  const unicode =
    report.kind === "tectonic" ||
    report.compilers.some(
      (entry) => entry.available && (entry.compiler === "xelatex" || entry.compiler === "lualatex"),
    );
  const toolsDetail = hasTools
    ? [
        identity,
        ...(unicode ? [resolve(msg("Supports Hebrew and Unicode documents."))] : []),
        ...(!ready ? [resolve(msg("No PDF build driver is available."))] : []),
      ].join(" ")
    : resolve(msg("No LaTeX tools were found on this server."));
  const canInstall = canInstallAdditionalLatexTools(report);
  const install = report.managedInstall ?? null;
  const active = requesting || isActiveLatexInstall(install);
  const failed = !active && (installError !== null || install?.state === "failed");
  const incomplete = !["pdflatex", "xelatex", "lualatex"].every((compiler) =>
    report.compilers.some((entry) => entry.compiler === compiler && entry.available),
  );
  const additional = hasTools && (incomplete || active || failed);
  const offer = report.canInstallManaged
    ? resolve(msg("TinyTeX adds pdfLaTeX, XeLaTeX, and LuaLaTeX as one bundle."))
    : resolve(
        msg(
          "Automatic installation is unavailable on this platform. Install TeX Live or MiKTeX manually, then check again.",
        ),
      );
  const card =
    active || failed
      ? latexSetupCardModel(
          {
            canInstallManaged: report.canInstallManaged || active,
            install,
            requesting,
            toolchainMissing: !ready,
          },
          resolve,
        )
      : null;
  const installDetail = active
    ? card!.body
    : failed
      ? [
          resolve(msg("TinyTeX installation failed.")),
          installError ?? card!.body,
          ...(ready ? [resolve(msg("Existing PDF tools remain available."))] : []),
        ].join(" ")
      : offer;

  return {
    kind: active ? "installing" : failed ? "failed" : ready ? "ready" : "missing",
    summary: ready
      ? resolve(msg("Ready", { $context: "LaTeX tools are installed" }))
      : active
        ? resolve(msg("Installing…"))
        : resolve(msg("Not installed")),
    detail: hasTools ? toolsDetail : installDetail,
    additionalDetail: additional ? installDetail : null,
    actionTarget: additional ? "additional" : "tools",
    actionLabel:
      active || !canInstall
        ? null
        : failed
          ? resolve(msg("Try again"))
          : hasTools
            ? resolve(msg("Install additional compilers…"))
            : resolve(msg("Install LaTeX tools…")),
    busy: active,
  };
}
