import {
  DEFAULT_KEEP_AWAKE_SETTINGS,
  KEEP_AWAKE_LEASE_MS,
  keepAwakeThreadKey,
  KeepAwakeDocument,
  type KeepAwakeObservation,
  type KeepAwakeRequest,
  type KeepAwakeState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { KeepAwakeStorage } from "./storage.ts";
import { KeepAwakePower } from "./power.ts";
import {
  observeKeepAwakeSession,
  selectKeepAwakeSession,
  type KeepAwakeCompletion,
} from "./keepAwakeSession.ts";
import {
  observeKeepAwakeExecution,
  executionKeepsAwake,
  type KeepAwakeExecutionLease,
} from "./keepAwakeExecution.ts";
import type { WorkSourceResult } from "./source.ts";

const sameDocument = Schema.toEquivalence(KeepAwakeDocument);

export const make = Effect.gen(function* () {
  const storage = yield* KeepAwakeStorage;
  const power = yield* KeepAwakePower;
  const clock = yield* Clock.Clock;
  const lock = yield* Semaphore.make(1);
  let storageError: string | null = null;
  let document: KeepAwakeDocument = yield* storage.load.pipe(
    Effect.catch(() => {
      storageError =
        "Could not load keep-awake preferences. Protection is disabled until preferences are saved.";
      return Effect.succeed({ settings: DEFAULT_KEEP_AWAKE_SETTINGS, threads: [] });
    }),
  );
  let sourceError: string | null = null;
  let powerError: string | null = null;
  let blocker: number | null = null;
  let quitting = false;
  const observations = new Map<string, KeepAwakeObservation>();
  const executions = new Map<string, readonly KeepAwakeExecutionLease[]>();
  const finishing = new Map<string, KeepAwakeCompletion>();
  const local = new Set<string>();
  const generations = new Map<string, number>();
  const enabled = (key: string, once: boolean) =>
    once || (local.has(key) && document.settings.mode === "running");
  const fresh = (observation: KeepAwakeObservation | undefined) =>
    observation !== undefined &&
    observation.observedAt + KEEP_AWAKE_LEASE_MS > clock.currentTimeMillisUnsafe();
  const needsAwake = (key: string) =>
    fresh(observations.get(key)) &&
    (executionKeepsAwake(executions.get(key) ?? [], clock.currentTimeMillisUnsafe()) ||
      finishing.has(key));
  const release = Effect.suspend(() => {
    const id = blocker;
    blocker = null;
    return id === null ? Effect.void : power.stop(id);
  });
  const reconcile = Effect.gen(function* () {
    if (
      !quitting &&
      storageError === null &&
      document.threads.some((thread) => enabled(thread.key, thread.once) && needsAwake(thread.key))
    ) {
      if (blocker === null)
        yield* power.start.pipe(
          Effect.match({
            onSuccess: (id) => {
              blocker = id;
              powerError = null;
            },
            onFailure: () => {
              powerError = "Could not request sleep prevention.";
            },
          }),
        );
    } else yield* release;
  });
  const state = (): KeepAwakeState => ({
    settings: document.settings,
    blocking: blocker !== null,
    error: storageError ?? powerError ?? sourceError,
    platformNotice: power.notice,
    threads: document.threads.map((thread) => {
      const observation = observations.get(thread.key);
      const status = !enabled(thread.key, thread.once)
        ? "off"
        : !fresh(observation)
          ? thread.startedAt === null
            ? "idle"
            : "unknown"
          : needsAwake(thread.key) && storageError === null
            ? "awake"
            : observation?.unfinished
              ? "paused"
              : "idle";
      return {
        ...thread,
        status,
        reason:
          status === "unknown"
            ? "Waiting for the execution environment"
            : status === "paused" && observation?.needsAwake
              ? "No live execution owner or recent progress"
              : (observation?.reason ?? "Armed for the next batch"),
      };
    }),
  });
  const persist = (next: KeepAwakeDocument, explicit: boolean) =>
    Effect.gen(function* () {
      // Memory follows the user's choice even when disk writes fail. The fault blocks reacquisition.
      document = next;
      if (storageError !== null && !explicit) return;
      yield* storage.save(next).pipe(
        Effect.match({
          onSuccess: () => {
            if (explicit) storageError = null;
          },
          onFailure: () => {
            storageError =
              "Could not save keep-awake preferences. Protection is disabled until a save succeeds.";
          },
        }),
      );
      if (storageError !== null) yield* release;
    });
  const accept = (results: readonly WorkSourceResult[]) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        sourceError = null;
        const threads = new Map(document.threads.map((thread) => [thread.key, thread]));
        for (const result of results) {
          const previousGeneration = generations.get(result.batch.environmentId) ?? -1;
          if (result.generation !== undefined && result.generation < previousGeneration) continue;
          if (result.generation !== undefined)
            generations.set(result.batch.environmentId, result.generation);
          if (result.error) {
            sourceError = result.error;
            continue;
          }
          for (const group of result.batch.groups) {
            const root = group.members.find((member) => member.threadId === group.threadId);
            if (!root) continue;
            const key = keepAwakeThreadKey(result.batch.environmentId, group.threadId);
            if (result.local) local.add(key);
            else local.delete(key);
            if (root.removed) {
              threads.delete(key);
              observations.delete(key);
              executions.delete(key);
              finishing.delete(key);
              local.delete(key);
              continue;
            }
            const now = clock.currentTimeMillisUnsafe();
            const observation: KeepAwakeObservation = {
              key,
              title: root.title,
              observedAt: now,
              latestRunId: root.latestRunId,
              unfinished: group.members.some((member) => member.unfinished),
              needsAwake: group.members.some((member) => member.runnable),
              reason:
                group.members.find((member) => member.runnable)?.reason ??
                group.members.find((member) => member.unfinished)?.reason ??
                "Work finished",
              execution: group.members.map((member) => ({
                key: keepAwakeThreadKey(result.batch.environmentId, member.threadId),
                progressToken: member.progress,
                health: member.ownership,
                needsAwake: member.runnable,
              })),
            };
            observations.set(key, observation);
            executions.set(
              key,
              observeKeepAwakeExecution(
                executions.get(key) ?? [],
                observation.execution ?? [],
                now,
              ),
            );
            let thread = threads.get(key);
            if (
              !thread &&
              result.local &&
              document.settings.mode === "running" &&
              observation.unfinished
            )
              thread = { key, title: root.title, once: false, startedAt: null };
            if (!thread) continue;
            const session = observeKeepAwakeSession(
              thread,
              observation,
              finishing.get(key),
              enabled(key, thread.once),
            );
            if (session.completion) finishing.set(key, session.completion);
            else finishing.delete(key);
            threads.set(key, { ...session.thread, title: root.title });
          }
        }
        const next = {
          ...document,
          threads: Array.from(threads.values()).filter(
            (thread) => thread.once || thread.startedAt !== null,
          ),
        };
        if (!sameDocument(next, document)) yield* persist(next, false);
        const retained = new Set(next.threads.map((thread) => thread.key));
        for (const key of observations.keys())
          if (!retained.has(key)) {
            observations.delete(key);
            executions.delete(key);
            finishing.delete(key);
            local.delete(key);
          }
        yield* reconcile;
      }),
    );
  const handle = (
    request: KeepAwakeRequest,
    selection?: Pick<KeepAwakeObservation, "unfinished" | "latestRunId">,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (request.type === "configure")
          yield* persist(
            { ...document, settings: { mode: request.settings.mode ?? document.settings.mode } },
            true,
          );
        if (request.type === "choose") {
          const thread = document.threads.find((entry) => entry.key === request.key) ?? {
            key: request.key,
            title: request.title,
            once: false,
            startedAt: null,
          };
          const observation = observations.get(request.key);
          const next = selectKeepAwakeSession(
            thread,
            request.choice,
            selection ?? (fresh(observation) ? observation : undefined),
            clock.currentTimeMillisUnsafe(),
          );
          if (next !== thread) finishing.delete(request.key);
          yield* persist(
            {
              ...document,
              threads: [...document.threads.filter((entry) => entry.key !== request.key), next],
            },
            true,
          );
        }
        yield* reconcile;
        return state();
      }),
    );
  return {
    handle,
    accept,
    document: Effect.sync(() => document),
    tick: lock.withPermits(1)(reconcile),
    failed: Effect.sync(() => {
      sourceError =
        "Could not refresh execution status. Protection expires if updates do not resume.";
    }),
    stop: lock.withPermits(1)(
      Effect.sync(() => {
        quitting = true;
      }).pipe(Effect.andThen(release)),
    ),
  };
});
