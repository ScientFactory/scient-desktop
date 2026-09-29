import {
  ConversationImportRejectionReason,
  PROVIDER_DISPLAY_NAMES,
  SCIC_FILE_EXTENSION,
  SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
  ScientConversationImportError,
  ScientConversationImportErrorReason,
  isProviderDriverKind,
  type DesktopConversationFileUploadResult,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";

import { resolveEnvironmentOptionLabel } from "../../components/BranchToolbar.logic";
import { runtimeModeConfig } from "../../components/chat/runtimeModeConfig";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import { formatProviderDriverKindLabel } from "../../providerModels";

/** Imports always start supervised: the history is unverified. */
export const IMPORT_RUNTIME_MODE = "approval-required";

/** The server's limit for a Markdown import (`MarkdownConversationReader`). */
const MARKDOWN_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

/** A failure whose message is already written for the person importing. */
export class ConversationImportNotice extends Error {}

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

export interface ImportModelChoice {
  readonly key: string;
  readonly name: string;
  readonly selection: ModelSelection;
}

export interface ImportModelGroup {
  readonly label: string;
  readonly models: ReadonlyArray<ImportModelChoice>;
}

function importModelKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return `${selection.instanceId}/${selection.model}`;
}

/** The ready provider instances of an environment and their models. */
export function importModelGroups(
  config: ServerConfig | undefined,
): ReadonlyArray<ImportModelGroup> {
  if (config === undefined) return [];
  return deriveProviderInstanceEntries(config.providers)
    .filter(isProviderInstancePickerReady)
    .map((entry) => ({
      label: entry.displayName,
      models: entry.models.map((model) => {
        const selection = { instanceId: entry.instanceId, model: model.slug } as const;
        return { key: importModelKey(selection), name: model.name, selection };
      }),
    }))
    .filter((group) => group.models.length > 0);
}

type ImportProject = Pick<OrchestrationProjectShell, "id"> & LegacyProjectSettingsFields;

function projectSettings(config: ServerConfig, project: ImportProject) {
  return resolveProjectSettings(config.settings, project.id, project).settings;
}

/**
 * The model a new thread in `project` would start with: the project's
 * default, else the environment's, else the provider's own default. Null when
 * that model is not ready here; the person then chooses one.
 */
export function defaultImportModelKey(
  config: ServerConfig | undefined,
  project: ImportProject | null,
  groups: ReadonlyArray<ImportModelGroup>,
): string | null {
  if (config === undefined || project === null) return null;
  const selection = resolveDefaultProviderModelSelection(
    config.providers,
    projectSettings(config, project).defaultModelSelection,
  );
  if (selection === null) return null;
  const key = importModelKey(selection);
  return groups.some((group) => group.models.some((model) => model.key === key)) ? key : null;
}

/** A line saying imports start supervised, when new threads here would not. */
export function importRuntimeModeNote(
  config: ServerConfig | undefined,
  project: ImportProject | null,
): string | null {
  if (config === undefined || project === null) return null;
  if (projectSettings(config, project).defaultRuntimeMode === IMPORT_RUNTIME_MODE) return null;
  return `Imported conversations start in ${runtimeModeConfig[IMPORT_RUNTIME_MODE].label} mode, which asks before commands and file changes.`;
}

export function providerDisplayName(driver: string): string {
  if (!isProviderDriverKind(driver)) return driver;
  return PROVIDER_DISPLAY_NAMES[driver] ?? formatProviderDriverKindLabel(driver);
}

/** A source model's name as this environment's provider lists it, else as the file names it. */
export function modelDisplayName(
  config: ServerConfig | undefined,
  driver: string | null,
  slug: string,
): string {
  const providers = config?.providers ?? [];
  for (const provider of providers) {
    if (driver !== null && provider.driver !== driver) continue;
    const model = provider.models.find((candidate) => candidate.slug === slug);
    if (model) return model.name;
  }
  return slug;
}

/**
 * A selection's model name from every provider the environment knows, ready
 * or not; null when the environment does not list it.
 */
export function selectedModelName(
  config: ServerConfig | undefined,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string | null {
  const provider = config?.providers.find((entry) => entry.instanceId === selection.instanceId);
  return provider?.models.find((model) => model.slug === selection.model)?.name ?? null;
}

export function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
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
  "provider-unavailable": "That model isn't available right now. Choose another one.",
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
      return new ConversationImportNotice("Scient can no longer read this file. Open it again.");
    case "file-changed":
      return new ConversationImportNotice("The file changed after it was opened. Open it again.");
    case "invalid-url":
    case "network-failed":
      return new ConversationImportNotice(
        "The file couldn't be sent. Check the connection and try again.",
      );
  }
}
