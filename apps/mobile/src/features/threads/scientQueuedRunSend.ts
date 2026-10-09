/**
 * SCIENT-OWNED Send on a queued message, matching the web strip.
 *
 * A held queue on an idle thread offers Send on every row the server accepts.
 * Send starts that message now and resumes the rest of the queue after it.
 * Mobile shows no held header and no Resume queue. A usage limit hides Send
 * only when the server-computed thread shell confirms it.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";

export { canSendScientQueuedRow } from "./scientQueuedRowSend";

/** The projection and shell evidence the queue sheet needs for per-row Send. */
export function useScientQueuedRunSendEvidence(target: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = useMemo(
    () => scopeThreadRef(target.environmentId, target.threadId),
    [target.environmentId, target.threadId],
  );
  const projection = useAtomValue(environmentThreadDetails.threadAtom(ref))?.projection;
  const shell = useThreadShell(ref);
  return { projection, shellLastErrorClass: shell?.runtime?.lastErrorClass };
}
