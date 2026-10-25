import type {
  ScientLatexManagedInstallFailureReason,
  ScientLatexManagedInstallFailureStep,
  ScientLatexManagedInstallState,
  ScientLatexUnusableToolchain,
} from "@t3tools/contracts";
import type { LatexDocumentCompiler } from "./latexCompiler";

export type LatexSetupCardKind = "offer" | "installing" | "failed" | "instructions";

export interface LatexSetupCardModel {
  readonly kind: LatexSetupCardKind;
  readonly title: string;
  readonly body: string;
  /** `null` when the card has nothing to press. */
  readonly actionLabel: string | null;
  readonly busy: boolean;
  /** `null` outside an install; otherwise 0–100 for the progress bar. */
  readonly progressPercent: number | null;
  /**
   * A note beside a finished install, not a failure: the engine works and the
   * packages it did not preinstall arrive on first use.
   */
  readonly warning: string | null;
  /**
   * What went wrong, in the tool's own words: a `latexmk` that exists but did
   * not run, or the line an install failure left. `null` when there is none.
   */
  readonly detail: string | null;
}

export interface LatexSetupCardInput {
  readonly canInstallManaged: boolean;
  readonly install: ScientLatexManagedInstallState | null;
  /** This client asked for an install and has not been answered yet. */
  readonly requesting: boolean;
  /**
   * The toolchain probe still reports no engine. A finished install that
   * leaves this true installed something this computer cannot run, which is a
   * different card from one still waiting for the next poll.
   */
  readonly toolchainMissing: boolean;
  readonly downloadBytes?: number | null;
  /** A declared compiler that the current toolchain cannot run. */
  readonly requiredCompiler?: LatexDocumentCompiler | null;
  /** A driver this computer has that did not run, when none did. */
  readonly unusableToolchain?: ScientLatexUnusableToolchain | null;
}

const ACTIVE_INSTALL_PHASES: ReadonlySet<ScientLatexManagedInstallState["state"]> = new Set([
  "downloading",
  "verifying",
  "unpacking",
  "installing-packages",
]);

/** The phases with work still to watch; `ready` and `failed` are done. */
export function isActiveLatexInstall(install: ScientLatexManagedInstallState | null): boolean {
  return install !== null && ACTIVE_INSTALL_PHASES.has(install.state);
}

/**
 * The download is most of the wait, so it owns most of the bar; the two short
 * phases after it move the bar rather than leaving it parked at the same
 * number while the label changes.
 */
const VERIFYING_PERCENT = 90;
const UNPACKING_PERCENT = 93;
/** The packages are a real download of their own, so they own real bar. */
const INSTALLING_PACKAGES_PERCENT = 97;
const DOWNLOAD_MAX_PERCENT = 85;
const DOWNLOAD_MIN_PERCENT = 4;

function downloadPercent(install: ScientLatexManagedInstallState): number {
  const { bytesReceived, totalBytes } = install;
  if (bytesReceived === null || totalBytes === null || totalBytes <= 0) {
    return DOWNLOAD_MIN_PERCENT;
  }
  const fraction = Math.round((bytesReceived / totalBytes) * DOWNLOAD_MAX_PERCENT);
  return Math.min(DOWNLOAD_MAX_PERCENT, Math.max(DOWNLOAD_MIN_PERCENT, fraction));
}

export function formatLatexDownloadSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function downloadBody(install: ScientLatexManagedInstallState): string {
  const { bytesReceived, totalBytes } = install;
  return bytesReceived === null || totalBytes === null || totalBytes <= 0
    ? "Downloading TinyTeX…"
    : `Downloading TinyTeX: ${formatLatexDownloadSize(bytesReceived)} of ${formatLatexDownloadSize(totalBytes)}.`;
}

function latexInstallFailureMessage(
  reason: ScientLatexManagedInstallFailureReason | null,
  step: ScientLatexManagedInstallFailureStep | undefined,
): string {
  switch (reason) {
    case "unsupported-platform":
      return "Scient does not have a LaTeX distribution for this computer yet.";
    case "unsupported-archive":
      return "Scient could not read the LaTeX download on this computer.";
    case "download-failed":
      return "The download did not finish. Check the connection and try again.";
    case "checksum-mismatch":
      return "The download did not match what Scient expected, so it was discarded.";
    case "unpack-failed":
      switch (step) {
        case "engine-missing":
          return "The download was unpacked, but the LaTeX engine was not in it.";
        case "engine-failed":
          return "The download was unpacked, but its LaTeX engine would not start.";
        case "extract":
        case undefined:
          return "The download arrived but could not be unpacked.";
      }
    case "install-failed":
    case null:
      return "The installation could not be finished.";
  }
}

/**
 * The card, plus the one thing it says that does not come from the phase: an
 * install that finished without its packages is still a finished install, so
 * the note rides along beside whatever the phase already decided.
 */
export function latexSetupCardModel(input: LatexSetupCardInput): LatexSetupCardModel {
  const phase = latexSetupCardPhase(input);
  return {
    ...phase,
    warning: input.install?.packagesWarning ?? null,
    detail: latexSetupCardDetail(input, phase.kind),
  };
}

function latexSetupCardDetail(input: LatexSetupCardInput, kind: LatexSetupCardKind): string | null {
  if (kind === "failed") {
    const detail = input.install?.failureDetail;
    return detail === undefined || detail === "" ? null : `Details: ${detail}`;
  }
  const unusable = input.unusableToolchain ?? null;
  if (unusable === null || !input.toolchainMissing || (input.requiredCompiler ?? null) !== null) {
    return null;
  }
  // Only beside the offer or the instructions: during or after an install the
  // distribution this names is no longer the question.
  return kind === "installing" || input.install?.state === "ready"
    ? null
    : `Scient found ${unusable.executable}, but it did not run: ${unusable.reason}`;
}

function latexSetupCardPhase(
  input: LatexSetupCardInput,
): Omit<LatexSetupCardModel, "warning" | "detail"> {
  const requiredCompiler = input.requiredCompiler ?? null;
  if (requiredCompiler === "tectonic") {
    return {
      kind: "instructions",
      title: "This document needs Tectonic",
      body: "Install Tectonic in this environment, then rebuild. TinyTeX does not provide Tectonic.",
      actionLabel: null,
      busy: false,
      progressPercent: null,
    };
  }
  const compilerName =
    requiredCompiler === null
      ? null
      : { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX" }[requiredCompiler];
  const size =
    input.downloadBytes == null
      ? ""
      : ` Base download: ${formatLatexDownloadSize(input.downloadBytes)}.`;
  const offerBody = `One optional TinyTeX installation provides pdfLaTeX, XeLaTeX, and LuaLaTeX.${size} Additional LaTeX packages may be downloaded during setup or a document build. Nothing downloads until you choose Install.`;
  if (!input.canInstallManaged) {
    return {
      kind: "instructions",
      title:
        compilerName === null
          ? "LaTeX tools are not installed"
          : `This document needs ${compilerName}`,
      body:
        compilerName === null
          ? "Install TeX Live, MiKTeX, or Tectonic on this computer, then rebuild."
          : `Install a TeX distribution with ${compilerName} on this computer, then rebuild. The document's compiler will not be changed.`,
      actionLabel: null,
      busy: false,
      progressPercent: null,
    };
  }

  const install = input.install;
  const installing = (
    title: string,
    body: string,
    progressPercent: number,
  ): Omit<LatexSetupCardModel, "warning" | "detail"> => ({
    kind: "installing",
    title,
    body,
    actionLabel: null,
    busy: true,
    progressPercent,
  });

  // A retry is progress the moment it is asked for: the server's last state is
  // still the old failure, and showing that back would read as a dead button.
  if (input.requesting) return installing("Installing TinyTeX", "Starting the download…", 2);

  switch (install?.state) {
    case "downloading":
      return installing("Installing TinyTeX", downloadBody(install), downloadPercent(install));
    case "verifying":
      return installing("Installing TinyTeX", "Checking the download…", VERIFYING_PERCENT);
    case "unpacking":
      return installing("Installing TinyTeX", "Unpacking the distribution…", UNPACKING_PERCENT);
    case "installing-packages":
      return installing(
        "Installing TinyTeX",
        "Installing common LaTeX packages…",
        INSTALLING_PACKAGES_PERCENT,
      );
    case "ready":
      // After ready, a fresh toolchain poll finding no runnable engine will not fix itself: the
      // server already invalidated its probe cache. Report that state instead of spinning
      // indefinitely.
      return input.toolchainMissing || requiredCompiler !== null
        ? {
            kind: "offer",
            title:
              compilerName === null
                ? "TinyTeX is installed, but no engine answered"
                : `${compilerName} is still unavailable`,
            body: "The installation finished, but the required compiler still cannot run. Review the installation details or install again. The document's compiler has not been changed.",
            actionLabel: "Install again",
            busy: false,
            progressPercent: null,
          }
        : installing("TinyTeX is installed", "Preparing the first build…", 100);
    case "failed":
      return {
        kind: "failed",
        title: "TinyTeX could not be installed",
        body: latexInstallFailureMessage(install.failureReason, install.failureStep),
        actionLabel: "Try again",
        busy: false,
        progressPercent: null,
      };
    default:
      return {
        kind: "offer",
        title:
          compilerName === null
            ? "LaTeX tools are not installed"
            : `This document needs ${compilerName}`,
        body: offerBody,
        actionLabel: "Install LaTeX tools",
        busy: false,
        progressPercent: null,
      };
  }
}
