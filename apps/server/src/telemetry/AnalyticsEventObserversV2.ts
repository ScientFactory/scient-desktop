import type {
  OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { AnalyticsService } from "./AnalyticsService.ts";
import { createProviderLifecycleAnalyticsMapper } from "./ProviderLifecycleAnalytics.ts";

type Observation = {
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
};
type EventContext = { readonly driver?: ProviderDriverKind; readonly refork?: boolean };
const CAPACITY = 1_000;
function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  if (!map.has(key) && map.size >= CAPACITY) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Correlates only live V2 outcomes. Private identifiers never enter emitted properties. */
export function createV2AnalyticsEventMapper() {
  const runs = new Map<
    string,
    {
      provider: string;
      model: string;
      startedAt: number;
      usedTools: boolean;
      hasAttachment: boolean;
      failureClass?: string;
    }
  >();
  const terminals = new Map<string, true>();
  const forks = new Map<
    string,
    { workspaceMode: string; boundaryClass: string; refork: boolean }
  >();
  const rollbacks = new Map<string, string>();
  const reverted = new Map<string, true>();
  const event = (
    entry: OrchestrationV2DomainEvent,
    context: EventContext = {},
  ): ReadonlyArray<Observation> => {
    if (entry.type === "run.created" || entry.type === "run.updated") {
      const run = entry.payload;
      const key = run.id;
      if (terminals.has(key)) return [];
      const driver = entry.driver ?? context.driver;
      if (
        (run.status === "running" || run.status === "waiting") &&
        run.startedAt !== null &&
        driver !== undefined &&
        !runs.has(key)
      ) {
        remember(runs, key, {
          provider: driver,
          model: run.modelSelection.model,
          startedAt: DateTime.toEpochMillis(run.startedAt),
          usedTools: false,
          hasAttachment: false,
        });
      }
      if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return [];
      remember(terminals, key, true);
      const correlation = runs.get(key);
      runs.delete(key);
      // A historical/consent-boundary terminal or failed workspace preparation
      // is not evidence of an observed provider turn.
      if (correlation === undefined) return [];
      const elapsed = DateTime.toEpochMillis(entry.occurredAt) - correlation.startedAt;
      const properties = {
        provider: correlation.provider,
        model: correlation.model,
        durationMs: elapsed >= 0 ? elapsed : undefined,
      };
      return run.status === "completed"
        ? [
            {
              name: "provider.turn.completed",
              properties: {
                ...properties,
                usedTools: correlation.usedTools,
                hasAttachment: correlation.hasAttachment,
              },
            },
          ]
        : run.status === "failed"
          ? [
              {
                name: "provider.turn.failed",
                properties: {
                  ...properties,
                  failureClass: correlation.failureClass ?? "provider_error",
                },
              },
            ]
          : [
              {
                name: "provider.turn.stopped",
                properties: { ...properties, stopClass: run.status },
              },
            ];
    }
    if (entry.type === "turn-item.updated") {
      const item = entry.payload;
      const run = item.runId === null ? undefined : runs.get(item.runId);
      if (run !== undefined) {
        if (
          [
            "command_execution",
            "dynamic_tool",
            "file_change",
            "file_search",
            "web_search",
            "subagent",
          ].includes(item.type)
        )
          run.usedTools = true;
        if (item.type === "error") run.failureClass = item.failure.class;
      }
    }
    if (
      entry.type === "message.updated" &&
      entry.payload.role === "assistant" &&
      entry.payload.runId !== null &&
      entry.payload.attachments.length > 0
    ) {
      const run = runs.get(entry.payload.runId);
      if (run !== undefined) run.hasAttachment = true;
    }
    if (entry.type === "thread.created") {
      const fork = entry.payload.conversationFork;
      if (fork?.status === "pending")
        remember(forks, entry.threadId, {
          workspaceMode: fork.workspaceMode,
          boundaryClass: fork.checkpointRef === null ? "conversation" : "checkpoint",
          refork: context.refork === true,
        });
    }
    if (entry.type === "thread.metadata-updated") {
      const thread = entry.payload;
      const fork = forks.get(entry.threadId);
      if (fork !== undefined && thread.conversationFork?.status === "ready") {
        forks.delete(entry.threadId);
        return [{ name: "thread.fork.completed", properties: fork }];
      }
      const completed = thread.rollbackCompletedRequestId;
      const failure = thread.rollbackFailure;
      if (
        thread.rollbackRequestId !== undefined &&
        completed !== thread.rollbackRequestId &&
        failure?.requestId !== thread.rollbackRequestId
      )
        remember(rollbacks, entry.threadId, thread.rollbackRequestId);
      if (
        completed != null &&
        rollbacks.get(entry.threadId) === completed &&
        !reverted.has(completed)
      ) {
        remember(reverted, completed, true);
        return [{ name: "thread.revert.completed", properties: {} }];
      }
      if (
        failure != null &&
        rollbacks.get(entry.threadId) === failure.requestId &&
        !reverted.has(failure.requestId)
      ) {
        remember(reverted, failure.requestId, true);
        return [{ name: "thread.revert.failed", properties: { failureClass: "unknown" } }];
      }
    }
    return [];
  };
  const clear = () => {
    runs.clear();
    terminals.clear();
    forks.clear();
    rollbacks.clear();
    reverted.clear();
  };
  return { event, clear };
}

/** Native event and lifecycle observers share one consent and deletion fence. */
export const makeV2AnalyticsObservers = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const mapper = createV2AnalyticsEventMapper();
  const lifecycle = createProviderLifecycleAnalyticsMapper();
  let epoch = yield* analytics.collectionEpoch;
  const enabled = Effect.gen(function* () {
    const next = yield* analytics.collectionEpoch;
    const status = yield* analytics.status;
    if (next !== epoch || !status.available || status.consent === "off") {
      mapper.clear();
      lifecycle.clear();
      epoch = next;
    }
    return status.available && status.consent !== "off";
  });
  const record = (observations: ReadonlyArray<Observation>) =>
    Effect.forEach(observations, (entry) => analytics.record(entry.name, entry.properties), {
      discard: true,
    });
  return {
    enabled,
    event: (entry: OrchestrationV2DomainEvent, context?: EventContext) =>
      enabled.pipe(
        Effect.flatMap((allow) => (allow ? record(mapper.event(entry, context)) : Effect.void)),
      ),
    providers: (snapshot: ReadonlyArray<ServerProvider>) =>
      enabled.pipe(
        Effect.flatMap((allow) => (allow ? record(lifecycle.observe(snapshot)) : Effect.void)),
      ),
  };
});

/** Disabled hosts acquire no observers; only live committed V2 events are observed. */
export const launchV2AnalyticsEventObservers = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  if (!(yield* analytics.status).available) return;
  const orchestration = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry;
  const observer = yield* makeV2AnalyticsObservers;
  yield* observer.providers(yield* providers.getProviders);
  yield* providers.streamChanges.pipe(Stream.runForEach(observer.providers), Effect.forkScoped);
  yield* orchestration.streamDomainEvents.pipe(
    Stream.runForEach((entry) =>
      Effect.gen(function* () {
        if (!(yield* observer.enabled)) return;
        const instanceId =
          entry.type === "run.updated" || entry.type === "run.created"
            ? entry.payload.providerInstanceId
            : undefined;
        const instance =
          instanceId === undefined ? undefined : yield* instances.getInstance(instanceId);
        const fork = entry.type === "thread.created" ? entry.payload.conversationFork : undefined;
        const origin =
          fork?.status === "pending"
            ? yield* projections
                .getThreadShell(fork.sourceThreadId)
                .pipe(Effect.orElseSucceed(() => null))
            : null;
        yield* observer.event(entry, {
          ...(instance === undefined ? {} : { driver: instance.driverKind }),
          ...(origin === null ? {} : { refork: origin.forkLineage != null }),
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Native analytics observer stopped", { cause })),
    Effect.forkScoped,
  );
});
