/**
 * What this window did about each operation's sign-in page: opening, opened or
 * failed. A failure shows in a mounted setup view of the instance, or else as a
 * toast with an action to open the page.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { toastManager } from "../../components/ui/toast";
import { openProviderAuthorizationPage, SignInPageBlocked } from "./providerSignInPage";
import {
  notifyProviderSignIn,
  type ProviderSignInKey,
  signInKeyOf,
  subscribeToProviderSignIn,
} from "./providerSignInRequests";

export interface ProviderSignInOpening {
  readonly status: "opening" | "opened" | "failed";
  readonly error: string | null;
  /** The browser blocked the page: the user's own click opens it. */
  readonly blocked?: boolean;
}

const OPEN_FAILURE =
  "Scient could not open the sign-in page in your browser. Try opening it again.";
const BLOCKED = "Your browser blocked the sign-in page. Open it to continue.";
const MAX_RETAINED_OPENINGS = 64;

const openings = new Map<string, ProviderSignInOpening>();
const surfaces = new Map<string, number>();
let openPage: (url: string) => Promise<void> = openProviderAuthorizationPage;

const openingKeyOf = (key: ProviderSignInKey, operationId: string) =>
  `${signInKeyOf(key)}\u0000${operationId}`;

function setOpening(id: string, opening: ProviderSignInOpening) {
  openings.delete(id);
  openings.set(id, opening);
  while (openings.size > MAX_RETAINED_OPENINGS) {
    openings.delete(openings.keys().next().value!);
  }
  notifyProviderSignIn();
}

export function hasOpenedProviderSignInPage(key: ProviderSignInKey, operationId: string): boolean {
  return openings.has(openingKeyOf(key, operationId));
}

export async function openProviderSignInPage(input: {
  readonly key: ProviderSignInKey;
  readonly operationId: string;
  readonly url: string;
  readonly providerName: string;
}): Promise<void> {
  const id = openingKeyOf(input.key, input.operationId);
  setOpening(id, { status: "opening", error: null });
  try {
    await openPage(input.url);
    setOpening(id, { status: "opened", error: null });
  } catch (error) {
    // The native error can name the link or local paths; users see fixed guidance.
    const blocked = error instanceof SignInPageBlocked;
    setOpening(id, {
      status: "failed",
      error: blocked ? BLOCKED : OPEN_FAILURE,
      ...(blocked ? { blocked } : {}),
    });
    if ((surfaces.get(signInKeyOf(input.key)) ?? 0) > 0) return;
    toastManager.add({
      type: blocked ? "warning" : "error",
      title: blocked
        ? `${input.providerName} sign-in page blocked`
        : `${input.providerName} sign-in page didn’t open`,
      actionProps: { children: "Open", onClick: () => void openProviderSignInPage(input) },
    });
  }
}

/** This window's opening of the operation's page, while a setup view shows it. */
export function useProviderSignInOpening(
  key: ProviderSignInKey,
  operationId: string | null,
): ProviderSignInOpening | null {
  const { environmentId, instanceId } = key;
  useEffect(() => {
    const surface = signInKeyOf({ environmentId, instanceId });
    surfaces.set(surface, (surfaces.get(surface) ?? 0) + 1);
    return () => {
      const left = (surfaces.get(surface) ?? 0) - 1;
      if (left > 0) surfaces.set(surface, left);
      else surfaces.delete(surface);
    };
  }, [environmentId, instanceId]);
  // Each snapshot is the stored value itself, so memoized renders see every change.
  const read = useCallback(
    () =>
      operationId === null
        ? null
        : (openings.get(openingKeyOf({ environmentId, instanceId }, operationId)) ?? null),
    [environmentId, instanceId, operationId],
  );
  return useSyncExternalStore(subscribeToProviderSignIn, read, read);
}

export function resetProviderSignInOpeningsForTests(open?: (url: string) => Promise<void>): void {
  openPage = open ?? openProviderAuthorizationPage;
  openings.clear();
  surfaces.clear();
}
