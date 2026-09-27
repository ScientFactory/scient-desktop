import type {
  ConversationExportFormat,
  ConversationExportOptions,
  MessageId,
  ScientConversationExportDelivery,
  ScientConversationExportPreparation,
  ScientConversationExportRequest,
  ThreadId,
} from "@t3tools/contracts";

import type { ConversationExportFormatRegistration } from "./formatRegistry";

export const PRIVACY_WARNING =
  "Work log and reasoning can include file paths, command output, and secrets.";
export const RUNNING_TURN_WARNING = "The current turn is still running; it will be left out.";
const UNAVAILABLE_REASON = "Not available on this Scient.";

/** Everything the user chooses. Built fresh for every dialog, so nothing carries over. */
export interface ExportDialogState {
  readonly format: ConversationExportFormat | null;
  readonly variant: string | null;
  readonly includeWorkLog: boolean;
  readonly includeReasoning: boolean;
  readonly range: "whole" | "through-message";
  readonly throughMessageId: MessageId | null;
}

export interface ExportFormatOption {
  readonly registration: ConversationExportFormatRegistration;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

/** Registered formats, each marked with whether this server can produce it now. */
export function exportFormatOptions(
  preparation: ScientConversationExportPreparation,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
): ReadonlyArray<ExportFormatOption> {
  return registrations.map((registration) => {
    const capability = preparation.formats.find((entry) => entry.format === registration.format);
    if (capability?.available !== true) {
      return {
        registration,
        available: false,
        unavailableReason: capability?.unavailableReason ?? UNAVAILABLE_REASON,
      };
    }
    const client = registration.clientAvailability?.() ?? { available: true };
    return client.available
      ? { registration, available: true, unavailableReason: null }
      : { registration, available: false, unavailableReason: client.reason };
  });
}

export function initialExportDialogState(
  preparation: ScientConversationExportPreparation,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
): ExportDialogState {
  const first = exportFormatOptions(preparation, registrations).find((option) => option.available);
  return {
    format: first?.registration.format ?? null,
    variant: first?.registration.variant?.defaultValue ?? null,
    includeWorkLog: false,
    includeReasoning: false,
    range: "whole",
    throughMessageId: preparation.messages.at(-1)?.messageId ?? null,
  };
}

export function selectedRegistration(
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
  state: ExportDialogState,
  preparation: ScientConversationExportPreparation,
): ReadonlyArray<string> {
  return [
    ...(state.includeWorkLog || state.includeReasoning ? [PRIVACY_WARNING] : []),
    ...(preparation.runningTurnOmitted ? [RUNNING_TURN_WARNING] : []),
  ];
}

export function canCopyExport(
  state: ExportDialogState,
  preparation: ScientConversationExportPreparation,
  registrations: ReadonlyArray<ConversationExportFormatRegistration>,
): boolean {
  const registration = selectedRegistration(state, registrations);
  if (!registration?.supportsCopy) return false;
  const variant = offeredVariant(state, preparation, registrations);
  return variant === null || variant.copyable(state.variant ?? variant.defaultValue);
}

export function buildExportRequest(input: {
  readonly threadId: ThreadId;
  readonly state: ExportDialogState;
  readonly preparation: ScientConversationExportPreparation;
  readonly registrations: ReadonlyArray<ConversationExportFormatRegistration>;
  readonly delivery: ScientConversationExportDelivery;
  readonly timeZone: string | null;
}): ScientConversationExportRequest | null {
  const { state } = input;
  if (state.format === null) return null;
  if (state.range === "through-message" && state.throughMessageId === null) return null;
  let options: ConversationExportOptions = {
    includeWorkLog: state.includeWorkLog,
    includeReasoning: state.includeReasoning,
    range:
      state.range === "through-message" && state.throughMessageId !== null
        ? { _tag: "through-message", messageId: state.throughMessageId }
        : { _tag: "whole" },
  };
  const variant = offeredVariant(state, input.preparation, input.registrations);
  if (variant) {
    const value =
      input.delivery === "clipboard"
        ? variant.defaultValue
        : (state.variant ?? variant.defaultValue);
    options = variant.apply(options, value);
  }
  return {
    threadId: input.threadId,
    format: state.format,
    options,
    delivery: input.delivery,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  };
}

export function messageChoiceLabel(
  choice: ScientConversationExportPreparation["messages"][number],
): string {
  const speaker = choice.role === "user" ? "You" : "Assistant";
  return `${choice.n}. ${speaker}: ${choice.excerpt || "(no text)"}`;
}
