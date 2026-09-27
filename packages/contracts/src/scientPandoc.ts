import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DocumentWarning, ScientConversationExportFile } from "./scientConversationExport.ts";

/**
 * The managed Pandoc tool behind Word export, from a client's point of view.
 *
 * Scient never uses a Pandoc found on the computer: Word export runs only the
 * pinned release Scient downloads into its own state on first use. Clients
 * poll {@link ScientPandocToolStatus} while an install runs, and offer the
 * install from Settings and from Export ▸ Word.
 */

/** `downloading` is the only phase that carries progress. */
export const ScientPandocInstallPhase = Schema.Literals([
  "idle",
  "downloading",
  "verifying",
  "unpacking",
  "ready",
  "failed",
]);
export type ScientPandocInstallPhase = typeof ScientPandocInstallPhase.Type;

/** Why an install stopped. Clients turn these into their own copy. */
export const ScientPandocInstallFailureReason = Schema.Literals([
  "unsupported-platform",
  "download-failed",
  "checksum-mismatch",
  "unpack-failed",
  "install-failed",
]);
export type ScientPandocInstallFailureReason = typeof ScientPandocInstallFailureReason.Type;

export const ScientPandocInstallState = Schema.Struct({
  state: ScientPandocInstallPhase,
  bytesReceived: Schema.NullOr(Schema.Number),
  totalBytes: Schema.NullOr(Schema.Number),
  failureReason: Schema.NullOr(ScientPandocInstallFailureReason),
  updatedAtEpochMs: Schema.Number,
});
export type ScientPandocInstallState = typeof ScientPandocInstallState.Type;

export const ScientPandocToolStatus = Schema.Struct({
  /** The pinned release this server installs and runs. */
  version: Schema.String,
  /** The pinned release is installed and answered its `--version` check. */
  installed: Schema.Boolean,
  /** Scient has a pinned build for this server's platform and architecture. */
  canInstall: Schema.Boolean,
  /** Why Word export cannot run on this server at all; null when it can. */
  unavailableReason: Schema.NullOr(Schema.String),
  /** Size of the download an install fetches, for the install prompt. */
  downloadBytes: Schema.NullOr(Schema.Number),
  install: ScientPandocInstallState,
});
export type ScientPandocToolStatus = typeof ScientPandocToolStatus.Type;

// ---------------------------------------------------------------------------
// Project Markdown file → Word
// ---------------------------------------------------------------------------

/**
 * Export a saved project Markdown file to Word. `revision` is the saved
 * revision the editor shows; the server refuses when the file on disk has
 * moved on, so the Word file is never made from text the user did not see.
 */
export const ScientWordFileExportRequest = Schema.Struct({
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  revision: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ScientWordFileExportRequest = typeof ScientWordFileExportRequest.Type;

export const ScientWordFileExportResult = Schema.Struct({
  file: ScientConversationExportFile,
  warnings: Schema.Array(DocumentWarning),
});
export type ScientWordFileExportResult = typeof ScientWordFileExportResult.Type;

export const ScientWordExportErrorReason = Schema.Literals([
  /** Pandoc is not installed, or has no build for this server's platform. */
  "unavailable",
  "not-markdown",
  "file-unreadable",
  /** The file on disk is not the revision the editor showed. */
  "file-changed",
  "too-large",
  "conversion-failed",
]);
export type ScientWordExportErrorReason = typeof ScientWordExportErrorReason.Type;

export class ScientWordExportError extends Schema.TaggedError<ScientWordExportError>()(
  "ScientWordExportError",
  {
    reason: ScientWordExportErrorReason,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientWordExportError)(this, { status: 409 });
  }
}
