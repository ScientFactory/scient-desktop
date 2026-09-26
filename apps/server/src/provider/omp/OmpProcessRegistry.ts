import { ompBinaryFingerprint } from "./OmpSessionCursor.ts";

/**
 * Process-wide registry of live Oh My Pi child processes, keyed by the
 * canonical executable identity.
 *
 * A native `omp update` replaces the installed executable. Doing that while any
 * OMP process is alive is unsafe even when no turn is running: an idle session
 * still holds the old binary, one-shot title/commit generation is short lived
 * but real, and Windows cannot replace a running image at all. The registry
 * makes that check cover every OMP instance and every short-lived process in
 * this server, not only the adapter that happens to ask.
 *
 * Scope: one server process. A second Scient process on the same machine is
 * still covered by the executable lock the updater and installer take, and by
 * OMP's own session locks.
 */
interface OmpProcessRegistration {
  readonly id: string;
  readonly kind: "session" | "one-shot";
  readonly threadId: string;
}

const live = new Map<string, Map<string, OmpProcessRegistration>>();
const updating = new Set<string>();

const keyFor = (command: string): string => ompBinaryFingerprint(command);

const register = (key: string, entry: OmpProcessRegistration): void => {
  const existing = live.get(key);
  if (existing) {
    existing.set(entry.id, entry);
    return;
  }
  live.set(key, new Map([[entry.id, entry]]));
};

export const registerOmpProcess = (input: {
  readonly command: string;
  readonly id: string;
  readonly kind: "session" | "one-shot";
  readonly threadId?: string | undefined;
}): void => {
  register(keyFor(input.command), {
    id: input.id,
    kind: input.kind,
    threadId: input.threadId ?? "",
  });
};

export const unregisterOmpProcess = (input: { readonly command: string; readonly id: string }) => {
  const existing = live.get(keyFor(input.command));
  if (!existing) return;
  existing.delete(input.id);
  if (existing.size === 0) live.delete(keyFor(input.command));
};

/** True when any OMP process for this executable is still alive. */
export const hasLiveOmpProcess = (command: string): boolean => {
  const existing = live.get(keyFor(command));
  return existing !== undefined && existing.size > 0;
};

/**
 * Marks the executable as being replaced for the duration of a native update.
 * New sessions then fail closed instead of starting against an executable that
 * is about to change.
 */
export const beginOmpBinaryUpdate = (command: string): void => {
  updating.add(keyFor(command));
};

export const endOmpBinaryUpdate = (command: string): void => {
  updating.delete(keyFor(command));
};

export const isOmpBinaryUpdating = (command: string): boolean => updating.has(keyFor(command));

/** Test seam: the registry is process state. */
export const resetOmpProcessRegistry = (): void => {
  live.clear();
  updating.clear();
};
