import type {
  ConversationExportFormat,
  ConversationExportOptions,
  ScientConversationExportPreparation,
  ScientConversationExportRequest,
  ThreadId,
} from "@t3tools/contracts";

import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import type { ConversationExportFormatRegistration } from "./formatRegistry";

/** Shown briefly above the Include switch the user just enabled. */
/** A `msg()` string: resolve it where it shows. */
export const INCLUDE_CAUTION = msg("May include file paths, commands and their output.");
export const RUNNING_TURN_WARNING = msg("The current turn is still running; it will be left out.");
const UNAVAILABLE_REASON = msg("Not available on this Scient.");

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
  resolve: MessageResolver = m,
): ExportFormatAvailability {
  const registration = registrations.find((entry) => entry.format === format);
  const capability = preparation.formats.find((entry) => entry.format === format);
  if (registration === undefined || capability?.available !== true) {
    return {
      available: false,
      reason: capability?.unavailableReason ?? resolve(UNAVAILABLE_REASON),
    };
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

export function exportDialogWarnings(
  preparation: ScientConversationExportPreparation,
  resolve: MessageResolver = m,
): ReadonlyArray<string> {
  return preparation.runningTurnOmitted ? [resolve(RUNNING_TURN_WARNING)] : [];
}

/** The primary button's label for the current choices. */
export function exportSaveLabel(
  state: ExportDialogState,
  preparation: ScientConversationExportPreparation,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
  resolve: MessageResolver = m,
): string {
  const registration = selectedRegistration(state, registrations);
  const variant = offeredVariant(state, preparation, registrations);
  const value = state.variant ?? variant?.defaultValue;
  return resolve(
    variant?.choices.find((choice) => choice.value === value)?.saveLabel ??
      registration?.saveLabel ??
      msg("Save", { $context: "button that saves the exported file" }),
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
