import type { ScopedThreadRef } from "@t3tools/contracts";

interface ActiveSurfaceDeparture {
  readonly threadRef: ScopedThreadRef;
  readonly isCurrent: () => boolean;
  readonly run: (targetSurfaceId: string | null, run: () => void) => boolean;
}

let activeDeparture: ActiveSurfaceDeparture | null = null;

/** Exposes the mounted chat's existing departure lane to app-lifetime preview requests. */
export function registerActiveSurfaceDeparture(owner: ActiveSurfaceDeparture): () => void {
  activeDeparture = owner;
  return () => {
    if (activeDeparture === owner) activeDeparture = null;
  };
}

export function requestActiveSurfaceDeparture(
  threadRef: ScopedThreadRef,
  targetSurfaceId: string,
  run: () => void,
): void {
  const owner = activeDeparture;
  if (
    owner === null ||
    owner.threadRef.environmentId !== threadRef.environmentId ||
    owner.threadRef.threadId !== threadRef.threadId
  ) {
    // Background presentation changes do not displace the mounted editor.
    run();
    return;
  }
  if (!owner.isCurrent()) return;
  owner.run(targetSurfaceId, () => {
    if (activeDeparture === owner && owner.isCurrent()) run();
  });
}
