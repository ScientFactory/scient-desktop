import { EnvironmentId, ThreadForkCommand, type ForkDisposition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Attempt = Schema.Struct({
  environmentId: EnvironmentId,
  command: ThreadForkCommand,
  ready: Schema.Boolean,
  handoffDone: Schema.Boolean,
  composerDraftFingerprint: Schema.optional(Schema.String),
  displayTitle: Schema.optional(Schema.String),
});
export type ForkAttempt = typeof Attempt.Type;
const decodeAttempt = Schema.decodeUnknownSync(Schema.fromJsonString(Attempt));
const STORAGE_PREFIX = "scient:fork-attempt:v1:";

/** Entries survive navigation/reload until the same operation is resolved. */
export function createForkAttemptStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  return {
    get(key: string): ForkAttempt | null {
      const value = storage.getItem(STORAGE_PREFIX + key);
      return value === null ? null : decodeAttempt(value);
    },
    set(key: string, attempt: ForkAttempt) {
      storage.setItem(STORAGE_PREFIX + key, JSON.stringify(attempt));
    },
    delete(key: string) {
      storage.removeItem(STORAGE_PREFIX + key);
    },
  };
}
export type ForkAttemptStore = ReturnType<typeof createForkAttemptStore>;

export function forkAttemptKey(environmentId: string, originId: string, source: string): string {
  return JSON.stringify([environmentId, originId, source]);
}

export function forkErrorDisposition(error: unknown): ForkDisposition {
  const disposition =
    typeof error === "object" && error !== null && "forkDisposition" in error
      ? error.forkDisposition
      : undefined;
  return disposition === "rejected" ||
    disposition === "pending" ||
    disposition === "provisioning" ||
    disposition === "failed" ||
    disposition === "abandoned" ||
    disposition === "ready"
    ? disposition
    : "unknown";
}

/** A missing acknowledgement never proves rejection. Only typed server evidence does. */
export async function deliverForkAttempt(input: {
  key: string;
  attempt: ForkAttempt;
  store: ForkAttemptStore;
  dispatch: (attempt: ForkAttempt) => Promise<void>;
  discardDraft: () => void;
}): Promise<ForkAttempt> {
  let attempt = input.attempt;
  if (attempt.ready) return attempt;
  input.store.set(input.key, attempt);
  try {
    await input.dispatch(attempt);
  } catch (error) {
    const disposition = forkErrorDisposition(error);
    if (disposition === "rejected" || disposition === "abandoned") {
      input.discardDraft();
      input.store.delete(input.key);
    }
    if (disposition !== "ready") throw error;
  }
  attempt = { ...attempt, ready: true };
  input.store.set(input.key, attempt);
  return attempt;
}

// A hook can unmount while its command is running. Ownership outlives that hook.
const activeOrigins = new Set<string>();
const listeners = new Set<() => void>();
export const subscribeForkOrigins = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const isForkOriginBusy = (key: string) => activeOrigins.has(key);
const notifyOrigins = () => {
  for (const listener of listeners) listener();
};
export async function withForkOriginLock<T>(key: string, run: () => Promise<T>): Promise<T | null> {
  if (activeOrigins.has(key)) return null;
  activeOrigins.add(key);
  notifyOrigins();
  try {
    return typeof navigator !== "undefined" && navigator.locks
      ? await navigator.locks.request(`scient:fork-origin:${key}`, { ifAvailable: true }, (lock) =>
          lock ? run() : null,
        )
      : await run();
  } finally {
    activeOrigins.delete(key);
    notifyOrigins();
  }
}
