import type { EnvironmentId } from "@t3tools/contracts";

const listeners = new Set<(environmentId: EnvironmentId) => void>();

/** Called after every Library change on any environment settles, whether it landed or failed. */
export function onLibraryWriteSettled(listener: (environmentId: EnvironmentId) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function libraryWriteSettled(environmentId: EnvironmentId) {
  for (const listener of listeners) listener(environmentId);
}
