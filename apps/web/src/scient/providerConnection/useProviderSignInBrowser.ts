import type { ProviderConnectionOperation } from "@t3tools/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { openProviderSignInPageByHand } from "./providerSignInFlow";
import { type ProviderSignInOpening, useProviderSignInOpening } from "./providerSignInOpenings";
import {
  holdsSignInRequest,
  type ProviderSignInKey,
  subscribeToProviderSignIn,
} from "./providerSignInRequests";
import { isProviderSignInStartingHere } from "./providerSignInStarting";

/**
 * What this window did about the operation's sign-in page, for a setup view.
 * `opening` is `null` until it opens the page. `startedHere` says this window
 * started the operation and is about to open it; when both are unset, another
 * client started the sign-in, or this window lost track of it (a full quit).
 * While mounted, the view also receives opening failures instead of a toast.
 */
export function useProviderSignInBrowser(
  key: ProviderSignInKey,
  operation: ProviderConnectionOperation | null,
  providerName: string,
): {
  readonly opening: ProviderSignInOpening | null;
  readonly startedHere: boolean;
  readonly reopen: () => Promise<void>;
} {
  const { environmentId, instanceId } = key;
  const operationId = operation?.operationId ?? null;
  const requestId = operation?.signInRequestId;
  const url = operation?.authorizationUrl ?? null;
  const opening = useProviderSignInOpening(key, operationId);
  const readStartedHere = useCallback(() => {
    const signInKey = { environmentId, instanceId };
    return requestId !== undefined
      ? holdsSignInRequest(signInKey, requestId)
      : isProviderSignInStartingHere(signInKey);
  }, [environmentId, instanceId, requestId]);
  const startedHere = useSyncExternalStore(
    subscribeToProviderSignIn,
    readStartedHere,
    readStartedHere,
  );
  const reopen = useCallback(async () => {
    if (operationId === null || url === null) return;
    await openProviderSignInPageByHand({
      key: { environmentId, instanceId },
      operationId,
      signInRequestId: requestId,
      url,
      providerName,
    });
  }, [environmentId, instanceId, operationId, providerName, requestId, url]);
  return { opening, startedHere, reopen };
}
