/**
 * Scient additions to V2's `historicalMessage` rendering and handoff policy choice.
 *
 * Imported and forked history carries items V2 portable handoffs drop: frozen
 * reasoning, imported or inherited tool activity, and native question answers.
 * Their text is inert history; items that still hold execution authority stay out.
 */
import type { OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isImportedActivity = Schema.is(
  Schema.Struct({
    kind: Schema.String,
    summary: Schema.String,
    tone: Schema.String,
    payload: Schema.Unknown,
  }),
);

/** Only canonical imported/forked history inherits Scient's retained-context policy. */
export function hasScientContextHistory(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
): boolean {
  const { thread } = projection;
  return (
    thread.historyOrigin === "v1_import" ||
    thread.historyOrigin === "conversation_import" ||
    thread.historyOrigin === "scient_fork" ||
    thread.conversationImport != null ||
    thread.forkLineage != null ||
    thread.conversationFork != null ||
    projection.contextTransfers.some(
      (transfer) =>
        transfer.targetThreadId === thread.id &&
        (transfer.type === "fork" || transfer.type === "merge_back"),
    )
  );
}

/** Grouping is optional; importer identities and exact frozen copies own inert text. */
function hasPortableArtifactOwner(item: OrchestrationV2TurnItem): boolean {
  return (
    item.historyTurnId !== undefined ||
    item.inheritedFrom !== undefined ||
    item.id.startsWith("migration:v1:history:") ||
    (item.id.startsWith("server:conversation-import:") && item.id.includes(":item:"))
  );
}

function hasArtifactExecutionAuthority(item: OrchestrationV2TurnItem): boolean {
  return (
    item.runId !== null ||
    item.nodeId !== null ||
    item.providerThreadId !== null ||
    item.providerTurnId !== null ||
    item.nativeItemRef !== null
  );
}

/** Attachment descriptors appended to a message's text; empty without attachments. */
export function historicalAttachmentReferences(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" | "assistant_message" }>,
): string {
  if ((item.attachments?.length ?? 0) > 0) {
    const references = item.attachments!.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      contentReattached: false,
      ...(attachment.type === "image" &&
      "source" in attachment &&
      attachment.source?.kind === "snap-shot"
        ? { capturedWindow: true }
        : {}),
    }));
    return `\nAttachment references (bytes not replayed): ${JSON.stringify(references)}`;
  }
  return "";
}

/** Text for the item kinds only Scient history carries, or null when it is not history. */
export function scientHistoricalItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "reasoning":
      // Imports and exact forks freeze visible text without retaining execution authority.
      if (hasArtifactExecutionAuthority(item) || !hasPortableArtifactOwner(item)) return null;
      return item.text;
    case "dynamic_tool":
      if (hasArtifactExecutionAuthority(item)) return null;
      if (hasPortableArtifactOwner(item) && isImportedActivity(item.input)) {
        return `${item.input.summary}\n${JSON.stringify(item.input.payload)}`;
      } else if (item.inheritedFrom?.runId != null) {
        return [
          `Tool: ${item.toolName}`,
          `Input: ${JSON.stringify(item.input)}`,
          `Output: ${typeof item.output === "string" ? item.output : JSON.stringify(item.output)}`,
        ].join("\n");
      } else return null;
    case "user_input_request": {
      // Message-mode replies already have an ordinary user message. A native
      // callback reply only exists on this durable item, and is inert history.
      const answer = item.questionAnswer;
      if (item.status !== "completed" || answer === undefined || item.responseMode === "message")
        return null;
      return [
        "Submitted answers to historical questions:",
        ...Object.entries(answer.answers).map(([id, value]) => {
          const question =
            answer.questionTextById?.[id] ??
            item.questions.find((candidate) => candidate.id === id)?.question ??
            id;
          const attachments = (answer.attachmentsByQuestionId[id] ?? []).map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            contentReattached: false,
          }));
          return [
            `Question: ${question}`,
            `Answer: ${typeof value === "string" ? value : JSON.stringify(value)}`,
            ...(attachments.length === 0
              ? []
              : [`Attachment references (bytes not replayed): ${JSON.stringify(attachments)}`]),
          ].join("\n");
        }),
      ].join("\n\n");
    }
    default:
      return null;
  }
}

/** Labels activity copied from an unfinished turn at a fork boundary. */
export function partialSnapshotText(item: OrchestrationV2TurnItem, text: string): string {
  if (
    item.runId === null &&
    item.inheritedFrom?.status === "running" &&
    item.type !== "user_message"
  )
    return `Partial snapshot of unfinished activity at the fork boundary; this is not a completed result.\n${text}`;
  return text;
}
