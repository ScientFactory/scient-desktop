import type { KeepAwakeWork, ThreadId } from "@t3tools/contracts";

/**
 * Asleep is only a click away once the request ends, so a thread that starts again a moment later,
 * or one missed update, must not put the computer to sleep.
 */
const HOLD_AFTER_WORK_MS = 60_000;

export interface KeepAwakeHold {
  /** Threads on "until done", with when each was last seen unfinished. */
  readonly chosen: ReadonlyMap<ThreadId, number | null>;
  readonly lastWorkAt: number | null;
}

export const NO_HOLD: KeepAwakeHold = { chosen: new Map(), lastWorkAt: null };

/** `work` is null when it couldn't be read, which proves nothing about any thread. */
export function observeWork(
  hold: KeepAwakeHold,
  work: KeepAwakeWork | null,
  appSetting: boolean,
  now: number,
): KeepAwakeHold {
  const chosen = new Map(hold.chosen);
  if (work !== null) {
    const unfinished = new Set([...work.working, ...work.waiting]);
    for (const [threadId, seenAt] of hold.chosen) {
      if (unfinished.has(threadId)) chosen.set(threadId, now);
      else if (seenAt !== null && now - seenAt >= HOLD_AFTER_WORK_MS) chosen.delete(threadId);
    }
  }
  if (!appSetting && chosen.size === 0) return NO_HOLD;
  const needed = work?.working.some((id) => appSetting || chosen.has(id)) ?? false;
  return { chosen, lastWorkAt: needed ? now : hold.lastWorkAt };
}

export function keepsAwake({ lastWorkAt }: KeepAwakeHold, now: number) {
  return lastWorkAt !== null && now - lastWorkAt < HOLD_AFTER_WORK_MS;
}
