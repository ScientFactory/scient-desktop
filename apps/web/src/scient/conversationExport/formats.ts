import { PandocInstallAction } from "../wordExport/PandocInstallControl";
import { registerConversationExportFormat } from "./formatRegistry";

/** Formats this build offers. Later formats (PDF, Word, `.scic`) register here. */
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
  format: "docx",
  label: "Word",
  supportsCopy: false,
  note: () =>
    "Equations stay editable in Word. Images, tables, and footnotes are kept; the work log and reasoning get their own Word styles.",
  UnavailableAction: PandocInstallAction,
});
