import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  useComposerDraftStore,
  type DraftId,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import type { ExtractedIntentRecord, QueueEditSession } from "./editJournal";
import {
  finishQueueEdit,
  prepareExtractedDraftIntent,
  retireConsumedDraftIntent,
  resolveExtractedDraftIntent,
} from "./editSession";
import {
  bindExtractedSubmission,
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

export const extractedIntentActionErrors = {
  separate: "Send this extracted intent as its own message before starting another action.",
  multipleModels: "Send this extracted intent to one model before starting multiple models.",
  fork: "Keep this extracted intent in its recovery draft before opening a fork.",
  feedback: "Keep this extracted intent before submitting separate feedback.",
} as const;

/** Resolve recovery before reading current action policy or offering a retry. */
export async function beginExtractedSubmission<
  Result extends { readonly _tag: "Success" | "Failure" },
>({
  hasSeparateAction,
  ...retry
}: Omit<Parameters<typeof retryExtractedSubmission<Result>>[0], "intent"> & {
  hasSeparateAction: () => boolean;
}) {
  const intent = await resolveExtractedDraftIntent(
    useComposerDraftStore.getState().getComposerDraft(retry.target),
  );
  if (intent && hasSeparateAction()) throw new Error(extractedIntentActionErrors.separate);
  const retryResult = await retryExtractedSubmission({ ...retry, intent });
  return { intent, retryResult };
}

/** Bind the offered snapshot after uploads, without substituting a newer draft. */
export async function prepareAndBindExtractedSubmission(
  intent: ExtractedIntentRecord,
  packet: ExtractedSubmissionPacket,
  snapshot: ComposerThreadDraftState | null | undefined,
) {
  await prepareExtractedDraftIntent(intent.intentId);
  if (!snapshot) throw new Error("The extracted draft snapshot is unavailable.");
  const marker = snapshot.extractedIntent;
  if (!marker || !("intentId" in marker) || marker.intentId !== intent.intentId)
    throw new Error("The extracted draft changed ownership before preparation completed.");
  return bindExtractedSubmission(
    intent,
    packet,
    await extractedDraftFingerprint(snapshot),
    marker.journalKey,
  );
}

/** A first intake acknowledgement may detach only the later authored draft. */
export async function retireAcknowledgedExtractedDraft(
  target: ScopedThreadRef | DraftId,
  intent: ExtractedIntentRecord,
  snapshot: ComposerThreadDraftState | null | undefined,
) {
  const afterAck = useComposerDraftStore.getState().getComposerDraft(target);
  const mayDetachLaterDraft = !composerSubmissionMatchesDraft(snapshot, afterAck);
  await retireConsumedDraftIntent(
    target,
    intent.intentId,
    mayDetachLaterDraft ? intent.boundJournalKey : undefined,
  );
}
