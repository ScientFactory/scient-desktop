import { type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { claimThreadOpen } from "@t3tools/client-runtime/state/thread-search";
import { useEffect, useRef } from "react";

import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Only useAcknowledgeAnswer may change read state. Record an open with the existing watermark so
 * search ranking updates without marking unseen activity read; the server watermark moves only
 * forward.
 */
export function ThreadOpenRecorder(props: { readonly threadRef: ScopedThreadRef }) {
  const serverThread = useThreadShell(props.threadRef);
  const threadKey = scopedThreadKey(props.threadRef);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const recordedRef = useRef<string | null>(null);
  const environmentId = serverThread?.environmentId;
  const threadId = serverThread?.id;
  const lastVisitedAt = serverThread?.lastVisitedAt;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends a one-shot thread-open visit RPC when the opened thread changes, deduped by a ref against re-renders
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    if (recordedRef.current === threadKey) return;
    recordedRef.current = threadKey;
    // Recorded locally even when the server cannot take opens, so recents follow it.
    // A palette pick already sent the open with its query; the claim dedupes it.
    const claimed = claimThreadOpen(environmentId, threadId, Date.now());
    // `undefined`: the server predates visits. `null`: never read; any visit time
    // would become its first watermark, so only the local open is kept.
    if (!claimed || lastVisitedAt == null) return;
    void visitThread({
      environmentId,
      input: { threadId, visitedAt: lastVisitedAt, opened: true },
    });
  }, [environmentId, lastVisitedAt, threadId, threadKey, visitThread]);
  return null;
}
