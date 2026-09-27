import {
  conversationPdfAvailability,
  exportConversationPdf,
} from "../documentExport/conversationPdfExport";
import { PandocInstallAction } from "../wordExport/PandocInstallControl";
import { registerConversationExportFormat } from "./formatRegistry";

/** Formats this build offers, in display order. */
registerConversationExportFormat({
  format: "markdown",
  label: "Markdown",
  supportsCopy: true,
  variant: {
    label: "Markdown",
    choices: [
      { value: "text", label: "Text only (.md)" },
      { value: "with-attachments", label: "With attachments (.zip)" },
    ],
    defaultValue: "text",
    isOffered: (preparation) => preparation.attachmentCount > 0,
    apply: (options, value) => ({
      ...options,
      markdownPackaging: value === "with-attachments" ? "with-attachments" : "text",
    }),
    copyable: (value) => value === "text",
  },
  note: (preparation) =>
    preparation.attachmentCount > 0
      ? "A text-only file lists attachments by name. The .zip keeps them next to the Markdown."
      : null,
});

registerConversationExportFormat({
  format: "pdf",
  label: "PDF",
  supportsCopy: false,
  clientAvailability: conversationPdfAvailability,
  produce: exportConversationPdf,
  note: () =>
    "Opens in Scient's PDF reader, where Save Copy keeps a copy. Images stay inside the PDF.",
});

registerConversationExportFormat({
  format: "scic",
  label: "Scient (.scic)",
  supportsCopy: false,
  note: () =>
    "Another Scient can import this file and continue the conversation in a fresh session.",
});

registerConversationExportFormat({
  format: "docx",
  label: "Word",
  supportsCopy: false,
  note: () =>
    "Equations stay editable in Word. Images, tables, and footnotes are kept; the work log and reasoning get their own Word styles.",
  UnavailableAction: PandocInstallAction,
});
