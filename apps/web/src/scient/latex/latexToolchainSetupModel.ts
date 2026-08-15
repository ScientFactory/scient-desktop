/**
 * What the LaTeX setup card says, derived from state alone.
 *
 * The card is the whole answer to "I opened a .tex file and nothing built".
 * Every branch it can show — the offer, the progress, the failure, and the
 * plain instructions for a computer Scient cannot help — is decided here so
 * the component stays a rendering of one value.
 */
import type {
  ScientLatexManagedInstallFailureReason,
  ScientLatexManagedInstallState,
} from "@t3tools/contracts";

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
}

export const TINYTEX_DOWNLOAD_LABEL = "about 70 MB";

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

const OFFER_BODY = `Scient can install TinyTeX (${TINYTEX_DOWNLOAD_LABEL}), a small LaTeX distribution that lives with Scient. It needs no administrator access, and an existing TeX installation keeps precedence.`;

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

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function downloadBody(install: ScientLatexManagedInstallState): string {
  const { bytesReceived, totalBytes } = install;
  return bytesReceived === null || totalBytes === null || totalBytes <= 0
    ? "Downloading TinyTeX…"
    : `Downloading TinyTeX — ${formatMegabytes(bytesReceived)} of ${formatMegabytes(totalBytes)}.`;
}

export function latexInstallFailureMessage(
  reason: ScientLatexManagedInstallFailureReason | null,
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
      return "The download arrived but could not be unpacked.";
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
  return {
    ...latexSetupCardPhase(input),
    warning: input.install?.packagesWarning ?? null,
  };
}

function latexSetupCardPhase(input: LatexSetupCardInput): Omit<LatexSetupCardModel, "warning"> {
  if (!input.canInstallManaged) {
    return {
      kind: "instructions",
      title: "No LaTeX toolchain found",
      body: "Install TeX Live, MiKTeX, or Tectonic on this computer, then rebuild.",
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
  ): Omit<LatexSetupCardModel, "warning"> => ({
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
      // The engine is in place; the surface flips to the build flow as soon as
      // the next toolchain poll sees it. Unless the poll has already answered
      // and still finds nothing runnable — the server drops the probe cache
      // before it reports `ready`, so that answer is not going to change on
      // its own, and a card that spins forever is worse than one that says so.
      return input.toolchainMissing
        ? {
            kind: "offer",
            title: "TinyTeX is installed, but no engine answered",
            body: "The download finished and unpacked, but Scient still cannot run LaTeX from it — the files may be incomplete, or something on this computer may be blocking them. Installing again replaces the copy.",
            actionLabel: "Install again",
            busy: false,
            progressPercent: null,
          }
        : installing("TinyTeX is installed", "Preparing the first build…", 100);
    case "failed":
      return {
        kind: "failed",
        title: "TinyTeX could not be installed",
        body: latexInstallFailureMessage(install.failureReason),
        actionLabel: "Try again",
        busy: false,
        progressPercent: null,
      };
    default:
      return {
        kind: "offer",
        title: "No LaTeX toolchain found",
        body: OFFER_BODY,
        actionLabel: "Install TinyTeX",
        busy: false,
        progressPercent: null,
      };
  }
}
