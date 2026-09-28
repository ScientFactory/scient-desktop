import type {
  ConversationExportFormat,
  ConversationExportOptions,
  ScientConversationExportPreparation,
  ScientConversationExportRequest,
  ThreadId,
} from "@t3tools/contracts";

import type { ConversationExportFormatRegistration } from "./formatRegistry";

/** Shown under the Include toggles while either is on. */
export const INCLUDE_CAUTION = "May include file paths, commands and their output.";
export const RUNNING_TURN_WARNING = "The current turn is still running; it will be left out.";
const UNAVAILABLE_REASON = "Not available on this Scient.";

/** Everything the user chooses. Built fresh for every dialog, so nothing carries over. */
export interface ExportDialogState {
  readonly format: ConversationExportFormat;
  readonly variant: string | null;
  readonly includeWorkLog: boolean;
  readonly includeReasoning: boolean;
}

export type ExportFormatAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** Whether this server, and this client, can produce the format now. */
export function exportFormatAvailability(
  format: ConversationExportFormat,
  preparation: ScientConversationExportPreparation,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
): ExportFormatAvailability {
  const registration = registrations.find((entry) => entry.format === format);
  const capability = preparation.formats.find((entry) => entry.format === format);
  if (registration === undefined || capability?.available !== true) {
    return { available: false, reason: capability?.unavailableReason ?? UNAVAILABLE_REASON };
  }
  return registration.clientAvailability?.() ?? { available: true };
}

/** The dialog's starting choices for a format: work log and reasoning off. */
export function initialExportDialogState(
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
  format: ConversationExportFormat,
): ExportDialogState {
  const registration = registrations.find((entry) => entry.format === format);
  return {
    format,
    variant: registration?.variant?.defaultValue ?? null,
    includeWorkLog: false,
    includeReasoning: false,
  };
}

function selectedRegistration(
  state: ExportDialogState,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
): ConversationExportFormatRegistration | null {
  return registrations.find((entry) => entry.format === state.format) ?? null;
}

/** The format-specific choice to show, if the conversation calls for one. */
export function offeredVariant(
  state: ExportDialogState,
  preparation: ScientConversationExportPreparation,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
) {
  const variant = selectedRegistration(state, registrations)?.variant;
  return variant && variant.isOffered(preparation) ? variant : null;
}

/** Whether the Include caution line shows. */
export function showsIncludeCaution(state: ExportDialogState): boolean {
  return state.includeWorkLog || state.includeReasoning;
}

export function exportDialogWarnings(
  preparation: ScientConversationExportPreparation,
): ReadonlyArray<string> {
  return preparation.runningTurnOmitted ? [RUNNING_TURN_WARNING] : [];
}

/** The primary button's label for the current choices. */
export function exportSaveLabel(
  state: ExportDialogState,
  preparation: ScientConversationExportPreparation,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
): string {
  const registration = selectedRegistration(state, registrations);
  const variant = offeredVariant(state, preparation, registrations);
  const value = state.variant ?? variant?.defaultValue;
  return (
    variant?.choices.find((choice) => choice.value === value)?.saveLabel ??
    registration?.saveLabel ??
    "Save"
  );
}

/** The export request for the choices. Exports always cover the whole conversation. */
export function buildExportRequest(input: {
  readonly threadId: ThreadId;
  readonly state: ExportDialogState;
  readonly preparation: ScientConversationExportPreparation;
  readonly registrations: ReadonlyArray<ConversationExportFormatRegistration>;
  readonly timeZone: string | null;
}): ScientConversationExportRequest {
  const { state } = input;
  let options: ConversationExportOptions = {
    includeWorkLog: state.includeWorkLog,
    includeReasoning: state.includeReasoning,
    range: { _tag: "whole" },
  };
  const variant = offeredVariant(state, input.preparation, input.registrations);
  if (variant) options = variant.apply(options, state.variant ?? variant.defaultValue);
  return {
    threadId: input.threadId,
    format: state.format,
    options,
    delivery: "file",
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  };
}

/**
 * Copy ▸ Conversation as Markdown: the whole conversation as text-only
 * Markdown, without the work log or reasoning.
 */
export function copyMarkdownRequest(
  threadId: ThreadId,
  timeZone: string | null,
): ScientConversationExportRequest {
  return {
    threadId,
    format: "markdown",
    options: {
      includeWorkLog: false,
      includeReasoning: false,
      range: { _tag: "whole" },
      markdownPackaging: "text",
    },
    delivery: "clipboard",
    ...(timeZone ? { timeZone } : {}),
  };
}
