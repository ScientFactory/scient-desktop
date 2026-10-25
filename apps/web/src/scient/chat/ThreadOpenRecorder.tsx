import { type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { claimThreadOpen } from "@t3tools/client-runtime/state/thread-search";
import { useEffect, useRef } from "react";

import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Records that the user opened a thread, which ranks it in thread search.
 *
 * Upstream records the open from its visit watermark, which also marks the
 * thread read up to its latest activity. In Scient `useAcknowledgeAnswer` is
 * the only visit writer that changes read state, so this sends the open with
 * the thread's current watermark: the server moves `lastVisitedAt` only
 * forward, so the open is counted and nothing is marked read.
 */
export function ThreadOpenRecorder(props: { readonly threadRef: ScopedThreadRef }) {
  const serverThread = useThreadShell(props.threadRef);
  const threadKey = scopedThreadKey(props.threadRef);
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const recordedRef = useRef<string | null>(null);
  const environmentId = serverThread?.environmentId;
  const threadId = serverThread?.id;
  const lastVisitedAt = serverThread?.lastVisitedAt;

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
