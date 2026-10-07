import type {
  EnvironmentId,
  ProviderApprovalDecision,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useRef, type Dispatch, type SetStateAction } from "react";
import type { PendingApproval } from "../../session-logic";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function useApprovalResponse({
  environmentId,
  threadId,
  approvals,
  setRespondingRequestIds,
  onResponseError,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly approvals: ReadonlyArray<Pick<PendingApproval, "requestId" | "responseCapability">>;
  readonly setRespondingRequestIds: Dispatch<SetStateAction<RuntimeRequestId[]>>;
  readonly onResponseError: (requestId: RuntimeRequestId, message: string) => void;
}) {
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const inFlight = useRef(new Set<string>());
  return async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
    if (
      threadId === null ||
      approvals.find((approval) => approval.requestId === requestId)?.responseCapability !== "live"
    )
      return;
    const key = JSON.stringify([environmentId, threadId, requestId]);
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setRespondingRequestIds((ids) => (ids.includes(requestId) ? ids : [...ids, requestId]));
    try {
      const result = await respond({ environmentId, input: { threadId, requestId, decision } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        onResponseError(requestId, "Approval could not be sent. Try again.");
      return result;
    } finally {
      inFlight.current.delete(key);
      setRespondingRequestIds((ids) => ids.filter((id) => id !== requestId));
    }
  };
}
