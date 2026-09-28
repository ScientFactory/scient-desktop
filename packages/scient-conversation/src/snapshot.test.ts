import { describe, expect, it } from "@effect/vitest";
import { beforeEach } from "vite-plus/test";
import {
  ConversationSnapshotV1,
  MessageId,
  ThreadId,
  TurnId,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  SnapshotRangeError,
  buildConversationSnapshot,
  canonicalSnapshotContent,
  selectConversationContent,
  selectedConversationAttachments,
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

  it("rejects a range that does not end at a completed message", () => {
    const source = thread({ messages: [message({ id: "m1", role: "user", text: "one" })] });
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

  describe("up to a message", () => {
    const through = (id: string) => ({
      workLog: true,
      reasoning: true,
      throughMessageId: MessageId.make(id),
    });
    const titles = (snapshot: ConversationSnapshotV1) =>
      snapshot.workLog.map((entry) => (entry._tag === "tool" ? entry.title : entry._tag));
    const tool = (id: string, turnId: string, title: string) =>
      activity({ id, kind: "tool.completed", turnId, payload: { title } });
    const plan = (id: string, turnId: string, markdown: string) => {
      const at = tick();
      return {
        id,
        turnId: TurnId.make(turnId),
        planMarkdown: markdown,
        implementedAt: null,
        implementationThreadId: null,
        createdAt: at,
        updatedAt: at,
      };
    };

    it("ends at a steering message, leaving out the rest of the turn it interrupted", () => {
      const m1 = message({ id: "m1", role: "user", text: "start" });
      const early = tool("a1", "t1", "Before steer");
      const r1 = message({ id: "r1", role: "reasoning", text: "early thought", turnId: "t1" });
      const m2 = message({ id: "m2", role: "assistant", text: "working", turnId: "t1" });
      const earlyPlan = plan("p1", "t1", "Early plan");
      const steer = message({ id: "m3", role: "user", text: "change course" });
      const late = tool("a2", "t1", "After steer");
      const r2 = message({ id: "r2", role: "reasoning", text: "late thought", turnId: "t1" });
      const latePlan = plan("p2", "t1", "Late plan");
      const m4 = message({ id: "m4", role: "assistant", text: "done", turnId: "t1" });
      const snapshot = snapshotOf(
        thread({
          messages: [m1, r1, m2, steer, r2, m4],
          activities: [early, late],
          proposedPlans: [earlyPlan, latePlan],
        }),
        through("m3"),
      );
      expect(snapshot.messages.map((entry) => entry.text)).toEqual([
        "start",
        "working",
        "change course",
      ]);
      expect(titles(snapshot)).toEqual(["Before steer"]);
      expect(snapshot.reasoning.map((entry) => entry.text)).toEqual(["early thought"]);
      expect(snapshot.proposedPlans.map((entry) => entry.markdown)).toEqual(["Early plan"]);
    });

    it("ends at a chosen prompt, before any of the work it started", () => {
      const snapshot = snapshotOf(
        thread({
          messages: [
            message({ id: "m1", role: "user", text: "one" }),
            message({ id: "m2", role: "assistant", text: "two", turnId: "t1" }),
            message({ id: "m3", role: "user", text: "three" }),
            message({ id: "r1", role: "reasoning", text: "thinking about three", turnId: "t2" }),
            message({ id: "m4", role: "assistant", text: "four", turnId: "t2" }),
          ],
          activities: [tool("a1", "t2", "Work for three")],
        }),
        through("m3"),
      );
      expect(snapshot.messages.map((entry) => entry.text)).toEqual(["one", "two", "three"]);
      expect(snapshot.workLog).toEqual([]);
      expect(snapshot.reasoning).toEqual([]);
    });

    it("keeps an answer's own work up to it and nothing recorded later in its turn", () => {
      const m1 = message({ id: "m1", role: "user", text: "q" });
      const r1 = message({ id: "r1", role: "reasoning", text: "first", turnId: "t1" });
      const before = tool("a1", "t1", "Before");
      const m2 = message({ id: "m2", role: "assistant", text: "interim", turnId: "t1" });
      const sameTime = activity({
        id: "a2",
        kind: "tool.completed",
        turnId: "t1",
        payload: { title: "Same time" },
        at: m2.createdAt,
      });
      const after = tool("a3", "t1", "After");
      const r2 = message({ id: "r2", role: "reasoning", text: "second", turnId: "t1" });
      const m3 = message({ id: "m3", role: "assistant", text: "final", turnId: "t1" });
      const ranged = snapshotOf(
        thread({ messages: [m1, r1, m2, r2, m3], activities: [before, sameTime, after] }),
        through("m2"),
      );
      expect(ranged.messages.map((entry) => entry.text)).toEqual(["q", "interim"]);
      expect(titles(ranged)).toEqual(["Before"]);
      expect(ranged.reasoning.map((entry) => entry.text)).toEqual(["first"]);
    });

    it("leaves out answers and their attachments given after the chosen message", () => {
      const answerFile: ChatAttachment = {
        type: "file",
        id: "thread-1-answer",
        name: "answer.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
      };
      const laterFile: ChatAttachment = { ...answerFile, id: "thread-1-later", name: "later.pdf" };
      const source = thread({
        messages: [message({ id: "m1", role: "user", text: "go" })],
        activities: [
          activity({
            id: "q1",
            kind: "user-input.requested",
            turnId: "t1",
            payload: { requestId: "req", questions: [{ id: "a", question: "Which?" }] },
          }),
        ],
      });
      const m2 = message({ id: "m2", role: "assistant", text: "asked", turnId: "t1" });
      const answered = activity({
        id: "q2",
        kind: "user-input.answer-submitted",
        turnId: "t1",
        payload: {
          requestId: "req",
          answers: { a: "this" },
          attachmentsByQuestionId: { a: [answerFile] },
        },
      });
      const asyncAnswer = message({
        id: "async-answer:req",
        role: "user",
        text: "this",
        attachments: [answerFile],
      });
      const m3 = message({ id: "m3", role: "user", text: "next", attachments: [laterFile] });
      const full = {
        ...source,
        messages: [...source.messages, m2, asyncAnswer, m3],
        activities: [...source.activities, answered],
      };

      const whole = snapshotOf(full, { ...WHOLE, workLog: true });
      expect(whole.questionAnswers.map((answer) => answer.id)).toEqual(["req"]);

      const content = selectConversationContent(full, MessageId.make("m2"));
      expect(selectedConversationAttachments(content)).toEqual([]);
      const seen: string[] = [];
      const ranged = snapshotOf(full, through("m2"), (attachment) => {
        seen.push(attachment.id);
        return false;
      });
      expect(ranged.messages.map((entry) => entry.text)).toEqual(["go", "asked"]);
      expect(ranged.questionAnswers).toEqual([]);
      expect(ranged.warnings).toEqual([]);
      expect(seen).toEqual([]);
    });
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

  it("retains imported source history in a forked snapshot file", () => {
    const sourceImport = {
      source: "scic" as const,
      exportId: "earlier-export",
      sourceThreadId: "external-thread",
      packageDigest: `sha256:${"a".repeat(64)}`,
      sourceFormat: "scient.conversation-file",
      sourceFormatVersion: 1,
      importedAt: "2026-09-27T14:00:00.000Z",
      omissions: [{ _tag: "range-truncated" as const, throughMessageN: 2 }],
    };
    const snapshot = snapshotOf({
      ...thread({ messages: [message({ id: "m1", role: "user", text: "partial history" })] }),
      forkLineage: {
        originThreadId: ThreadId.make("imported-origin"),
        baselineAssistantMessageId: null,
        sourceImport,
      },
    });
    const snapshotJson = Schema.fromJsonString(ConversationSnapshotV1);
    const exported = Schema.encodeSync(snapshotJson)(snapshot);
    const decoded = Schema.decodeSync(snapshotJson)(exported);
    expect(decoded.provenance).toEqual({
      _tag: "fork",
      originThreadId: "imported-origin",
      sourceImport,
    });
    expect(exported).toContain("range-truncated");
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
