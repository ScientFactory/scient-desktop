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

import { withOmpPromptCacheExpiry } from "../provider/omp/OmpPromptCache.ts";
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

/** A completed Scient Agent turn whose last reply carried `frame` on its message_end. */
function scientRecords(frame: unknown, earlierFrame?: unknown): IdleCompactionRecords {
  // The turn's usage merges each reply's, as the native adapter does.
  const earlier =
    earlierFrame === undefined ? {} : withOmpPromptCacheExpiry({ usedTokens: 1 }, earlierFrame);
  const tokenUsage = { ...earlier, ...withOmpPromptCacheExpiry({ usedTokens: 300_000 }, frame) };
  return {
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
}

const promptCache = (tier: "short" | "long", ttlMs: number) => ({
  type: "message_end",
  promptCache: { tier, touchedAt: NOW_MS - 60_000, ttlMs },
});

const MINUTE_MS = 60_000;

describe("Scient Agent idle compaction", () => {
  it("compacts 25 minutes after the last reply, before the idle session is released", () => {
    for (const frame of [promptCache("long", HOUR_MS), promptCache("short", 5 * MINUTE_MS)]) {
      expect(idleCompactionWindow(scientRecords(frame), NOW_MS)).toEqual({
        runId,
        startMs: NOW_MS + 25 * MINUTE_MS,
        endMs: NOW_MS + 30 * MINUTE_MS,
      });
    }
  });

  it("skips once the session would have been released", () => {
    const frame = promptCache("short", 5 * MINUTE_MS);
    expect(idleCompactionWindow(scientRecords(frame), NOW_MS + 30 * MINUTE_MS)).toBeNull();
  });

  it("never compacts a turn whose last reply confirmed no expiring cache", () => {
    expect(idleCompactionWindow(scientRecords({ type: "message_end" }), NOW_MS)).toBeNull();
    // An earlier reply's cache does not outlive a later reply that confirmed none.
    expect(
      idleCompactionWindow(
        scientRecords({ type: "message_end" }, promptCache("short", 5 * MINUTE_MS)),
        NOW_MS,
      ),
    ).toBeNull();
  });

  it("keeps the five-minute lifetime off the usage the resume chip reads", () => {
    const usage = withOmpPromptCacheExpiry({ usedTokens: 1 }, promptCache("short", 5 * MINUTE_MS));
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
