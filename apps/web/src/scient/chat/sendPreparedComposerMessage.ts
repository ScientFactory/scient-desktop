import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type DraftId,
} from "~/composerDraftStore";

export function sendPreparedComposerMessage(input: {
  readonly threadRef: ScopedThreadRef;
  readonly composerTarget: ScopedThreadRef | DraftId;
  readonly ready: boolean;
  readonly prompt: string;
  readonly message: string;
  readonly insert: (message: string) => boolean;
  readonly submit: () => void;
}): boolean {
  if (
    !input.ready ||
    typeof input.composerTarget === "string" ||
    scopedThreadKey(input.composerTarget) !== scopedThreadKey(input.threadRef) ||
    input.prompt.length > 0
  )
    return false;
  const draft = useComposerDraftStore.getState().getComposerDraft(input.composerTarget);
  if (composerDraftHasUserContent(draft) || draft?.extractedIntent) return false;
  if (!input.insert(input.message)) return false;
  // Stage through the composer first so ordinary send failures retain an editable request.
  input.submit();
  return true;
}
