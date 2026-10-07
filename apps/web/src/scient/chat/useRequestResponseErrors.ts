import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "~/session-logic";

/**
 * A failed response stays visible on the request it belongs to, so the
 * composer can explain the failure without a global thread error. Upstream
 * reads request state straight off the projection; this layers a local
 * shadow on top.
 */
export function useRequestResponseErrors(input: {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly pendingRequestModel: {
    readonly approvals: ReadonlyArray<PendingApproval>;
    readonly userInputs: ReadonlyArray<PendingUserInput>;
  };
}) {
  const { environmentId, activeThreadId, pendingRequestModel } = input;
  const [requestResponseErrors, setRequestResponseErrors] = useState<Record<string, string>>({});
  const setRequestResponseError = useCallback(
    (requestId: RuntimeRequestId, message: string) => {
      const key = JSON.stringify([environmentId, activeThreadId, requestId]);
      setRequestResponseErrors((errors) => ({ ...errors, [key]: message }));
    },
    [activeThreadId, environmentId],
  );
  const { approvals: pendingApprovals, userInputs: pendingUserInputs } = useMemo(() => {
    const withLocalError = <T extends { requestId: RuntimeRequestId }>(request: T) => {
      const responseError =
        requestResponseErrors[JSON.stringify([environmentId, activeThreadId, request.requestId])];
      return responseError ? { ...request, responseError } : request;
    };
    return {
      approvals: derivePendingApprovals(pendingRequestModel.approvals).map(withLocalError),
      userInputs: derivePendingUserInputs(pendingRequestModel.userInputs).map(withLocalError),
    };
  }, [
    pendingRequestModel.approvals,
    pendingRequestModel.userInputs,
    requestResponseErrors,
    environmentId,
    activeThreadId,
  ]);
  return { setRequestResponseError, pendingApprovals, pendingUserInputs };
}
