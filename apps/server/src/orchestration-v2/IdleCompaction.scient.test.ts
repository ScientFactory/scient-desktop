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
function scientRecords(frame: unknown): IdleCompactionRecords {
  const tokenUsage = withOmpPromptCacheExpiry({ usedTokens: 300_000 }, frame);
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

describe("Scient Agent idle compaction", () => {
  it("compacts two minutes before a one-hour cache the agent reported expires", () => {
    const expiresAt = NOW_MS - 60_000 + HOUR_MS;
    expect(idleCompactionWindow(scientRecords(promptCache("long", HOUR_MS)), NOW_MS)).toEqual({
      runId,
      startMs: expiresAt - 2 * 60_000,
      endMs: expiresAt,
    });
  });

  it("never times compaction to a five-minute cache or an agent that reports none", () => {
    expect(
      idleCompactionWindow(scientRecords(promptCache("short", 5 * 60_000)), NOW_MS),
    ).toBeNull();
    expect(idleCompactionWindow(scientRecords({ type: "message_end" }), NOW_MS)).toBeNull();
  });

  it("reads the setting a Scient Agent instance overrides", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("scient"),
          config: { idleCompaction: "beforeCacheExpires" },
        },
      },
    };
    expect(resolveIdleCompaction(settings, instanceId)).toBe("beforeCacheExpires");
  });
});
