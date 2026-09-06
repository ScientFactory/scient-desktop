/**
 * Scient-owned semantic analytics observers.
 *
 * These observers consume the canonical T3 runtime streams instead of adding
 * provider-specific or UI-click instrumentation. They retain only bounded,
 * short-lived correlation state and emit through AnalyticsService's strict
 * allowlist.
 */
import {
  isToolLifecycleItemType,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { createProviderLifecycleAnalyticsMapper } from "./ProviderLifecycleAnalytics.ts";

const MAX_CORRELATED_TURNS = 1_000;

interface RecordedAnalyticsEvent {
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

interface TurnCorrelation {
  readonly provider: string;
  readonly model: string | undefined;
  readonly startedAt: number;
  usedTools: boolean;
  hasAttachment: boolean;
  failureClass: string | undefined;
}

interface ForkCorrelation {
  readonly workspaceMode: string;
  readonly boundaryClass: "checkpoint" | "conversation";
  readonly refork: boolean;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_CORRELATED_TURNS && !map.has(key)) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function elapsedMilliseconds(startedAt: number, completedAt: string): number | undefined {
  const completion = Date.parse(completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completion) || completion < startedAt) {
    return undefined;
  }
  return completion - startedAt;
}

export function createAnalyticsEventMapper() {
  const turns = new Map<string, TurnCorrelation>();
  const pendingForks = new Map<string, ForkCorrelation>();
  const terminalTurns = new Map<string, true>();
  const terminalReverts = new Map<string, true>();

  const revertOutcome = (
    eventId: string,
    failed: boolean,
  ): ReadonlyArray<RecordedAnalyticsEvent> => {
    if (terminalReverts.has(eventId)) return [];
    boundedSet(terminalReverts, eventId, true);
    return failed
      ? [{ name: "thread.revert.failed", properties: { failureClass: "unknown" } }]
      : [{ name: "thread.revert.completed", properties: {} }];
  };

  const providerEvent = (event: ProviderRuntimeEvent): ReadonlyArray<RecordedAnalyticsEvent> => {
    const turnId = event.turnId === undefined ? undefined : String(event.turnId);
    const key = turnId === undefined ? undefined : turnKey(String(event.threadId), turnId);
    if (key !== undefined && terminalTurns.has(key)) return [];

    switch (event.type) {
      case "turn.started": {
        if (key === undefined) return [];
        boundedSet(turns, key, {
          provider: String(event.provider),
          model: event.payload.model,
          startedAt: Date.parse(event.createdAt),
          usedTools: false,
          hasAttachment: false,
          failureClass: undefined,
        });
        return [];
      }
      case "item.started": {
        if (key === undefined || !isToolLifecycleItemType(event.payload.itemType)) return [];
        const turn = turns.get(key);
        if (turn) turn.usedTools = true;
        return [];
      }
      case "runtime.error": {
        if (key === undefined) return [];
        const turn = turns.get(key);
        if (turn) turn.failureClass = event.payload.class ?? "unknown";
        return [];
      }
      case "turn.aborted": {
        if (key === undefined) return [];
        boundedSet(terminalTurns, key, true);
        const turn = turns.get(key);
        turns.delete(key);
        return [
          {
            name: "provider.turn.stopped",
            properties: {
              provider: turn?.provider ?? String(event.provider),
              model: turn?.model,
              durationMs:
                turn === undefined
                  ? undefined
                  : elapsedMilliseconds(turn.startedAt, event.createdAt),
              stopClass: "aborted",
            },
          },
        ];
      }
      case "turn.completed": {
        if (key === undefined) return [];
        boundedSet(terminalTurns, key, true);
        const turn = turns.get(key);
        turns.delete(key);
        const durationMs =
          turn === undefined ? undefined : elapsedMilliseconds(turn.startedAt, event.createdAt);
        if (event.payload.state === "cancelled" || event.payload.state === "interrupted") {
          return [
            {
              name: "provider.turn.stopped",
              properties: {
                provider: turn?.provider ?? String(event.provider),
                model: turn?.model,
                durationMs,
                stopClass: event.payload.state,
              },
            },
          ];
        }
        if (event.payload.state === "completed") {
          return [
            {
              name: "provider.turn.completed",
              properties: {
                provider: turn?.provider ?? String(event.provider),
                model: turn?.model,
                durationMs,
                usedTools: turn?.usedTools ?? false,
                hasAttachment: turn?.hasAttachment ?? false,
              },
            },
          ];
        }
        return [
          {
            name: "provider.turn.failed",
            properties: {
              provider: turn?.provider ?? String(event.provider),
              model: turn?.model,
              durationMs,
              failureClass: turn?.failureClass ?? "provider_error",
            },
          },
        ];
      }
      default:
        return [];
    }
  };

  const orchestrationEvent = (
    event: OrchestrationEvent,
    context?: { readonly refork?: boolean },
  ): ReadonlyArray<RecordedAnalyticsEvent> => {
    switch (event.type) {
      case "thread.message-sent": {
        if (
          event.payload.role !== "assistant" ||
          event.payload.turnId === null ||
          (event.payload.attachments?.length ?? 0) === 0
        ) {
          return [];
        }
        const turn = turns.get(
          turnKey(String(event.payload.threadId), String(event.payload.turnId)),
        );
        if (turn) turn.hasAttachment = true;
        return [];
      }
      case "thread.forked": {
        const newThreadId = String(event.payload.newThreadId);
        boundedSet(pendingForks, newThreadId, {
          workspaceMode: event.payload.workspaceMode,
          boundaryClass:
            event.payload.sourceCheckpointTurnCount === null ? "conversation" : "checkpoint",
          refork: context?.refork === true,
        });
        return [];
      }
      case "thread.fork-completed": {
        const threadId = String(event.payload.threadId);
        const fork = pendingForks.get(threadId);
        pendingForks.delete(threadId);
        if (!fork) return [];
        return [
          {
            name: "thread.fork.completed",
            properties: {
              workspaceMode: fork.workspaceMode,
              boundaryClass: fork.boundaryClass,
              refork: fork.refork,
            },
          },
        ];
      }
      case "thread.reverted":
        return revertOutcome(String(event.eventId), false);
      case "thread.activity-appended":
        // This kind is emitted by CheckpointReactor after a failed attempt.
        // The activity's summary/payload may contain private paths or errors.
        return event.payload.activity.kind === "checkpoint.revert.failed"
          ? revertOutcome(String(event.eventId), true)
          : [];
      default:
        return [];
    }
  };

  const clear = () => {
    turns.clear();
    pendingForks.clear();
    terminalTurns.clear();
    terminalReverts.clear();
  };
  return { orchestrationEvent, providerEvent, clear } as const;
}

/** Starts both hot-stream observers inside the caller's scope and returns immediately. */
export const launchAnalyticsEventObservers = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  if (!(yield* analytics.status).available) return;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const provider = yield* ProviderService.ProviderService;
  // Observability must not add a mandatory provider dependency to legacy/test hosts.
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  const mapper = createAnalyticsEventMapper();
  const lifecycleMapper = createProviderLifecycleAnalyticsMapper();
  let observedEpoch = yield* analytics.collectionEpoch;
  const shouldObserve = Effect.gen(function* () {
    const epoch = yield* analytics.collectionEpoch;
    if (epoch !== observedEpoch) {
      mapper.clear();
      lifecycleMapper.clear();
      observedEpoch = epoch;
    }
    const status = yield* analytics.status;
    if (status.consent !== "off") return true;
    mapper.clear();
    lifecycleMapper.clear();
    return false;
  });

  const recordAll = (events: ReadonlyArray<RecordedAnalyticsEvent>) =>
    Effect.forEach(events, (event) => analytics.record(event.name, event.properties), {
      discard: true,
    });

  if (Option.isSome(registry)) {
    if (yield* shouldObserve) {
      yield* recordAll(lifecycleMapper.observe(yield* registry.value.getProviders));
    }
    yield* Effect.forkScoped(
      Stream.runForEach(registry.value.streamChanges, (providers) =>
        shouldObserve.pipe(
          Effect.flatMap((observe) =>
            observe ? recordAll(lifecycleMapper.observe(providers)) : Effect.void,
          ),
        ),
      ),
    );
  }

  yield* Effect.forkScoped(
    Stream.runForEach(provider.streamEvents, (event) =>
      shouldObserve.pipe(
        Effect.flatMap((observe) =>
          observe ? recordAll(mapper.providerEvent(event)) : Effect.void,
        ),
      ),
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(orchestration.streamDomainEvents, (event) =>
      Effect.gen(function* () {
        if (!(yield* shouldObserve)) return;
        const refork =
          event.type === "thread.forked"
            ? yield* projectionSnapshotQuery.getThreadDetailById(event.payload.originThreadId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => false,
                    onSome: (origin) => origin.forkLineage != null,
                  }),
                ),
                Effect.orElseSucceed(() => false),
              )
            : undefined;
        yield* recordAll(
          mapper.orchestrationEvent(event, refork === undefined ? undefined : { refork }),
        );
      }),
    ),
  );
});
