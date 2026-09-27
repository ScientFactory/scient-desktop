import type {
  ConversationExportFormat,
  ConversationExportOptions,
  DocumentWarning,
  ScientConversationExportPreparation,
  ScientConversationExportRequest,
  ScopedThreadRef,
} from "@t3tools/contracts";

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
   * Whether this client can produce the format, beyond the server's own
   * capability. PDF, for example, needs a current Scient desktop.
   */
  readonly clientAvailability?: () => ConversationExportClientAvailability;
  /**
   * Produces the export on this client instead of through the server's export
   * request, and presents the result itself.
   */
  readonly produce?: (input: {
    readonly threadRef: ScopedThreadRef;
    readonly request: ScientConversationExportRequest;
  }) => Promise<ConversationExportProduced>;
}

export type ConversationExportClientAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface ConversationExportProduced {
  readonly title: string;
  readonly warnings: ReadonlyArray<DocumentWarning>;
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
