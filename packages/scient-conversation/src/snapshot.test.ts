import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";
import { MessageId, ThreadId, TurnId, type ChatAttachment } from "@t3tools/contracts";

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

  it("states warnings that agree with the snapshot's facts", () => {
    const available: ChatAttachment = {
      type: "image",
      id: "thread-1-available",
      name: "shown.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const gone: ChatAttachment = {
      type: "file",
      id: "thread-1-gone",
      name: "gone.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
    };
    const other: ChatAttachment = {
      type: "audio-note",
      id: "thread-1-other",
      name: "note.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1,
    };
    const answerGone = { ...gone, id: "thread-1-answer-gone", name: "answer.pdf" };
    const source = thread({
      messages: [
        message({ id: "m1", role: "user", text: "first", attachments: [available] }),
        message({ id: "m2", role: "assistant", text: "a", turnId: "t1" }),
        message({ id: "m3", role: "user", text: "second", attachments: [gone, other] }),
      ],
      activities: [
        activity({
          id: "q1",
          kind: "user-input.answer-submitted",
          turnId: "t1",
          payload: {
            requestId: "req",
            answers: { a: "yes" },
            attachmentsByQuestionId: { a: [answerGone] },
          },
        }),
      ],
    });
    const snapshot = snapshotOf(
      source,
      WHOLE,
      (attachment) => attachment.id === available.id || attachment.id === other.id,
    );
    expect(snapshot.omittedRunningTurn).toBeNull();
    expect(snapshot.warnings).toEqual([
      { _tag: "attachment-unavailable", name: "gone.pdf", messageN: 3 },
      { _tag: "attachment-unavailable", name: "answer.pdf", messageN: null },
    ]);

    const running = snapshotOf(runningThread());
    expect(running.warnings.filter((warning) => warning._tag === "running-turn-omitted")).toEqual([
      { _tag: "running-turn-omitted", turnId: running.omittedRunningTurn!.turnId },
    ]);
  });

  it("keeps settled-turn messages whose streaming flag went stale", () => {
    const snapshot = snapshotOf(
      thread({
        messages: [
          message({ id: "m1", role: "user", text: "q" }),
          message({
            id: "r1",
            role: "reasoning",
            text: "stranded thought",
            turnId: "t1",
            streaming: true,
          }),
          message({ id: "m2", role: "assistant", text: "answer", turnId: "t1", streaming: true }),
        ],
        latestTurn: {
          turnId: TurnId.make("t1"),
          state: "completed",
          requestedAt: "2026-09-27T14:00:00.000Z",
          startedAt: "2026-09-27T14:00:00.000Z",
          completedAt: "2026-09-27T14:05:00.000Z",
          assistantMessageId: null,
        },
      }),
      { workLog: false, reasoning: true, throughMessageId: null },
    );
    expect(snapshot.messages.map((entry) => entry.text)).toEqual(["q", "answer"]);
    expect(snapshot.reasoning.map((entry) => entry.text)).toEqual(["stranded thought"]);
    expect(snapshot.omittedRunningTurn).toBeNull();
  });
});
