import type { ScopedProjectRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";

export const PROJECT_PROJECTION_WAIT_TIMEOUT_MS = 5_000;

interface ProjectionSource<T> {
  readonly read: () => T;
  readonly subscribe: (listener: (value: T) => void) => () => void;
}

/**
 * Waits for an event-backed projection without missing an update between the
 * initial read and subscription. The timeout is a recovery boundary: callers
 * must not treat an unprojected entity as ready after it expires.
 */
export function waitForProjectionValue<T>(
  source: ProjectionSource<T>,
  isReady: (value: T) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (isReady(source.read())) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let unsubscribe: () => void = () => undefined;

    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
      unsubscribe();
      resolve(ready);
    };

    const subscribedUnsubscribe = source.subscribe((value) => {
      if (isReady(value)) finish(true);
    });
    unsubscribe = subscribedUnsubscribe;
    // A projection can land after the first read but before the subscription
    // becomes observable. Re-read once after subscribing to close that race.
    if (settled) {
      subscribedUnsubscribe();
      return;
    }
    if (isReady(source.read())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => finish(false), timeoutMs);
  });
}

/** Waits until a successfully registered project reaches the client snapshot. */
export function waitForProjectProjection(
  projectRef: ScopedProjectRef,
  timeoutMs = PROJECT_PROJECTION_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const projectAtom = environmentProjects.projectAtom(projectRef);
  return waitForProjectionValue(
    {
      read: () => appAtomRegistry.get(projectAtom),
      subscribe: (listener) => appAtomRegistry.subscribe(projectAtom, listener),
    },
    (project) => project !== null,
    timeoutMs,
  );
}
