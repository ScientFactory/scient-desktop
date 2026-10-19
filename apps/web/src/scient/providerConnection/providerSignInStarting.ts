/**
 * Whether this window's start command for a provider instance is in flight, so
 * views can show it starting from the click, before the server's starting
 * operation arrives.
 */
import { useSyncExternalStore } from "react";

import {
  notifyProviderSignIn,
  type ProviderSignInKey,
  signInKeyOf,
  subscribeToProviderSignIn,
} from "./providerSignInRequests";

const startsInFlight = new Map<string, number>();

/** Counts a start in flight until the returned function is called. */
export function beginProviderSignInStart(key: ProviderSignInKey): () => void {
  const id = signInKeyOf(key);
  startsInFlight.set(id, (startsInFlight.get(id) ?? 0) + 1);
  notifyProviderSignIn();
  return () => {
    const left = (startsInFlight.get(id) ?? 0) - 1;
    if (left > 0) startsInFlight.set(id, left);
    else startsInFlight.delete(id);
    notifyProviderSignIn();
  };
}

export function isProviderSignInStartingHere(key: ProviderSignInKey): boolean {
  return startsInFlight.has(signInKeyOf(key));
}

export function useProviderSignInStartingHere(key: ProviderSignInKey): boolean {
  const { environmentId, instanceId } = key;
  const read = () => isProviderSignInStartingHere({ environmentId, instanceId });
  return useSyncExternalStore(subscribeToProviderSignIn, read, read);
}

export function resetProviderSignInStartsForTests(): void {
  startsInFlight.clear();
}
