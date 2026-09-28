import type {
  ConversationExportFormat,
  ConversationExportOptions,
  DocumentWarning,
  EnvironmentId,
  ScientConversationExportPreparation,
  ScientConversationExportRequest,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { ComponentType } from "react";

/**
 * Export formats the thread menu offers. Each registered format gets an
 * Export submenu entry that opens the dialog preset to it; the dialog itself
 * knows no format. The connected server decides whether a format can be
 * produced now. Registration order is menu order.
 */
export interface ConversationExportVariant {
  /** Accessible name of the choice. */
  readonly label: string;
  readonly choices: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    /** The primary button's label while this choice is selected. */
    readonly saveLabel: string;
  }>;
  readonly defaultValue: string;
  /** Whether the choice is offered for this conversation. */
  readonly isOffered: (preparation: ScientConversationExportPreparation) => boolean;
  readonly apply: (options: ConversationExportOptions, value: string) => ConversationExportOptions;
}

export interface ConversationExportFormatRegistration {
  readonly format: ConversationExportFormat;
  /** The format's name: the dialog is titled "Export as <label>". */
  readonly label: string;
  /** The entry in the thread menu's Export submenu. */
  readonly menuLabel: string;
  /** One or two sentences behind the dialog title's info button. */
  readonly about: string;
  /** The primary button's label, unless a variant choice names its own. */
  readonly saveLabel: string;
  readonly variant?: ConversationExportVariant;
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
  /**
   * Shown in place of the options while the format is unavailable, when the
   * user can make it available here (installing Pandoc for Word). `disabled`
   * is set while an export is running.
   */
  readonly UnavailableAction?: ComponentType<{
    readonly environmentId: EnvironmentId;
    readonly reason: string;
    readonly disabled: boolean;
    readonly onAvailable: () => void;
  }>;
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
