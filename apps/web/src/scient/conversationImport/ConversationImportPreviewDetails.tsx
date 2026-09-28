import type {
  ConversationImportOmission,
  ConversationImportWarning,
  ConversationSnapshotWarning,
  ScientConversationImportPreview,
} from "@t3tools/contracts";

function snapshotWarningLabel(warning: ConversationSnapshotWarning): string {
  const messageLocation =
    "messageN" in warning && warning.messageN !== null ? ` in message ${warning.messageN}` : "";
  switch (warning._tag) {
    case "running-turn-omitted":
      return "A turn still running at export was left out.";
    case "attachment-unavailable":
      return `Attachment “${warning.name}”${messageLocation} was unavailable.`;
    case "attachment-unsupported":
      return `Attachment “${warning.name}”${messageLocation} was unsupported.`;
    case "records-skipped":
      return `${warning.count} ${warning.kind} ${
        warning.count === 1 ? "record was" : "records were"
      } skipped.`;
  }
}

export function omissionLabel(omission: ConversationImportOmission): string {
  switch (omission._tag) {
    case "work-log-excluded":
      return "The sender excluded the work log.";
    case "reasoning-excluded":
      return "The sender excluded reasoning.";
    case "range-truncated":
      return `Messages after message ${omission.throughMessageN} were left out.`;
    case "snapshot-warning":
      return snapshotWarningLabel(omission.warning);
  }
}

export function warningLabel(warning: ConversationImportWarning): string {
  switch (warning._tag) {
    case "export-warning":
      return warning.warning.message;
    case "newer-minor-version":
      return (
        `This file uses format version ${warning.formatVersion.major}.${warning.formatVersion.minor}; ` +
        "fields unknown to this Scient version were ignored."
      );
  }
}

/** Server validation facts only; no imported message body is rendered before confirmation. */
export function ConversationImportPreviewDetails({
  preview,
}: {
  readonly preview: ScientConversationImportPreview;
}) {
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">{preview.conversation.title}</p>
      <p>
        {preview.kind === "scic"
          ? "Scient conversation file: structured conversation and included attachments."
          : preview.kind === "markdown"
            ? "Scient Markdown transcript: message text only; referenced files do not transfer."
            : "Ordinary Markdown: starts a conversation with the document attached, not a reconstructed transcript."}
      </p>
      <p>
        {preview.counts.messages} messages · {preview.counts.attachments} attachments
        {preview.conversation.provider ? ` · from ${preview.conversation.provider}` : ""}
        {preview.conversation.model ? ` · ${preview.conversation.model}` : ""}
      </p>
      <p className="text-muted-foreground">
        The sender's identity is not verified. Pending actions, provider sessions and workspace
        files do not transfer.
      </p>
      {preview.omissions.length > 0 ? (
        <section aria-label="Content not included" className="rounded-md border p-3">
          <p className="font-medium">Content not included</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {preview.omissions.map((omission, index) => (
              <li key={index}>{omissionLabel(omission)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {preview.warnings.length > 0 ? (
        <section aria-label="Import warnings" className="rounded-md border p-3" role="alert">
          <p className="font-medium">Import warnings</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {preview.warnings.map((warning, index) => (
              <li key={index}>{warningLabel(warning)}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
