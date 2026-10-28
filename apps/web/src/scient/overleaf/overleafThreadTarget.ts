// SCIENT-OWNED: where "Ask the agent" writes its message. A sync takes a while,
// and the person may move to another thread meanwhile; the message goes to the
// thread the request came from, never into whichever composer is showing.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "~/composerDraftStore";
import { resolveThreadRouteRef } from "~/threadRoutes";

/** Reads, when called, the thread the window shows now. */
export function useReadShownThread(): () => ScopedThreadRef | null {
  const router = useRouter();
  return () => {
    const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(params as Partial<Record<"environmentId" | "threadId", string>>);
  };
}

export function sameThread(left: ScopedThreadRef | null, right: ScopedThreadRef | null): boolean {
  return left !== null && right !== null && scopedThreadKey(left) === scopedThreadKey(right);
}

/** Appends to one thread's draft by its identity, whether or not it is on screen. */
export function appendToThreadDraft(threadRef: ScopedThreadRef, message: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(threadRef)?.prompt ?? "";
  store.setPrompt(threadRef, existing.length > 0 ? `${existing}\n\n${message}` : message);
}
