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
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export type PandocToolViewKind =
  | "loading"
  | "ready"
  | "offer"
  /** Pandoc was installed but could not be started; installing again replaces it. */
  | "reinstall"
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
  /**
   * The status could not be read, so whether Pandoc is installed is unknown;
   * a `failed` view without it is an install that did not finish.
   */
  readonly unchecked?: boolean;
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
  "unsupported-platform": msg(
    "Pandoc has no build for this computer, so Word export cannot run here.",
  ),
  "download-failed": msg("Scient could not download Pandoc. Check the connection and try again."),
  "checksum-mismatch": msg(
    "The Pandoc download did not match the release Scient pinned, so it was discarded. Try again.",
  ),
  "unpack-failed": msg("The downloaded Pandoc could not be unpacked or did not start. Try again."),
  "install-failed": msg("Scient could not finish installing Pandoc. Try again."),
};

function installingDetail(install: ScientPandocInstallState, resolve: MessageResolver): string {
  switch (install.state) {
    case "downloading":
      return install.bytesReceived !== null && install.totalBytes !== null
        ? resolve(
            msg("Downloading Pandoc… {received} of {total}", {
              received: formatMegabytes(install.bytesReceived),
              total: formatMegabytes(install.totalBytes),
            }),
          )
        : resolve(msg("Downloading Pandoc…"));
    case "verifying":
      return resolve(msg("Checking the download…"));
    default:
      return resolve(msg("Unpacking Pandoc…"));
  }
}

/** "Pandoc 3.11 · GPL-2.0-or-later", with the release's source when the server names it. */
export function pandocReleaseNotice(status: ScientPandocToolStatus | null): {
  readonly release: string;
  readonly label: string;
  readonly sourceUrl: string | null;
} | null {
  if (status === null) return null;
  const release = `Pandoc ${status.version}`;
  return {
    release,
    label: status.license === undefined ? release : `${release} · ${status.license}`,
    sourceUrl: status.sourceUrl ?? null,
  };
}

export function pandocToolView(input: {
  readonly status: ScientPandocToolStatus | null;
  /** This client asked for an install and has not been answered yet. */
  readonly requesting: boolean;
  /** Reading the status or asking for the install failed. */
  readonly error: string | null;
  /** The error came from reading the status, not from asking for the install. */
  readonly errorFromCheck?: boolean;
  readonly resolve?: MessageResolver;
}): PandocToolView {
  const { status } = input;
  const resolve = input.resolve ?? m;
  if (input.error !== null && (status === null || input.errorFromCheck === true)) {
    return {
      kind: "failed",
      detail: input.error,
      actionLabel: resolve(msg("Check again")),
      busy: false,
      unchecked: true,
    };
  }
  if (status === null) {
    return {
      kind: "loading",
      detail: resolve(msg("Checking Word export…")),
      actionLabel: null,
      busy: true,
    };
  }
  if (input.error !== null) {
    return {
      kind: "failed",
      detail: input.error,
      actionLabel: resolve(msg("Try again")),
      busy: false,
    };
  }
  if (status.installed) {
    return {
      kind: "ready",
      detail: resolve(
        msg("Pandoc {version} is installed. Word export is available.", {
          version: status.version,
        }),
      ),
      actionLabel: null,
      busy: false,
    };
  }
  if (!status.canInstall) {
    return {
      kind: "unavailable",
      detail:
        status.unavailableReason ?? resolve(msg("Word export is not available on this computer.")),
      actionLabel: null,
      busy: false,
    };
  }
  if (input.requesting || isActivePandocInstall(status)) {
    return {
      kind: "installing",
      detail: installingDetail(status.install, resolve),
      actionLabel: null,
      busy: true,
    };
  }
  const size = status.downloadBytes === null ? null : formatMegabytes(status.downloadBytes);
  if (status.install.state === "failed" && status.install.failureReason !== null) {
    return {
      kind: "failed",
      detail: resolve(FAILURE_DETAIL[status.install.failureReason]),
      actionLabel: resolve(msg("Try again")),
      busy: false,
    };
  }
  if (status.reinstallRequired === true) {
    return {
      kind: "reinstall",
      detail: resolve(msg("Pandoc could not be started. Reinstall it to export to Word.")),
      actionLabel:
        size === null
          ? resolve(msg("Reinstall Pandoc"))
          : resolve(msg("Reinstall Pandoc ({size})", { size })),
      busy: false,
    };
  }
  return {
    kind: "offer",
    detail:
      size === null
        ? resolve(
            msg(
              "Word export needs Pandoc. Scient downloads the pinned release into its own folder; nothing is installed system-wide.",
            ),
          )
        : resolve(
            msg(
              "Word export needs Pandoc ({size}). Scient downloads the pinned release into its own folder; nothing is installed system-wide.",
              { size },
            ),
          ),
    actionLabel:
      size === null
        ? resolve(msg("Install Pandoc"))
        : resolve(msg("Install Pandoc ({size})", { size })),
    busy: false,
  };
}

/** The Word tab's one-word state on Settings ▸ Documents. */
export function pandocToolSummary(view: PandocToolView, resolve: MessageResolver = m): string {
  switch (view.kind) {
    case "loading":
      return resolve(msg("Checking…"));
    case "ready":
      return resolve(msg("Ready", { $context: "Word export is ready" }));
    case "installing":
      return resolve(msg("Installing…"));
    case "reinstall":
      return resolve(msg("Not working"));
    case "unavailable":
      return resolve(msg("Unavailable"));
    case "failed":
      return view.unchecked === true ? resolve(msg("Not checked")) : resolve(msg("Not installed"));
    case "offer":
      return resolve(msg("Not installed"));
  }
}
