import type { ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";

/**
 * Puts a short, readable reference to a Compute result in the chat composer. The agent finds the
 * run itself (`scient_compute_sessions`, `scient_compute_output`); the user adds the question.
 */
export function askInChatAboutCompute(input: {
  readonly threadRef: ScopedThreadRef;
  readonly what: string;
  /** When the run was submitted, to tell repeated runs of the same code apart. */
  readonly submittedAt?: string;
}) {
  const time =
    input.submittedAt === undefined
      ? ""
      : `, run at ${new Date(input.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const reference = `${input.what}${time}: `;
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(input.threadRef)?.prompt ?? "";
  store.setPrompt(
    input.threadRef,
    current.trim().length > 0 ? `${current}\n\n${reference}` : reference,
  );
}
