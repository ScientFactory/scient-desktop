import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ServerProvider,
  ScientConversationFork,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { AnalyticsService } from "./AnalyticsService.ts";
import { ScientAnalyticsAvailability } from "./ScientAnalytics.ts";
import { analyticsRunRef } from "./AnalyticsRunRef.ts";
import { createProviderAccountAnalyticsMapper } from "./ProviderAccountAnalytics.ts";
import { createProviderExtensionAnalyticsMapper } from "./ExtensionAnalytics.ts";
import { createProviderLifecycleAnalyticsMapper } from "./ProviderLifecycleAnalytics.ts";
import { classifyCommand, shellCommandOf } from "./CommandCategories.ts";
import {
  BrowserToolCalls,
  browserTurnSummary,
  type BrowserToolCallLedger,
} from "./ScientMcpAnalytics.ts";
import { analyticsFailureClass, analyticsFailureCode, modelKey } from "@scientfactory/analytics";

type Observation = {
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
};
type EventContext = {
  readonly driver?: ProviderDriverKind;
  readonly refork?: boolean;
  /** SCIENT-FORK: the fork's own setup state, read when its thread event is observed. */
  readonly conversationFork?: ScientConversationFork | null;
  /** The provider runtime's own version, such as Scient Agent's. */
  readonly providerVersion?: string;
};

const CAPACITY = 1_000;
const MAX_COMMANDS_PER_RUN = 10_000;
/** Scient's own progress rows, written as commands; they are not an agent's program. */
const SYNTHETIC_COMMANDS = new Set(["Preparing workspace"]);
const SYNTHETIC_COMMAND_TITLES = new Set(["Provider signed out"]);
type CommandTally = { count: number; failed: number; stopped: number };
type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { type: "error" }>;
/**
 * One retry row's attempts. A row is updated as its attempt rises and settles when the request
 * recovers or gives up; some providers reuse a settled row for the next retry cycle.
 */
type RetryRow = { settledAttempts: number; attempt: number; settled: boolean };
const MAX_ERROR_ITEMS_PER_RUN = 1_000;
function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  if (!map.has(key) && map.size >= CAPACITY) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/**
 * Reported retry attempts across a row's cycles: each cycle counts its highest attempt once, and a
 * settled row that starts running again begins a new cycle.
 */
function countRetry(retries: Map<string, RetryRow>, item: ErrorTurnItem) {
  const attempt = item.retry?.attempt ?? 0;
  let row = retries.get(item.id);
  if (row === undefined) {
    if (retries.size >= MAX_ERROR_ITEMS_PER_RUN) return;
    row = { settledAttempts: 0, attempt: 0, settled: false };
    retries.set(item.id, row);
  }
  if (row.settled && item.status === "running") {
    row.settledAttempts += row.attempt;
    row.attempt = 0;
  }
  row.attempt = Math.max(row.attempt, attempt);
  row.settled = item.status !== "running";
}

const TERMINAL_ITEM_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Tallies an agent's own terminal command once, when it ends; only its category is kept. */
function countCommand(
  run: { commands: Map<string, CommandTally>; countedCommands: Set<string> },
  item: Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>["payload"],
) {
  if (!TERMINAL_ITEM_STATUSES.has(item.status) || run.countedCommands.has(item.id)) return;
  if (run.countedCommands.size >= MAX_COMMANDS_PER_RUN) return;
  const command = shellCommandOf(item);
  if (command === undefined) return;
  if (SYNTHETIC_COMMANDS.has(command) || SYNTHETIC_COMMAND_TITLES.has(item.title ?? "")) return;
  run.countedCommands.add(item.id);
  const stopped = item.status === "cancelled" || item.status === "interrupted";
  const failed =
    !stopped &&
    (item.status === "failed" ||
      (item.type === "command_execution" &&
        ((item.exitCode !== undefined && item.exitCode !== 0) ||
          item.outputIndicatesFailure === true)));
  for (const category of classifyCommand(command)) {
    const tally = run.commands.get(category) ?? { count: 0, failed: 0, stopped: 0 };
    tally.count += 1;
    if (failed) tally.failed += 1;
    if (stopped) tally.stopped += 1;
    run.commands.set(category, tally);
  }
}

/** Correlates live V2 admissions, steering and outcomes; IDs stay in bounded local maps. */
export function createV2AnalyticsEventMapper(browserCalls?: BrowserToolCallLedger) {
  const submissions = new Map<string, true>();
  const runMetadata = new Map<
    string,
    {
      instanceId: string;
      model: string;
      runtimeMode: string | undefined;
      interactionMode: string | undefined;
    }
  >();
  const runs = new Map<
    string,
    {
      provider: string;
      model: string;
      providerVersion: string | undefined;
      /** Null until the run starts; a run can fail while its session is still opening. */
      startedAt: number | null;
      usedTools: boolean;
      hasAttachment: boolean;
      rootNodeId: string | null;
      /** Each error row's latest state, so a recovered retry stops counting as the failure. */
      errors: Map<string, ErrorTurnItem>;
      retries: Map<string, RetryRow>;
      commands: Map<string, CommandTally>;
      countedCommands: Set<string>;
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
    if (
      entry.type === "turn-item.updated" &&
      entry.payload.type === "user_message" &&
      entry.payload.inputIntent === "steer" &&
      entry.payload.inputAlreadyAdmitted === false
    ) {
      const item = entry.payload;
      const driver = entry.driver ?? context.driver;
      if (
        item.runId === null ||
        driver === undefined ||
        submissions.has(item.messageId) ||
        item.startedAt === null ||
        DateTime.toEpochMillis(item.startedAt) !== DateTime.toEpochMillis(entry.occurredAt)
      )
        return [];
      remember(submissions, item.messageId, true);
      const known = runMetadata.get(item.runId);
      const metadata = known?.instanceId === entry.providerInstanceId ? known : undefined;
      return [
        {
          name: "provider.turn.sent",
          properties: {
            provider: driver,
            model: metadata?.model,
            runtimeMode: metadata?.runtimeMode,
            interactionMode: metadata?.interactionMode,
          },
        },
      ];
    }
    if (entry.type === "run.created" || entry.type === "run.updated") {
      const run = entry.payload;
      const key = run.id;
      if (terminals.has(key)) return [];
      const driver = entry.driver ?? context.driver;
      if (
        entry.type === "run.created" &&
        (run.legacyQueue !== undefined || run.restartContinuationOfRunId !== undefined)
      )
        remember(submissions, run.userMessageId, true);
      remember(runMetadata, key, {
        instanceId: run.providerInstanceId,
        model: run.modelSelection.model,
        runtimeMode: run.runtimeMode,
        interactionMode: run.interactionMode,
      });
      const observations: Observation[] = [];
      if (
        entry.type === "run.created" &&
        driver !== undefined &&
        !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status) &&
        !submissions.has(run.userMessageId)
      ) {
        remember(submissions, run.userMessageId, true);
        observations.push({
          name: "provider.turn.sent",
          properties: {
            provider: driver,
            model: run.modelSelection.model,
            runtimeMode: run.runtimeMode,
            interactionMode: run.interactionMode,
          },
        });
      }
      const live = !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
        run.status,
      );
      const known = runs.get(key);
      if (known !== undefined) {
        known.rootNodeId = run.rootNodeId;
        if (known.startedAt === null && run.startedAt !== null)
          known.startedAt = DateTime.toEpochMillis(run.startedAt);
      } else if (
        driver !== undefined &&
        (entry.type === "run.created"
          ? live
          : (run.status === "running" || run.status === "waiting") && run.startedAt !== null)
      ) {
        // A run seen from its creation is followed even if it never starts, so a failure to open
        // its session is reported too. Older runs are followed from when they start running.
        remember(runs, key, {
          provider: driver,
          model: run.modelSelection.model,
          providerVersion: context.providerVersion,
          startedAt: run.startedAt === null ? null : DateTime.toEpochMillis(run.startedAt),
          usedTools: false,
          hasAttachment: false,
          rootNodeId: run.rootNodeId,
          errors: new Map(),
          retries: new Map(),
          commands: new Map(),
          countedCommands: new Set<string>(),
        });
      }
      if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status))
        return observations;
      runMetadata.delete(key);
      remember(terminals, key, true);
      const browser = browserCalls?.take(entry.threadId, DateTime.toEpochMillis(entry.occurredAt));
      const correlation = runs.get(key);
      runs.delete(key);
      // A historical terminal is not evidence of an observed provider turn.
      if (correlation === undefined) return [];
      // A run that never started only matters when it failed: stopping a queued run is not a turn.
      if (correlation.startedAt === null && run.status !== "failed") return [];
      const elapsed =
        correlation.startedAt === null
          ? undefined
          : DateTime.toEpochMillis(entry.occurredAt) - correlation.startedAt;
      const properties = {
        provider: correlation.provider,
        model: correlation.model,
        runRef: analyticsRunRef(key),
        ...(correlation.providerVersion === undefined
          ? {}
          : { providerVersion: correlation.providerVersion }),
        durationMs: elapsed !== undefined && elapsed >= 0 ? elapsed : undefined,
        ...(browser === undefined
          ? {}
          : { browserToolCalls: browser.calls, browserToolFailures: browser.failures }),
      };
      const commands: Observation[] = [...correlation.commands].map(([category, tally]) => ({
        name: "provider.commands.observed",
        properties: {
          provider: correlation.provider,
          model: correlation.model,
          commandCategory: category,
          commandCount: tally.count,
          failedCount: tally.failed,
          ...(tally.stopped > 0 ? { stoppedCount: tally.stopped } : {}),
        },
      }));
      let retryAttempts = 0;
      for (const row of correlation.retries.values())
        retryAttempts += row.settledAttempts + row.attempt;
      const failure = latestRootProviderFailure(run, [...correlation.errors.values()]);
      const failureCode = analyticsFailureCode(correlation.provider, failure?.code ?? null);
      const outcome: Observation[] =
        run.status === "completed"
          ? [
              {
                name: "provider.turn.completed",
                properties: {
                  ...properties,
                  usedTools: correlation.usedTools,
                  hasAttachment: correlation.hasAttachment,
                  retryAttempts,
                },
              },
            ]
          : run.status === "failed"
            ? [
                {
                  name: "provider.turn.failed",
                  properties: {
                    ...properties,
                    // A run that failed before starting without a provider failure (its
                    // workspace could not be prepared, say) is not the provider's error.
                    failureClass: analyticsFailureClass(
                      correlation.provider,
                      failure?.class ??
                        (correlation.startedAt === null ? "unknown" : "provider_error"),
                      failureCode,
                    ),
                    started: correlation.startedAt !== null,
                    ...(failureCode === undefined ? {} : { failureCode }),
                    ...(failure?.httpStatus === undefined
                      ? {}
                      : { httpStatus: failure.httpStatus }),
                    ...(failure?.toolServerOwner === undefined
                      ? {}
                      : { toolServerOwner: failure.toolServerOwner }),
                    retryAttempts,
                  },
                },
              ]
            : [
                {
                  name: "provider.turn.stopped",
                  properties: { ...properties, stopClass: run.status },
                },
              ];
      // One summary per turn that used the browser: the turn event keeps only its two counts.
      const browserSummary: Observation[] =
        browser === undefined || browser.calls === 0
          ? []
          : [
              {
                name: "browser.turn.summary",
                properties: {
                  provider: correlation.provider,
                  modelKey: modelKey(correlation.model),
                  runRef: properties.runRef,
                  turnOutcome: run.status,
                  ...browserTurnSummary(browser.entries),
                },
              },
            ];
      return [...outcome, ...commands, ...browserSummary];
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
        if (item.type === "error") {
          // The run's failure is its root node's; retries are counted wherever the run made them,
          // since native retry rows sit on their own nodes.
          if (
            item.nodeId === run.rootNodeId &&
            (run.errors.has(item.id) || run.errors.size < MAX_ERROR_ITEMS_PER_RUN)
          )
            run.errors.set(item.id, item);
          if (item.retry !== undefined) countRetry(run.retries, item);
        }
        countCommand(run, item);
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
      const fork = context.conversationFork;
      // A new worktree is set up after the fork commits; it completes when the setup is ready.
      if (fork?.workspaceMode === "new-worktree")
        remember(forks, entry.threadId, {
          workspaceMode: fork.workspaceMode,
          boundaryClass: fork.checkpointRef === null ? "conversation" : "checkpoint",
          refork: context.refork === true,
        });
    }
    if (entry.type === "thread.metadata-updated") {
      const thread = entry.payload;
      const fork = forks.get(entry.threadId);
      if (fork !== undefined && context.conversationFork?.status === "ready") {
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
    browserCalls?.clear();
    submissions.clear();
    runMetadata.clear();
    runs.clear();
    terminals.clear();
    forks.clear();
    rollbacks.clear();
    reverted.clear();
  };
  return { event, clear };
}

/** Native event and lifecycle observers share one availability gate. */
export const makeV2AnalyticsObservers = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const mapper = createV2AnalyticsEventMapper(yield* BrowserToolCalls);
  const lifecycle = createProviderLifecycleAnalyticsMapper();
  const accounts = createProviderAccountAnalyticsMapper();
  const extensions = createProviderExtensionAnalyticsMapper();
  const availability = yield* ScientAnalyticsAvailability;
  const enabled = Effect.sync(() => {
    const { available } = availability;
    if (!available) {
      mapper.clear();
      lifecycle.clear();
      accounts.clear();
      extensions.clear();
    }
    return available;
  });
  const record = (observations: ReadonlyArray<Observation>) =>
    Effect.forEach(observations, (entry) => analytics.record(entry.name, entry.properties), {
      discard: true,
    });
  const event = Effect.fn("V2AnalyticsObservers.event")(function* (
    entry: OrchestrationV2DomainEvent,
    context?: EventContext,
  ) {
    if (!(yield* enabled)) return;
    yield* record(mapper.event(entry, context));
  });
  const providers = Effect.fn("V2AnalyticsObservers.providers")(function* (
    snapshot: ReadonlyArray<ServerProvider>,
  ) {
    if (!(yield* enabled)) return;
    yield* record(lifecycle.observe(snapshot));
    yield* record(accounts.observe(snapshot));
    yield* record(extensions.observe(snapshot));
  });
  return { enabled, event, providers };
});

/** Disabled hosts acquire no observers; only live committed V2 events are observed. */
export const launchV2AnalyticsEventObservers = Effect.gen(function* () {
  if (!(yield* ScientAnalyticsAvailability).available) return;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry;
  const observer = yield* makeV2AnalyticsObservers;
  // Only events committed after the observers start count; earlier ones are history.
  const cutoff = yield* sink
    .latestSequence()
    .pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "Analytics collection watermark unavailable; observation remains fenced",
        ).pipe(Effect.as(-1)),
      ),
    );
  // Each instance's runtime version, so an outcome says which agent build produced it.
  const versions = new Map<string, string>();
  const observeProviders = (snapshot: ReadonlyArray<ServerProvider>) => {
    versions.clear();
    for (const provider of snapshot)
      if (provider.version !== null) versions.set(provider.instanceId, provider.version);
    return observer.providers(snapshot);
  };
  yield* observeProviders(yield* providers.getProviders);
  yield* providers.streamChanges.pipe(Stream.runForEach(observeProviders), Effect.forkScoped);
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) return;
  yield* sink.stream({ afterSequence: cutoff }).pipe(
    Stream.runForEach((stored) =>
      Effect.gen(function* () {
        if (stored.sequence <= cutoff) return;
        if (!(yield* observer.enabled)) return;
        const entry = stored.event;
        const instanceId =
          entry.type === "run.updated" || entry.type === "run.created"
            ? entry.payload.providerInstanceId
            : entry.providerInstanceId;
        const instance =
          instanceId === undefined ? undefined : yield* instances.getInstance(instanceId);
        const providerVersion = instanceId === undefined ? undefined : versions.get(instanceId);
        const fork =
          entry.type === "thread.created" || entry.type === "thread.metadata-updated"
            ? yield* projections
                .getConversationFork(entry.threadId)
                .pipe(Effect.orElseSucceed(() => null))
            : null;
        const origin =
          entry.type === "thread.created" && fork?.workspaceMode === "new-worktree"
            ? yield* projections
                .getThreadShell(fork.sourceThreadId)
                .pipe(Effect.orElseSucceed(() => null))
            : null;
        yield* observer.event(entry, {
          ...(instance === undefined ? {} : { driver: instance.driverKind }),
          ...(providerVersion === undefined ? {} : { providerVersion }),
          ...(origin === null ? {} : { refork: origin.forkLineage != null }),
          ...(fork === null ? {} : { conversationFork: fork }),
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Native analytics observer stopped", { cause })),
    Effect.forkScoped,
  );
}).pipe(Effect.catchCause(() => Effect.logWarning("Native analytics observer could not start")));
