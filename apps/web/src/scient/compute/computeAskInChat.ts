import type { ComputeExecutionId, ComputeSessionId, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";

/**
 * Puts a short reference to a Compute result in the chat composer. The ids let the agent read
 * the full output and figures with `scient_compute_output`; the user adds the question.
 */
export function askInChatAboutCompute(input: {
  readonly threadRef: ScopedThreadRef;
  readonly what: string;
  readonly run?: { readonly sessionId: ComputeSessionId; readonly executionId: ComputeExecutionId };
}) {
  const reference =
    input.run === undefined
      ? input.what
      : `${input.what} (Compute session ${input.run.sessionId}, run ${input.run.executionId})`;
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(input.threadRef)?.prompt ?? "";
  store.setPrompt(
    input.threadRef,
    current.trim().length > 0 ? `${current}\n\n${reference}: ` : `${reference}: `,
  );
}
