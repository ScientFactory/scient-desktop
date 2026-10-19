/**
 * The sign-in request ids this window holds, per provider instance. They live
 * in session storage, so a renderer reload keeps them, until released or
 * expired. Also the change signal every sign-in hook subscribes to.
 */
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { randomUUID } from "../../lib/utils";

export interface ProviderSignInKey {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

interface HeldRequest {
  readonly id: string;
  readonly createdAt: number;
}

/**
 * Longer than any provider's sign-in window plus its start (Antigravity allows
 * five minutes after a start of up to a minute). The server operation carries no
 * deadline, so an id whose operation never reports a terminal state ends here.
 */
const REQUEST_LIFETIME_MS = 15 * 60_000;
const STORAGE_KEY = "scient.providerSignIn.pendingRequests.v1";

const held = new Map<string, ReadonlyArray<HeldRequest>>();
const listeners = new Set<() => void>();
let now: () => number = Date.now;
let heldKeysSnapshot: ReadonlyArray<ProviderSignInKey> = [];

export const signInKeyOf = (key: ProviderSignInKey) =>
  `${key.environmentId}\u0000${key.instanceId}`;

export function subscribeToProviderSignIn(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyProviderSignIn(): void {
  for (const listener of listeners) listener();
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isHeldRequest(value: unknown): value is HeldRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    /^[A-Za-z0-9-]{8,64}$/.test(value.id) &&
    "createdAt" in value &&
    typeof value.createdAt === "number"
  );
}

function refreshHeldKeys() {
  heldKeysSnapshot = [...held.keys()].map((id) => {
    const [environmentId, instanceId] = id.split("\u0000");
    return {
      environmentId: environmentId as EnvironmentId,
      instanceId: instanceId as ProviderInstanceId,
    };
  });
}

function setHeld(id: string, requests: ReadonlyArray<HeldRequest>) {
  if (requests.length > 0) held.set(id, requests);
  else held.delete(id);
  refreshHeldKeys();
  const storage = sessionStore();
  if (!storage) return;
  try {
    if (held.size === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(held)));
  } catch {
    // Storage can be full or unavailable; the ids still work until a reload.
  }
}

function hydrate() {
  held.clear();
  const raw = sessionStore()?.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [id, requests] of Object.entries(parsed)) {
          if (!Array.isArray(requests)) continue;
          const valid = requests.filter(isHeldRequest);
          if (valid.length > 0) held.set(id, valid);
        }
      }
    } catch {
      // A malformed entry only loses ids from before the reload.
    }
  }
  refreshHeldKeys();
  dropExpiredSignInRequests();
}

export function dropExpiredSignInRequests(): void {
  const cutoff = now() - REQUEST_LIFETIME_MS;
  let changed = false;
  for (const [id, requests] of held) {
    const live = requests.filter((request) => request.createdAt > cutoff);
    if (live.length === requests.length) continue;
    setHeld(id, live);
    changed = true;
  }
  if (changed) notifyProviderSignIn();
}

/** Records a fresh request id for the instance and returns it. */
export function holdNewSignInRequest(key: ProviderSignInKey): string {
  const id = signInKeyOf(key);
  const requestId = randomUUID();
  setHeld(id, [...(held.get(id) ?? []), { id: requestId, createdAt: now() }]);
  notifyProviderSignIn();
  return requestId;
}

export function holdsSignInRequest(key: ProviderSignInKey, requestId: string | undefined): boolean {
  return (
    requestId !== undefined &&
    (held.get(signInKeyOf(key)) ?? []).some((request) => request.id === requestId)
  );
}

export function holdsAnySignInRequest(key: ProviderSignInKey): boolean {
  return held.has(signInKeyOf(key));
}

export function releaseSignInRequest(key: ProviderSignInKey, requestId: string): void {
  const id = signInKeyOf(key);
  const requests = held.get(id) ?? [];
  if (!requests.some((request) => request.id === requestId)) return;
  setHeld(
    id,
    requests.filter((request) => request.id !== requestId),
  );
  notifyProviderSignIn();
}

const readHeldKeys = () => heldKeysSnapshot;

/** The provider instances for which this window holds a sign-in request id. */
export function usePendingProviderSignInKeys(): ReadonlyArray<ProviderSignInKey> {
  return useSyncExternalStore(subscribeToProviderSignIn, readHeldKeys, readHeldKeys);
}

hydrate();

/** Test seam: with `reload`, ids come back from session storage; otherwise it is cleared. */
export function resetSignInRequestsForTests(options: {
  readonly now?: () => number;
  readonly reload?: boolean;
}): void {
  now = options.now ?? Date.now;
  if (options.reload) {
    hydrate();
    return;
  }
  held.clear();
  sessionStore()?.removeItem(STORAGE_KEY);
  refreshHeldKeys();
}
