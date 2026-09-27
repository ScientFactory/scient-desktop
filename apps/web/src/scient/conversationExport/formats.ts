import {
  conversationPdfAvailability,
  exportConversationPdf,
} from "../documentExport/conversationPdfExport";
import { registerConversationExportFormat } from "./formatRegistry";

/** Formats this build offers. Later formats (Word, `.scic`) register here. */
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
