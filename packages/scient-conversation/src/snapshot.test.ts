import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  SnapshotRangeError,
  buildConversationSnapshot,
  canonicalSnapshotContent,
} from "./snapshot.ts";
import {
  activity,
  message,
  resetClock,
  snapshotOf,
  thread,
  tick,
  WHOLE,
} from "./thread.test-fixtures.ts";

beforeEach(resetClock);

function runningThread() {
  const messages = [
    message({ id: "m1", role: "user", text: "first" }),
    message({ id: "m2", role: "assistant", text: "answer", turnId: "t1" }),
    message({ id: "m3", role: "user", text: "second" }),
  ];
  const requestedAt = tick();
  const live = [
    message({ id: "m4", role: "assistant", text: "partial", turnId: "t2", streaming: true }),
    message({ id: "m5", role: "assistant", text: "done part", turnId: "t2" }),
  ];
  return thread({
    messages: [...messages, ...live],
    activities: [
      activity({ id: "a1", kind: "tool.updated", turnId: "t2", payload: { title: "Live" } }),
    ],
    latestTurn: {
      turnId: TurnId.make("t2"),
      state: "running",
      requestedAt,
      startedAt: requestedAt,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("t2"),
      lastError: null,
      updatedAt: requestedAt,
    },
  });
}

describe("conversation snapshot", () => {
  it("stops at the last completed turn and warns about the running one", () => {
    const snapshot = snapshotOf(runningThread(), { ...WHOLE, workLog: true });
    expect(snapshot.messages.map((entry) => entry.text)).toEqual(["first", "answer"]);
    expect(snapshot.workLog).toEqual([]);
    expect(snapshot.omittedRunningTurn).toEqual({ turnId: "t2" });
    expect(snapshot.warnings).toEqual([{ _tag: "running-turn-omitted", turnId: "t2" }]);
    expect(snapshot.thread.provider).toBe("codex");
  });

  it("captures no work log or reasoning unless selected", () => {
    const source = thread({
      messages: [
        message({ id: "m1", role: "user", text: "q" }),
        message({ id: "r1", role: "reasoning", text: "thinking", turnId: "t1" }),
        message({ id: "m2", role: "assistant", text: "a", turnId: "t1" }),
      ],
      activities: [
        activity({ id: "a1", kind: "tool.completed", turnId: "t1", payload: { title: "Read" } }),
      ],
    });
    const clean = snapshotOf(source);
    expect(clean.reasoning).toEqual([]);
    expect(clean.workLog).toEqual([]);
    expect(clean.selection).toEqual(WHOLE);
    const full = snapshotOf(source, { workLog: true, reasoning: true, throughMessageId: null });
    expect(full.reasoning.map((entry) => entry.text)).toEqual(["thinking"]);
    expect(full.workLog.map((entry) => entry._tag)).toEqual(["tool"]);
    expect(canonicalSnapshotContent(full)).not.toBe(canonicalSnapshotContent(clean));
  });

  it("limits the range to the selected message and the rest of its turn", () => {
    const source = thread({
      messages: [
        message({ id: "m1", role: "user", text: "one" }),
        message({ id: "m2", role: "assistant", text: "two", turnId: "t1" }),
        message({ id: "m3", role: "user", text: "three" }),
        message({ id: "m4", role: "assistant", text: "four", turnId: "t2" }),
      ],
      activities: [
        activity({ id: "a1", kind: "tool.completed", turnId: "t1", payload: { title: "Early" } }),
        activity({ id: "a2", kind: "tool.completed", turnId: "t2", payload: { title: "Late" } }),
      ],
    });
    const ranged = snapshotOf(source, {
      workLog: true,
      reasoning: false,
      throughMessageId: MessageId.make("m2"),
    });
    expect(ranged.messages.map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(ranged.workLog.map((entry) => (entry._tag === "tool" ? entry.title : ""))).toEqual([
      "Early",
    ]);
    expect(() =>
      buildConversationSnapshot({
        thread: source,
        snapshotSequence: 1,
        threadSequence: 1,
        capturedAt: "2026-09-27T15:00:00.000Z",
        selection: { ...WHOLE, throughMessageId: MessageId.make("missing") },
        isAttachmentAvailable: () => true,
      }),
    ).toThrow(SnapshotRangeError);
  });

  it("keeps system messages in the snapshot and excludes content from the digest's capture fields", () => {
    const source = thread({
      messages: [
        message({ id: "m1", role: "system", text: "note" }),
        message({ id: "m2", role: "user", text: "hi" }),
      ],
    });
    const first = buildConversationSnapshot({
      thread: source,
      snapshotSequence: 1,
      threadSequence: 1,
      capturedAt: "2026-09-27T15:00:00.000Z",
      selection: WHOLE,
      isAttachmentAvailable: () => true,
    });
    const second = buildConversationSnapshot({
      thread: source,
      snapshotSequence: 99,
      threadSequence: 98,
      capturedAt: "2026-09-28T15:00:00.000Z",
      selection: WHOLE,
      isAttachmentAvailable: () => true,
    });
    expect(first.messages.map((entry) => entry.role)).toEqual(["system", "user"]);
    expect(canonicalSnapshotContent(second)).toBe(canonicalSnapshotContent(first));
  });

  it("records fork provenance", () => {
    const source = {
      ...thread({ messages: [] }),
      forkLineage: { originThreadId: ThreadId.make("origin"), baselineAssistantMessageId: null },
    };
    expect(snapshotOf(source).provenance).toEqual({ _tag: "fork", originThreadId: "origin" });
  });
});
