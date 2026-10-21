import { describe, expect, it } from "@effect/vitest";
import { MessageId, RunId, RuntimeRequestId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  retainedRollbackAttachmentIds,
  rollbackAttachmentCandidateIds,
} from "./RollbackAttachmentRetention.ts";

type Owner = Parameters<typeof retainedRollbackAttachmentIds>[1][number];

const runId = RunId.make("rolled-back-run");
const file = { type: "file" as const, id: "source-file", name: "a.txt", mimeType: "text/plain" };
const owner = (input: {
  readonly id: string;
  readonly deleted: boolean;
  readonly messageRunId: RunId | null;
}) =>
  ({
    thread: {
      id: ThreadId.make(input.id),
      deletedAt: input.deleted ? "2026-10-08T00:00:00.000Z" : null,
      conversationFork: null,
    },
    runs: [{ id: runId, status: "rolled_back", queueHeld: false }],
    messages: [{ id: `${input.id}-message`, runId: input.messageRunId, attachments: [file] }],
    turnItems: [],
    runtimeRequests: [],
  }) as unknown as Owner;

describe("retainedRollbackAttachmentIds", () => {
  const input = {
    threadId: ThreadId.make("source"),
    revertedRunIds: [runId],
    attachmentIds: ["source-file"],
  };

  it("releases a rolled-back file that only a deleted fork still names", () => {
    expect(
      retainedRollbackAttachmentIds(input, [
        owner({ id: "source", deleted: false, messageRunId: runId }),
        owner({ id: "deleted-fork", deleted: true, messageRunId: null }),
      ]),
    ).toEqual([]);
  });

  it("keeps a rolled-back file a live fork still shows", () => {
    expect(
      retainedRollbackAttachmentIds(input, [
        owner({ id: "source", deleted: false, messageRunId: runId }),
        owner({ id: "live-fork", deleted: false, messageRunId: null }),
      ]),
    ).toEqual(["source-file"]);
  });
});

describe("rollbackAttachmentCandidateIds", () => {
  const threadId = ThreadId.make("source");
  const now = DateTime.makeUnsafe("2026-10-08T00:00:00.000Z");
  const attachment = { ...file, sizeBytes: 1 };
  const message: Owner["messages"][number] = {
    id: MessageId.make("rollback-message"),
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text: "Measured data",
    attachments: [attachment],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  const question: Extract<Owner["turnItems"][number], { type: "user_input_request" }> = {
    id: TurnItemId.make("rollback-question"),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_input_request",
    requestId: RuntimeRequestId.make("rollback-request"),
    questions: [],
    questionAnswer: {
      requestId: "rollback-request",
      answers: { dataset: "Measured data" },
      attachmentsByQuestionId: {
        dataset: [attachment, { ...attachment, id: "answer-file" }],
        duplicate: [attachment],
      },
    },
  };

  it("collects message and completed-answer attachments once", () => {
    expect(
      rollbackAttachmentCandidateIds({
        threadId,
        revertedRunIds: [runId],
        messages: [message, message],
        turnItems: [question, question],
      }),
    ).toEqual(["source-file", "answer-file"]);
  });

  it("excludes foreign, unreverted, unowned and unfinished records", () => {
    const otherThreadId = ThreadId.make("other-thread");
    const otherRunId = RunId.make("other-run");
    expect(
      rollbackAttachmentCandidateIds({
        threadId,
        revertedRunIds: [runId],
        messages: [
          { ...message, threadId: otherThreadId },
          { ...message, runId: otherRunId },
          { ...message, runId: null },
        ],
        turnItems: [
          { ...question, threadId: otherThreadId },
          { ...question, runId: otherRunId },
          { ...question, runId: null },
          { ...question, status: "pending" },
          { ...question, status: "cancelled" },
          {
            ...question,
            inheritedFrom: {
              threadId: otherThreadId,
              itemId: question.id,
              runId,
              status: "completed",
            },
          },
        ],
      }),
    ).toEqual([]);
  });
});
