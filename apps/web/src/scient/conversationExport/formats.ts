import {
  conversationPdfAvailability,
  exportConversationPdf,
} from "../documentExport/conversationPdfExport";
import { msg } from "gt-react";

import { registerConversationExportFormat } from "./formatRegistry";
import { WordPandocRequirement } from "./WordPandocRequirement";

/** Formats this build offers, in menu order. Their texts are `msg()` strings, resolved where shown. */
registerConversationExportFormat({
  format: "markdown",
  label: "Markdown",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- format name and file extension
  menuLabel: "Markdown (.md)",
  about: msg(
    "Plain text that opens anywhere. With attachments, images and files are saved next to it in a .zip.",
  ),
  saveLabel: msg("Save .md"),
  variant: {
    label: msg("Attachments"),
    choices: [
      { value: "text", label: msg("Text only (.md)"), saveLabel: msg("Save .md") },
      {
        value: "with-attachments",
        label: msg("With attachments (.zip)"),
        saveLabel: msg("Save .zip"),
      },
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
  // oxlint-disable-next-line t3code/no-untranslated-copy -- format name and file extension
  menuLabel: "PDF (.pdf)",
  about: msg("A print-ready document with images, math and diagrams inside."),
  saveLabel: msg("Save PDF"),
  clientAvailability: conversationPdfAvailability,
  produce: exportConversationPdf,
});

registerConversationExportFormat({
  format: "docx",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
  label: "Word",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- format name and file extension
  menuLabel: "Word (.docx)",
  about: msg("Equations stay editable. Images, tables, footnotes and citations are kept."),
  saveLabel: msg("Save .docx"),
  UnavailableAction: WordPandocRequirement,
});

registerConversationExportFormat({
  format: "scic",
  label: msg("Scient file"),
  menuLabel: msg("Scient file (.scic)"),
  about: msg("Another Scient can open this file and continue the conversation."),
  saveLabel: msg("Save .scic"),
});
