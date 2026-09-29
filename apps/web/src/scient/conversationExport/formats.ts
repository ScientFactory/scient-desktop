import {
  conversationPdfAvailability,
  exportConversationPdf,
} from "../documentExport/conversationPdfExport";
import { registerConversationExportFormat } from "./formatRegistry";
import { WordPandocRequirement } from "./WordPandocRequirement";

/** Formats this build offers, in menu order. */
registerConversationExportFormat({
  format: "markdown",
  label: "Markdown",
  menuLabel: "Markdown (.md)",
  about:
    "Plain text that opens anywhere. With attachments, images and files are saved next to it in a .zip.",
  saveLabel: "Save .md",
  variant: {
    label: "Attachments",
    choices: [
      { value: "text", label: "Text only (.md)", saveLabel: "Save .md" },
      { value: "with-attachments", label: "With attachments (.zip)", saveLabel: "Save .zip" },
    ],
    defaultValue: "text",
    isOffered: (preparation) => preparation.attachmentCount > 0,
    apply: (options, value) => ({
      ...options,
      markdownPackaging: value === "with-attachments" ? "with-attachments" : "text",
    }),
  },
});

registerConversationExportFormat({
  format: "pdf",
  label: "PDF",
  menuLabel: "PDF (.pdf)",
  about: "A print-ready document with images, math and diagrams inside.",
  saveLabel: "Save PDF",
  clientAvailability: conversationPdfAvailability,
  produce: exportConversationPdf,
});

registerConversationExportFormat({
  format: "docx",
  label: "Word",
  menuLabel: "Word (.docx)",
  about: "Equations stay editable. Images, tables, footnotes and citations are kept.",
  saveLabel: "Save .docx",
  UnavailableAction: WordPandocRequirement,
});

registerConversationExportFormat({
  format: "scic",
  label: "Scient file",
  menuLabel: "Scient file (.scic)",
  about: "Another Scient can open this file and continue the conversation.",
  saveLabel: "Save .scic",
});
