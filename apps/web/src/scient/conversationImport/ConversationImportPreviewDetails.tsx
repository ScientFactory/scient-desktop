import type {
  ConversationImportOmission,
  ConversationImportWarning,
  ConversationSnapshotWarning,
  ScientConversationImportPreview,
} from "@t3tools/contracts";

import { pluralize, providerDisplayName } from "./importDialog.logic";

const SKIPPED_RECORD_NAMES = {
  activity: ["work log entry", "work log entries"],
  "question-answer": ["answered question", "answered questions"],
  context: ["context reference", "context references"],
} as const;

function snapshotWarningLabel(warning: ConversationSnapshotWarning): string {
  const messageLocation =
    "messageN" in warning && warning.messageN !== null ? ` in message ${warning.messageN}` : "";
  switch (warning._tag) {
    case "running-turn-omitted":
      return "A reply that was still being written was left out.";
    case "attachment-unavailable":
      return `Attachment “${warning.name}”${messageLocation} wasn't available.`;
    case "attachment-unsupported":
      return `Attachment “${warning.name}”${messageLocation} isn't supported.`;
    case "records-skipped": {
      const [one, many] = SKIPPED_RECORD_NAMES[warning.kind];
      return `${pluralize(warning.count, one, many)} couldn't be read and ${
        warning.count === 1 ? "was" : "were"
      } left out.`;
    }
  }
}

function omissionLabel(omission: ConversationImportOmission): string {
  switch (omission._tag) {
    case "work-log-excluded":
      return "The work log was left out when the file was made.";
    case "reasoning-excluded":
      return "Reasoning was left out when the file was made.";
    case "range-truncated":
      return `Messages after message ${omission.throughMessageN} were left out.`;
    case "snapshot-warning":
      return snapshotWarningLabel(omission.warning);
  }
}

function warningLabel(warning: ConversationImportWarning): string {
  switch (warning._tag) {
    case "export-warning":
      return warning.warning.message;
    case "newer-minor-version":
      return (
        "A newer version of Scient made this file. " +
        "Anything this version doesn't recognise was skipped."
      );
  }
}

/** Keys lines by their text; a repeated line is keyed by which repeat it is. */
function keyedLines(lines: ReadonlyArray<string>) {
  const seen = new Map<string, number>();
  return lines.map((text) => {
    const repeat = (seen.get(text) ?? 0) + 1;
    seen.set(text, repeat);
    return { key: `${repeat}:${text}`, text };
  });
}

const KIND_DESCRIPTION: Record<ScientConversationImportPreview["kind"], string> = {
  scic: "A Scient conversation file with its messages and included attachments.",
  markdown: "A Scient Markdown export: message text only. Files it mentions aren't included.",
  document: "A Markdown document. It's attached to a new conversation, not turned into messages.",
};

/** "12 messages · 2 attachments · from Codex · GPT-5"; null for a plain document. */
function previewSummary(
  preview: ScientConversationImportPreview,
  sourceModelName: string | null,
): string | null {
  if (preview.kind === "document") return null;
  const { messages, attachments } = preview.counts;
  const provider = preview.conversation.provider;
  return [
    pluralize(messages, "message", "messages"),
    attachments === 0 ? "no attachments" : pluralize(attachments, "attachment", "attachments"),
    provider ? `from ${providerDisplayName(provider)}` : null,
    sourceModelName,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Server validation facts only; no imported message body is rendered before confirmation. */
export function ConversationImportPreviewDetails({
  preview,
  sourceModelName = preview.conversation.model,
}: {
  readonly preview: ScientConversationImportPreview;
  /** The source model as the destination names it; defaults to the name in the file. */
  readonly sourceModelName?: string | null;
}) {
  const summary = previewSummary(preview, sourceModelName);
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">{preview.conversation.title}</p>
      <p>{KIND_DESCRIPTION[preview.kind]}</p>
      {summary !== null ? <p>{summary}</p> : null}
      <p className="text-muted-foreground">
        Scient can't confirm who made this file. Pending approvals, agent sessions and workspace
        files never transfer.
      </p>
      {preview.omissions.length > 0 ? (
        <section aria-label="Not included" className="rounded-md border p-3">
          <p className="font-medium">Not included</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {keyedLines(preview.omissions.map(omissionLabel)).map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {preview.warnings.length > 0 ? (
        <section aria-label="Notes from the file" className="rounded-md border p-3" role="alert">
          <p className="font-medium">Notes from the file</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {keyedLines(preview.warnings.map(warningLabel)).map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
