import { sha256 } from "@noble/hashes/sha2";
import { randomUUID } from "../../lib/utils";
import * as Schema from "effect/Schema";
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
      JSON.stringify(submitted.reviewComments) === JSON.stringify(current.reviewComments))
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
