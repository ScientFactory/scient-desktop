/**
 * What the Word export install control says, derived from the server's tool
 * status alone, so every surface that offers the install (Settings, the
 * conversation export dialog, the Markdown editor) says the same thing.
 */
import type {
  ScientPandocInstallFailureReason,
  ScientPandocInstallState,
  ScientPandocToolStatus,
} from "@t3tools/contracts";

export type PandocToolViewKind =
  | "loading"
  | "ready"
  | "offer"
  | "installing"
  | "failed"
  | "unavailable";

export interface PandocToolView {
  readonly kind: PandocToolViewKind;
  /** One line under the control. */
  readonly detail: string;
  /** `null` when there is nothing to press. */
  readonly actionLabel: string | null;
  readonly busy: boolean;
}

const ACTIVE_PHASES: ReadonlySet<ScientPandocInstallState["state"]> = new Set([
  "downloading",
  "verifying",
  "unpacking",
]);

export function isActivePandocInstall(status: ScientPandocToolStatus | null): boolean {
  return status !== null && ACTIVE_PHASES.has(status.install.state);
}

export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

const FAILURE_DETAIL: Record<ScientPandocInstallFailureReason, string> = {
  "unsupported-platform": "Pandoc has no build for this computer, so Word export cannot run here.",
  "download-failed": "Scient could not download Pandoc. Check the connection and try again.",
  "checksum-mismatch":
    "The Pandoc download did not match the release Scient pinned, so it was discarded. Try again.",
  "unpack-failed": "The downloaded Pandoc could not be unpacked or did not start. Try again.",
  "install-failed": "Scient could not finish installing Pandoc. Try again.",
};

function installingDetail(install: ScientPandocInstallState): string {
  switch (install.state) {
    case "downloading":
      return install.bytesReceived !== null && install.totalBytes !== null
        ? `Downloading Pandoc… ${formatMegabytes(install.bytesReceived)} of ${formatMegabytes(install.totalBytes)}`
        : "Downloading Pandoc…";
    case "verifying":
      return "Checking the download…";
    default:
      return "Unpacking Pandoc…";
  }
}

export function pandocToolView(input: {
  readonly status: ScientPandocToolStatus | null;
  /** This client asked for an install and has not been answered yet. */
  readonly requesting: boolean;
  /** Reading the status or asking for the install failed. */
  readonly error: string | null;
}): PandocToolView {
  const { status } = input;
  if (status === null) {
    return input.error !== null
      ? { kind: "failed", detail: input.error, actionLabel: "Try again", busy: false }
      : { kind: "loading", detail: "Checking Word export…", actionLabel: null, busy: true };
  }
  if (status.installed) {
    return {
      kind: "ready",
      detail: `Pandoc ${status.version} is installed. Word export is available.`,
      actionLabel: null,
      busy: false,
    };
  }
  if (!status.canInstall) {
    return {
      kind: "unavailable",
      detail: status.unavailableReason ?? "Word export is not available on this computer.",
      actionLabel: null,
      busy: false,
    };
  }
  if (input.requesting || isActivePandocInstall(status)) {
    return {
      kind: "installing",
      detail: installingDetail(status.install),
      actionLabel: null,
      busy: true,
    };
  }
  const size = status.downloadBytes === null ? "" : ` (${formatMegabytes(status.downloadBytes)})`;
  if (status.install.state === "failed" && status.install.failureReason !== null) {
    return {
      kind: "failed",
      detail: FAILURE_DETAIL[status.install.failureReason],
      actionLabel: "Try again",
      busy: false,
    };
  }
  if (input.error !== null) {
    return { kind: "failed", detail: input.error, actionLabel: "Try again", busy: false };
  }
  return {
    kind: "offer",
    detail: `Word export needs Pandoc${size}. Scient downloads the pinned release into its own folder; nothing is installed system-wide.`,
    actionLabel: `Install Pandoc${size}`,
    busy: false,
  };
}
