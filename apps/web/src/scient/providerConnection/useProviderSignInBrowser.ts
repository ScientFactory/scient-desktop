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

/**
 * What a setup view can say about this window's opening of a sign-in page.
 * `notOpenedHere`: not opened here and not about to be, so the user opens it.
 */
export function providerSignInPageState(
  opening: ProviderSignInOpening | null,
  startedHere: boolean,
) {
  const failure = opening?.status === "failed" ? opening.error : null;
  return {
    failure,
    blocked: failure !== null && opening?.blocked === true,
    notOpenedHere: opening === null && !startedHere,
    opened: opening?.status === "opened",
  };
}

/**
 * The waiting view of a browser sign-in with the shared copy (Codex, Cursor).
 * `userMustOpen`: nothing is open here, or opening failed.
 */
export function browserSignInWaitingView(
  browser: ReturnType<typeof useProviderSignInBrowser>,
  operation: ProviderConnectionOperation | null,
) {
  const page = providerSignInPageState(browser.opening, browser.startedHere);
  return {
    ...page,
    userMustOpen:
      operation?.authorizationUrlKind === "primary" &&
      (operation.status === "waiting_for_browser" ||
        operation.status === "waiting_for_device_code") &&
      (page.notOpenedHere || page.failure !== null),
    body: page.blocked
      ? "Open the sign-in page to continue."
      : (page.failure ??
        (page.opened
          ? "Complete sign-in in your browser."
          : page.notOpenedHere
            ? "Open the sign-in page to continue."
            : "Opening the sign-in page in your browser…")),
  };
}
