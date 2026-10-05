import type { ScopedThreadRef } from "@t3tools/contracts";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import type { ExtractedIntentRecord, QueueEditSession } from "./editJournal";
import {
  finishQueueEdit,
  prepareExtractedDraftIntent,
  retireConsumedDraftIntent,
} from "./editSession";
import {
  composerSubmissionMatchesDraft,
  consumeExtractedSubmission,
  extractedDraftFingerprint,
  readExtractedSubmission,
  type ExtractedSubmissionPacket,
} from "./submission";

/** Retry unknown intake using the offered packet, then preserve later authoring. */
export async function retryExtractedSubmission<
  Result extends { readonly _tag: "Success" | "Failure" },
>({
  intent,
  target,
  queueEdit,
  dispatch,
  onDraftCleared,
}: {
  intent: ExtractedIntentRecord | undefined;
  target: ScopedThreadRef | DraftId;
  queueEdit: QueueEditSession | undefined;
  dispatch: (packet: ExtractedSubmissionPacket) => Promise<Result>;
  onDraftCleared: () => void;
}): Promise<Result | undefined> {
  if (!intent) return undefined;
  const frozen = readExtractedSubmission(intent);
  if (!frozen) return undefined;
  // Current settings, uploads and target changes cannot alter offered authority.
  const captured = useComposerDraftStore.getState().getComposerDraft(target);
  const capturedMatches =
    captured && (await extractedDraftFingerprint(captured)) === intent.draftFingerprint;
  await prepareExtractedDraftIntent(intent.intentId);
  const result = await dispatch(frozen);
  if (result._tag === "Failure") return result;
  await consumeExtractedSubmission(intent);
  if (queueEdit) await finishQueueEdit(queueEdit);
  if (
    capturedMatches &&
    composerSubmissionMatchesDraft(
      captured,
      useComposerDraftStore.getState().getComposerDraft(target),
    )
  ) {
    useComposerDraftStore.getState().clearComposerContent(target);
    onDraftCleared();
  }
  const atAck = useComposerDraftStore.getState().getComposerDraft(target);
  const retryMarker = captured?.extractedIntent;
  const laterMarker = atAck?.extractedIntent;
  const laterAuthoredJournal =
    !composerSubmissionMatchesDraft(captured, atAck) &&
    retryMarker &&
    laterMarker &&
    "journalKey" in retryMarker &&
    "journalKey" in laterMarker &&
    retryMarker.journalKey === laterMarker.journalKey
      ? laterMarker.journalKey
      : intent.boundJournalKey;
  await retireConsumedDraftIntent(target, intent.intentId, laterAuthoredJournal);
  return result;
}
