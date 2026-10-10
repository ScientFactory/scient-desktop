import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import { retainedRollbackAttachmentIds } from "./RollbackAttachmentRetention.ts";

type Owner = Parameters<typeof retainedRollbackAttachmentIds>[1][number];

const runId = RunId.make("rolled-back-run");
const file = { type: "file", id: "source-file", name: "a.txt", mimeType: "text/plain" };
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
