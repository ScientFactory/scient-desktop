import {
  ConversationImportRejectionReason,
  SCIC_FILE_EXTENSION,
  SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
  ScientConversationImportError,
  ScientConversationImportErrorReason,
  type DesktopConversationFileUploadResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { resolveEnvironmentOptionLabel } from "../../components/BranchToolbar.logic";

/** Imports always start supervised: the history is unverified. */
export const IMPORT_RUNTIME_MODE = "approval-required";

/** The server's limit for a Markdown import (`MarkdownConversationReader`). */
const MARKDOWN_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * A failure whose message is already written for the person importing.
 * `terminal`: sending the same file again cannot succeed; it has to be opened again.
 */
export class ConversationImportNotice extends Error {
  constructor(
    message: string,
    readonly terminal = false,
  ) {
    super(message);
  }
}

/** Why a chosen file cannot be sent at all, or null when it can. */
export function importFileProblem(fileName: string, sizeBytes: number): string | null {
  const name = fileName.toLowerCase();
  const markdown = name.endsWith(".md");
  if (!markdown && !name.endsWith(SCIC_FILE_EXTENSION)) {
    return "Choose a Scient conversation file (.scic) or a Markdown file (.md).";
  }
  if (sizeBytes <= 0) return "This file is empty.";
  if (
    sizeBytes >
    (markdown ? MARKDOWN_IMPORT_MAX_BYTES : SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES)
  ) {
    return "This file is larger than Scient can import.";
  }
  return null;
}

export interface ImportEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Whether its connection is up now; a known environment keeps its config while it is down. */
  readonly connected: boolean;
}

/** Known environments by name, this device first. */
export function importEnvironmentOptions(input: {
  readonly environmentIds: Iterable<EnvironmentId>;
  readonly labels: ReadonlyMap<EnvironmentId, string>;
  readonly connected: ReadonlySet<EnvironmentId>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<ImportEnvironmentOption> {
  return [...input.environmentIds]
    .map((environmentId) => ({
      environmentId,
      label: resolveEnvironmentOptionLabel({
        isPrimary: environmentId === input.primaryEnvironmentId,
        environmentId,
        runtimeLabel: input.labels.get(environmentId) ?? null,
      }),
      connected: input.connected.has(environmentId),
    }))
    .toSorted(
      (left, right) =>
        Number(right.environmentId === input.primaryEnvironmentId) -
        Number(left.environmentId === input.primaryEnvironmentId),
    );
}

export const isConversationImportError = Schema.is(ScientConversationImportError);
const INTERNAL_CODES: ReadonlyArray<string> = [
  ...ScientConversationImportErrorReason.literals,
  ...ConversationImportRejectionReason.literals,
];
const PATH_LIKE = /[A-Za-z]:\\|\\\\|(?:^|[\s"'“‘(])\.{0,2}\/|\w\/\w|\w\\\w/u;

const FALLBACK_BY_REASON: Partial<Record<ScientConversationImportErrorReason, string>> = {
  "package-rejected": "This file can't be imported. It didn't pass Scient's checks.",
  "package-too-large": "This file is larger than Scient can import.",
  "staging-full": "Scient doesn't have room for this import right now. Try again later.",
  "import-not-found": "This import is no longer available. Open the file again.",
  cancelled: "This import was cancelled. Open the file again.",
  "project-not-found": "That project is no longer available. Choose another one.",
  "provider-unavailable": "No model is available right now. Connect a provider and try again.",
};

/** The server's own words when they are plain, never a code or a file path. */
function plainServerMessage(error: ScientConversationImportError): string | null {
  const message = error.message.trim();
  if (message.length === 0 || message.length > 300) return null;
  if (INTERNAL_CODES.some((code) => message.includes(code))) return null;
  if (error.rejection?.entry && message.includes(error.rejection.entry)) return null;
  return PATH_LIKE.test(message) ? null : message;
}

/** What to tell the person about a failed step, without internal detail. */
export function importFailureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ConversationImportNotice) return cause.message;
  if (isConversationImportError(cause)) {
    return plainServerMessage(cause) ?? FALLBACK_BY_REASON[cause.reason] ?? fallback;
  }
  return fallback;
}

/**
 * The check refused the file for holding more records than one import
 * writes. Sent before the check, `package-too-large` means its size instead.
 */
export function isRecordLimitRefusal(cause: unknown): boolean {
  return isConversationImportError(cause) && cause.reason === "package-too-large";
}

export function isMarkdownFileName(name: string): boolean {
  return /\.md$/iu.test(name);
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

/**
 * The desktop's answer to "send this opened file". Declining its "Send
 * conversation file?" prompt, or cancelling the upload, stops the import
 * without an error; everything else is worded plainly.
 */
export function desktopUploadOutcome(
  result: DesktopConversationFileUploadResult | undefined,
): { readonly _tag: "uploaded" } | { readonly _tag: "stopped" } | ConversationImportNotice {
  if (result === undefined) {
    return new ConversationImportNotice(
      "This Scient can't send opened files. Choose the file instead.",
    );
  }
  if (result._tag === "uploaded") return result;
  switch (result.reason) {
    case "declined":
    case "cancelled":
      return { _tag: "stopped" };
    case "rejected":
      return new ConversationImportNotice("The destination didn't accept the file. Try again.");
    case "file-unavailable":
    case "file-changed":
      return new ConversationImportNotice("Open the file again to import it.", true);
    case "invalid-url":
    case "network-failed":
      return new ConversationImportNotice(
        "The file couldn't be sent. Check the connection and try again.",
      );
  }
}
