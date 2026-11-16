import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  resolveIdleCompaction,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ompWarmingStopped, withOmpPromptCacheExpiry } from "../provider/omp/OmpPromptCache.ts";
import * as ServerSettings from "../serverSettings.ts";
import { idleCompactionWindow, type IdleCompactionRecords } from "./IdleCompaction.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const NOW_MS = Date.parse("2026-11-13T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("scient-idle-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("scient");
const providerThreadId = ProviderThreadId.make("provider-thread");
const messageId = MessageId.make("message-1");
const nodeId = NodeId.make("root-node");
const modelSelection = { instanceId, model: "anthropic/claude-opus-5-5" };

/**
 * A completed Scient Agent turn whose last reply carried `frame` on its message_end; `stop` is the
 * frame the agent sent when its warming stopped, at `stoppedAtMs`, recorded on the provider thread.
 */
function scientRecords(
  frame: unknown,
  options: {
    readonly earlierFrame?: unknown;
    readonly stop?: { readonly frame: unknown; readonly stoppedAtMs: number };
    readonly model?: string;
  } = {},
): IdleCompactionRecords {
  // The turn's usage merges each reply's, as the native adapter does.
  const earlier =
    options.earlierFrame === undefined
      ? {}
      : withOmpPromptCacheExpiry({ usedTokens: 1 }, options.earlierFrame);
  const tokenUsage = { ...earlier, ...withOmpPromptCacheExpiry({ usedTokens: 300_000 }, frame) };
  const promptCacheWarmingStopped =
    options.stop === undefined
      ? undefined
      : ompWarmingStopped(options.stop.frame, options.stop.stoppedAtMs);
  const records: IdleCompactionRecords = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-60_000),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-60_000),
        startedAt: at(-60_000),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Summarize these results",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-60_000),
        updatedAt: at(-60_000),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("scient"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        ...(promptCacheWarmingStopped === undefined ? {} : { promptCacheWarmingStopped }),
        createdAt: at(-60_000),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-60_000),
        completedAt: at(),
        tokenUsage: { ...tokenUsage, updatedAt: DateTime.formatIso(at()) },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  };
  // The selection the next message would run on, after a model change.
  return options.model === undefined
    ? records
    : {
        ...records,
        thread: { ...records.thread, modelSelection: { instanceId, model: options.model } },
      };
}

const promptCache = (tier: "short" | "long", ttlMs: number) => ({
  type: "message_end",
  promptCache: { tier, touchedAt: NOW_MS - 60_000, ttlMs },
});

const MINUTE_MS = 60_000;
const short = promptCache("short", 5 * MINUTE_MS);

describe("Scient Agent idle compaction", () => {
  it("compacts a one-hour cache 25 minutes after the last reply, before the session is released", () => {
    expect(idleCompactionWindow(scientRecords(promptCache("long", HOUR_MS)), NOW_MS)).toEqual({
      runId,
      startMs: NOW_MS + 25 * MINUTE_MS,
      endMs: NOW_MS + 30 * MINUTE_MS,
    });
  });

  /** The frame the agent sends when warming stops, with the entry as its last hitting refresh left it. */
  const stopFrame = (touchedAtMs: number, tier: "short" | "long" = "short") => ({
    type: "cache_warming_stopped",
    reason: "30-minute idle safety limit reached",
    promptCache: {
      tier,
      touchedAt: touchedAtMs,
      ttlMs: tier === "short" ? 5 * MINUTE_MS : HOUR_MS,
    },
  });

  it("compacts a five-minute cache as soon as warming stops on it after a long idle stretch", () => {
    // Warming still running, or never ran: no stop recorded, so the cache may be cold by any fixed time.
    expect(idleCompactionWindow(scientRecords(short), NOW_MS)).toBeNull();
    const stop = {
      frame: stopFrame(NOW_MS + 26 * MINUTE_MS),
      stoppedAtMs: NOW_MS + 29 * MINUTE_MS,
    };
    expect(idleCompactionWindow(scientRecords(short, { stop }), stop.stoppedAtMs)).toEqual({
      runId,
      startMs: stop.stoppedAtMs,
      endMs: NOW_MS + 30 * MINUTE_MS,
    });
    // Too close to the expiry of the last refresh to start reading the cache in time.
    expect(
      idleCompactionWindow(scientRecords(short, { stop }), NOW_MS + 30 * MINUTE_MS),
    ).toBeNull();
  });

  it("lets the cache go when warming stopped soon after the reply or before it", () => {
    // Its savings rule stopped warming at the first refresh: the reader may still be reading.
    const early = { frame: stopFrame(NOW_MS - MINUTE_MS), stoppedAtMs: NOW_MS + 4 * MINUTE_MS };
    expect(
      idleCompactionWindow(scientRecords(short, { stop: early }), early.stoppedAtMs),
    ).toBeNull();
    // A stop from an earlier idle stretch, recorded before this reply.
    const stale = {
      frame: stopFrame(NOW_MS - 40 * MINUTE_MS),
      stoppedAtMs: NOW_MS - 30 * MINUTE_MS,
    };
    expect(idleCompactionWindow(scientRecords(short, { stop: stale }), NOW_MS)).toBeNull();
  });

  it("records only a five-minute entry the stop frame still reports", () => {
    expect(ompWarmingStopped(stopFrame(NOW_MS), NOW_MS + MINUTE_MS)).toEqual({
      stoppedAt: DateTime.formatIso(at(MINUTE_MS)),
      expiresAt: DateTime.formatIso(at(5 * MINUTE_MS)),
    });
    // No entry (expired, or the conversation changed), or a one-hour entry with its own schedule.
    expect(ompWarmingStopped({ type: "cache_warming_stopped", reason: "x" }, NOW_MS)).toBeNull();
    expect(ompWarmingStopped(stopFrame(NOW_MS, "long"), NOW_MS)).toBeNull();
  });

  it("never compacts a turn whose last reply confirmed no expiring cache", () => {
    expect(idleCompactionWindow(scientRecords({ type: "message_end" }), NOW_MS)).toBeNull();
    // An earlier reply's cache does not outlive a later reply that confirmed none.
    expect(
      idleCompactionWindow(
        scientRecords({ type: "message_end" }, { earlierFrame: promptCache("long", HOUR_MS) }),
        NOW_MS,
      ),
    ).toBeNull();
  });

  it("does not compact after a model change the last reply's cache does not serve", () => {
    const frame = promptCache("long", HOUR_MS);
    expect(
      idleCompactionWindow(scientRecords(frame, { model: "openai-codex/gpt-6.1-sol" }), NOW_MS),
    ).toBeNull();
  });

  it("keeps the five-minute lifetime off the usage the resume chip reads", () => {
    const usage = withOmpPromptCacheExpiry({ usedTokens: 1 }, short);
    expect(usage.promptCacheTtlMs).toBeUndefined();
    expect(usage.promptCacheExpiresAt).toBeUndefined();
  });

  it("defaults a Scient Agent instance to compacting before the cache expires", () => {
    // An instance with no config entry, and the environment default untouched.
    expect(resolveIdleCompaction(DEFAULT_SERVER_SETTINGS, instanceId)).toBe("beforeCacheExpires");
    const scient = (config: object) => ({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("scient"), config },
      },
    });
    expect(resolveIdleCompaction(scient({ binaryPath: "scient-agent" }), instanceId)).toBe(
      "beforeCacheExpires",
    );
    expect(resolveIdleCompaction(scient({ idleCompaction: "off" }), instanceId)).toBe("off");
    // "Use default" follows the environment-wide mode.
    expect(resolveIdleCompaction(scient({ idleCompaction: "default" }), instanceId)).toBe(
      "onReturn",
    );
    // Claude keeps the environment default.
    expect(
      resolveIdleCompaction(DEFAULT_SERVER_SETTINGS, ProviderInstanceId.make("claudeAgent")),
    ).toBe("onReturn");
  });

  it.effect(
    "compacts once when the warming stop reaches the server, long after the run completed",
    () =>
      Effect.gen(function* () {
        const stop = {
          frame: stopFrame(NOW_MS + 26 * MINUTE_MS),
          stoppedAtMs: NOW_MS + 29 * MINUTE_MS,
        };
        yield* TestClock.setTime(stop.stoppedAtMs);
        const value = scientRecords(short, { stop });
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const seeded = { threadId, occurredAt: at() };
        for (const [index, event] of [
          { type: "thread.created", payload: value.thread },
          { type: "run.created", payload: value.runs[0]! },
          { type: "message.updated", payload: value.messages[0]! },
          { type: "provider-turn.updated", payload: value.providerTurns[0]! },
          { type: "provider-thread.updated", payload: value.providerThreads[0]! },
        ].entries())
          yield* store.apply({ ...seeded, ...event, id: EventId.make(`e${index}`) } as Parameters<
            typeof store.apply
          >[0]);
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
        const dependencies = Layer.mergeAll(
          Layer.succeed(ProjectionStore.ProjectionStoreV2, store),
          Layer.mock(ServerSettings.ServerSettingsService)({
            // Nothing configured: Scient Agent's own default compacts before the cache expires.
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
            dispatch: (command) =>
              Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* IdleCompactionService.make;
          yield* service.start();
          // The run's completion is long past; only the thread's warming stop arrives now, twice.
          const warmingStopped = {
            type: "provider-thread.updated" as const,
            threadId,
            occurredAt: DateTime.makeUnsafe(stop.stoppedAtMs),
            payload: value.providerThreads[0]!,
          };
          yield* Queue.offer(events, { ...warmingStopped, id: EventId.make("stopped-1") });
          yield* Queue.offer(events, { ...warmingStopped, id: EventId.make("stopped-2") });
          const first = yield* Queue.take(commands);
          expect(first).toMatchObject({ type: "message.dispatch", threadId, text: "/compact" });
          yield* TestClock.adjust("1 minute");
          // A repeat names the same command, which the orchestrator applies once.
          const repeats = yield* Queue.takeAll(commands);
          expect(
            new Set(
              [first, ...repeats].map((command) => "commandId" in command && command.commandId),
            ),
          ).toEqual(new Set([`server:idle-compact:${threadId}:${runId}`]));
        }).pipe(Effect.provide(dependencies));
      }).pipe(
        Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
        Effect.scoped,
      ),
  );
});
