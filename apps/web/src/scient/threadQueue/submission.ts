import { sha256 } from "@noble/hashes/sha2";
import { randomUUID } from "../../lib/utils";
import * as Schema from "effect/Schema";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  CommandId,
  MessageId,
  PlanId,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  ChatAttachment,
  UploadChatAttachment,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import { updateExtractedIntent, type ExtractedIntentRecord } from "./editJournal";
import type { ComposerThreadDraftState } from "../../composerDraftStore";

export function composerSubmissionMatchesDraft(
  submitted: ComposerThreadDraftState | null | undefined,
  current: ComposerThreadDraftState | null | undefined,
) {
  if (submitted === current) return true;
  if (!submitted || !current || submitted.prompt !== current.prompt) return false;
  const attachmentsMatch = (
    before: ComposerThreadDraftState["files"] | ComposerThreadDraftState["images"],
    after: ComposerThreadDraftState["files"] | ComposerThreadDraftState["images"],
  ) =>
    before.length === after.length &&
    before.every(
      (attachment, index) =>
        attachment.id === after[index]?.id && attachment.file === after[index]?.file,
    );
  return (
    attachmentsMatch(submitted.images, current.images) &&
    attachmentsMatch(submitted.files, current.files) &&
    (submitted.terminalContexts === current.terminalContexts ||
      JSON.stringify(submitted.terminalContexts) === JSON.stringify(current.terminalContexts)) &&
    (submitted.previewAnnotations === current.previewAnnotations ||
      JSON.stringify(submitted.previewAnnotations) ===
        JSON.stringify(current.previewAnnotations)) &&
    (submitted.reviewComments === current.reviewComments ||
      JSON.stringify(submitted.reviewComments) === JSON.stringify(current.reviewComments)) &&
    JSON.stringify(submitted.threadContexts) === JSON.stringify(current.threadContexts) &&
    JSON.stringify(submitted.modelSelectionByProvider) ===
      JSON.stringify(current.modelSelectionByProvider) &&
    submitted.activeProvider === current.activeProvider &&
    submitted.runtimeMode === current.runtimeMode &&
    submitted.interactionMode === current.interactionMode &&
    JSON.stringify(submitted.extractedIntent) === JSON.stringify(current.extractedIntent)
  );
}

const SubmissionJournal = Schema.Union([
  Schema.Struct({ fingerprint: Schema.String, id: Schema.String }),
  Schema.Record(Schema.String, Schema.String),
]);
function readSubmissionJournal(key: string): Record<string, string> {
  const stored = localStorage.getItem(key);
  if (!stored) return {};
  const saved = Schema.decodeUnknownSync(SubmissionJournal)(JSON.parse(stored));
  return "fingerprint" in saved && "id" in saved ? { [saved.fingerprint]: saved.id } : { ...saved };
}

/** Keep the same SHA-256 identity on HTTPS, localhost, and plain HTTP. */
async function payloadFingerprint(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    : sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lost responses retain every outstanding intent, even while newer drafts are sent. */
export async function queueSubmissionId(targetKey: string, payload: unknown): Promise<string> {
  const fingerprint = await payloadFingerprint(payload);
  const key = `scient-queue-submission:${targetKey}`;
  const journal = readSubmissionJournal(key);
  if (journal[fingerprint]) return journal[fingerprint];
  const id = `qitem_${randomUUID()}`;
  localStorage.setItem(key, JSON.stringify({ ...journal, [fingerprint]: id }));
  return id;
}
export function acknowledgeQueueSubmission(targetKey: string, id: string) {
  const key = `scient-queue-submission:${targetKey}`;
  const remaining = Object.fromEntries(
    Object.entries(readSubmissionJournal(key)).filter(([, savedId]) => savedId !== id),
  );
  if (Object.keys(remaining).length === 0) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(remaining));
}

/** Exact client-runtime request after preparation. Type/JSON conversion preserves
 * context DateTime values and ordered prepared attachments across reload. */
const ExtractedSubmissionPacketSchema = Schema.Struct({
  environmentId: EnvironmentId,
  input: Schema.Struct({
    commandId: CommandId,
    threadId: ThreadId,
    createdAt: Schema.String,
    message: Schema.Struct({
      messageId: MessageId,
      role: Schema.Literal("user"),
      text: Schema.String,
      attachments: Schema.Array(Schema.Union([ChatAttachment, UploadChatAttachment])),
      context: Schema.optionalKey(OrchestrationMessageContext),
    }),
    modelSelection: Schema.optionalKey(ModelSelection),
    titleSeed: Schema.optionalKey(Schema.String),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    selectedScientSkillNames: Schema.optionalKey(Schema.Array(Schema.String)),
    sourceProposedPlan: Schema.optionalKey(Schema.Struct({ threadId: ThreadId, planId: PlanId })),
    dispatchMode: Schema.optionalKey(
      Schema.Literals(["auto", "queue", "steer", "restart", "start"]),
    ),
    bootstrap: Schema.optionalKey(
      Schema.Struct({
        createThread: Schema.optionalKey(
          Schema.Struct({
            projectId: ProjectId,
            title: Schema.String,
            modelSelection: ModelSelection,
            runtimeMode: RuntimeMode,
            interactionMode: ProviderInteractionMode,
            branch: Schema.NullOr(Schema.String),
            worktreePath: Schema.NullOr(Schema.String),
            createdAt: Schema.String,
          }),
        ),
        prepareWorktree: Schema.optionalKey(
          Schema.Struct({
            requireWorktree: Schema.optionalKey(Schema.Boolean),
            projectCwd: Schema.String,
            baseBranch: Schema.String,
            branch: Schema.optionalKey(Schema.String),
            startFromOrigin: Schema.optionalKey(Schema.Boolean),
          }),
        ),
        runSetupScript: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
});
const packetJson = Schema.fromJsonString(Schema.toCodecJson(ExtractedSubmissionPacketSchema));
const encodePacket = Schema.encodeSync(packetJson);
const decodePacket = Schema.decodeUnknownSync(packetJson);
export type ExtractedSubmissionPacket = {
  readonly environmentId: EnvironmentId;
  readonly input: StartThreadTurnInput & {
    readonly commandId: CommandId;
    readonly createdAt: string;
  };
};
export function readExtractedSubmission(
  record: ExtractedIntentRecord,
): ExtractedSubmissionPacket | undefined {
  if (record.packetJson === undefined) return undefined;
  const packet = decodePacket(record.packetJson);
  if (packet.input.commandId !== `extracted-intent:${record.intentId}`)
    throw new Error("The extracted submission binding is invalid. Recovery has been kept.");
  return packet;
}
export async function extractedDraftFingerprint(draft: ComposerThreadDraftState): Promise<string> {
  const attachment = async (
    value: ComposerThreadDraftState["files"][number] | ComposerThreadDraftState["images"][number],
  ) => ({
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    bytes: value.file
      ? Array.from(sha256(new Uint8Array(await value.file.arrayBuffer())), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")
      : null,
  });
  return payloadFingerprint({
    prompt: draft.prompt,
    images: await Promise.all(draft.images.map(attachment)),
    files: await Promise.all(draft.files.map(attachment)),
    terminalContexts: draft.terminalContexts,
    previewAnnotations: draft.previewAnnotations,
    reviewComments: draft.reviewComments,
    threadContexts: draft.threadContexts,
    models: draft.modelSelectionByProvider,
    activeProvider: draft.activeProvider,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
  });
}
export async function bindExtractedSubmission(
  record: ExtractedIntentRecord,
  packet: ExtractedSubmissionPacket,
  fingerprint: string,
  journalKey: string,
) {
  const encoded = encodePacket(packet);
  return updateExtractedIntent(record.intentId, (current) => {
    if (!current || current.phase === "consumed")
      throw new Error("This extracted intent was already submitted. Its recovery has been kept.");
    if (current.packetJson !== undefined) {
      if (current.packetJson !== encoded)
        throw new Error("Retry the frozen extracted intent before sending a different packet.");
      return current;
    }
    return {
      ...current,
      phase: "submitted-unknown",
      packetJson: encoded,
      draftFingerprint: fingerprint,
      boundJournalKey: journalKey,
    };
  });
}
export async function consumeExtractedSubmission(record: ExtractedIntentRecord) {
  return updateExtractedIntent(record.intentId, (current) => {
    if (!current?.packetJson)
      throw new Error("The extracted submission receipt is unavailable. Recovery has been kept.");
    const packet = readExtractedSubmission(current)!;
    const { packetJson: _packet, draftFingerprint: _draft, ...receipt } = current;
    return { ...receipt, phase: "consumed", consumedCommandId: packet.input.commandId };
  });
}
