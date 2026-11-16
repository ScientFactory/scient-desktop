import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
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

import { ompWarmingStopExpiry, withOmpPromptCacheExpiry } from "../provider/omp/OmpPromptCache.ts";
import { idleCompactionWindow, type IdleCompactionRecords } from "./IdleCompaction.ts";

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
 * A completed Scient Agent turn whose last reply carried `frame` on its message_end; `warmUntil`
 * is the expiry the agent's stopped idle warming left on a five-minute cache.
 */
function scientRecords(
  frame: unknown,
  options: {
    readonly earlierFrame?: unknown;
    readonly warmUntil?: number;
    readonly model?: string;
  } = {},
): IdleCompactionRecords {
  // The turn's usage merges each reply's, as the native adapter does.
  const earlier =
    options.earlierFrame === undefined
      ? {}
      : withOmpPromptCacheExpiry({ usedTokens: 1 }, options.earlierFrame);
  const tokenUsage = {
    ...earlier,
    ...withOmpPromptCacheExpiry({ usedTokens: 300_000 }, frame),
    ...(options.warmUntil === undefined
      ? {}
      : { promptCacheExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(options.warmUntil)) }),
  };
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

  it("compacts a five-minute cache only once the agent's idle warming stopped on it", () => {
    // Warming still running, or never ran: the cache may be cold by any fixed time.
    expect(idleCompactionWindow(scientRecords(short), NOW_MS)).toBeNull();
    const warmUntil = NOW_MS + 31 * MINUTE_MS;
    expect(
      idleCompactionWindow(scientRecords(short, { warmUntil }), NOW_MS + 27 * MINUTE_MS),
    ).toEqual({ runId, startMs: NOW_MS, endMs: warmUntil - MINUTE_MS });
    // Too close to the expiry to start reading the cache in time.
    expect(
      idleCompactionWindow(scientRecords(short, { warmUntil }), warmUntil - MINUTE_MS),
    ).toBeNull();
  });

  it("reads the expiry only from a refresh that hit and stopped idle warming", () => {
    const stop = {
      type: "cache_warming_end",
      phase: "idle",
      outcome: "hit",
      warmingStopReason: "30-minute idle safety limit reached",
    };
    const ttl = 5 * MINUTE_MS;
    expect(ompWarmingStopExpiry(stop, ttl, NOW_MS)).toBe(
      DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + ttl)),
    );
    for (const event of [
      { ...stop, warmingStopReason: undefined },
      { ...stop, outcome: "miss" },
      { ...stop, phase: "streaming" },
    ])
      expect(ompWarmingStopExpiry(event, ttl, NOW_MS)).toBeUndefined();
    // The last reply confirmed no five-minute cache.
    expect(ompWarmingStopExpiry(stop, undefined, NOW_MS)).toBeUndefined();
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
});
