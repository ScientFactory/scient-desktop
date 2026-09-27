import type {
  ConversationExportFormat,
  ConversationExportOptions,
  EnvironmentId,
  ScientConversationExportPreparation,
} from "@t3tools/contracts";
import type { ComponentType } from "react";

/**
 * Export formats the dialog offers. A format appears once it registers here
 * and the connected server advertises it; the dialog itself knows no format.
 * Registration order is display order.
 */
export interface ConversationExportVariant {
  readonly label: string;
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly defaultValue: string;
  /** Whether the choice is offered for this conversation. */
  readonly isOffered: (preparation: ScientConversationExportPreparation) => boolean;
  readonly apply: (options: ConversationExportOptions, value: string) => ConversationExportOptions;
  /** Whether the chosen value can be copied to the clipboard. */
  readonly copyable: (value: string) => boolean;
}

export interface ConversationExportFormatRegistration {
  readonly format: ConversationExportFormat;
  readonly label: string;
  /** Offers Copy next to Export. */
  readonly supportsCopy: boolean;
  readonly variant?: ConversationExportVariant;
  /** A one-line note shown while the format is selected. */
  readonly note?: (preparation: ScientConversationExportPreparation) => string | null;
  /**
   * Shown in place of the unavailable reason when the user can make the format
   * available from the dialog (for Word, by installing Pandoc). Calls
   * `onAvailable` once the environment can produce the format.
   */
  readonly UnavailableAction?: ComponentType<{
    readonly environmentId: EnvironmentId;
    readonly onAvailable: () => void;
  }>;
}

const registrations: ConversationExportFormatRegistration[] = [];

export function registerConversationExportFormat(
  registration: ConversationExportFormatRegistration,
): void {
  const index = registrations.findIndex((entry) => entry.format === registration.format);
  if (index >= 0) registrations[index] = registration;
  else registrations.push(registration);
}

export function registeredConversationExportFormats(): ReadonlyArray<ConversationExportFormatRegistration> {
  return registrations;
}
