import {
  KEEP_AWAKE_LEASE_MS,
  type KeepAwakeChoice,
  type KeepAwakeObservation,
  type KeepAwakeThread,
} from "@t3tools/contracts";

const KEEP_AWAKE_FINISH_GRACE_MS = 20_000;

export interface KeepAwakeCompletion {
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export function selectKeepAwakeSession(
  thread: KeepAwakeThread,
  choice: KeepAwakeChoice,
  work: Pick<KeepAwakeObservation, "unfinished" | "latestRunId"> | undefined,
  now: number,
): KeepAwakeThread {
  const once = choice === "once";
  if (thread.once === once) return thread;
  return {
    ...thread,
    once,
    // An idle selection arms the next batch, even if the app default was
    // still confirming the previous batch's completion.
    startedAt: once ? (work?.unfinished ? now : null) : thread.startedAt,
    armedAfterRunId: once ? work?.latestRunId : null,
  };
}

export function observeKeepAwakeSession(
  thread: KeepAwakeThread,
  observation: KeepAwakeObservation,
  completion: KeepAwakeCompletion | undefined,
  enabled: boolean,
): { thread: KeepAwakeThread; completion: KeepAwakeCompletion | undefined } {
  if (!enabled) {
    return {
      thread: thread.startedAt === null ? thread : { ...thread, startedAt: null },
      completion: undefined,
    };
  }
  if (observation.unfinished) {
    return {
      thread: thread.startedAt === null ? { ...thread, startedAt: observation.observedAt } : thread,
      completion: undefined,
    };
  }
  // A short run can complete between polls. Its new identity still consumes
  // an armed override; an untouched thread with only old runs does not.
  if (
    thread.once &&
    thread.startedAt === null &&
    thread.armedAfterRunId !== undefined &&
    observation.latestRunId != null &&
    observation.latestRunId !== thread.armedAfterRunId
  ) {
    thread = { ...thread, startedAt: observation.observedAt };
  }
  if (thread.startedAt === null) return { thread, completion: undefined };
  if (completion && observation.observedAt <= completion.lastObservedAt) {
    return { thread, completion };
  }
  // Time spent disconnected is not evidence that the batch remained empty.
  if (
    completion === undefined ||
    observation.observedAt - completion.lastObservedAt >= KEEP_AWAKE_LEASE_MS
  ) {
    return {
      thread,
      completion: {
        firstObservedAt: observation.observedAt,
        lastObservedAt: observation.observedAt,
      },
    };
  }
  if (observation.observedAt - completion.firstObservedAt >= KEEP_AWAKE_FINISH_GRACE_MS) {
    return {
      thread: { ...thread, once: false, startedAt: null, armedAfterRunId: null },
      completion: undefined,
    };
  }
  return { thread, completion: { ...completion, lastObservedAt: observation.observedAt } };
}
