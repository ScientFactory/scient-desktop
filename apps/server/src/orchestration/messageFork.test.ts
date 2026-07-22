import {
  MessageId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { validateImportedMessageIds, validateMessageForkImport } from "./messageFork.ts";

const now = "2026-07-22T10:00:00.000Z";
const turnId = TurnId.makeUnsafe("turn-1");
const userMessageId = MessageId.makeUnsafe("message-user");
const assistantMessageId = MessageId.makeUnsafe("message-assistant");

const sourceMessages: OrchestrationMessage[] = [
  {
    id: userMessageId,
    role: "user",
    text: [
      "Question",
      "",
      "<assistant_selection>",
      "- assistant message earlier:",
      "  selected text",
      "</assistant_selection>",
    ].join("\n"),
    attachments: [
      {
        type: "assistant-selection",
        id: "selection-1",
        assistantMessageId: MessageId.makeUnsafe("earlier"),
        text: "selected text",
      },
    ],
    turnId,
    streaming: false,
    source: "native",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: assistantMessageId,
    role: "assistant",
    text: "Completed answer",
    turnId,
    // A delayed projection may retain this flag after the terminal turn event.
    streaming: true,
    source: "native",
    createdAt: "2026-07-22T10:00:01.000Z",
    updatedAt: "2026-07-22T10:00:02.000Z",
  },
];

const sourceThread: Pick<OrchestrationThread, "messages" | "latestTurn"> = {
  messages: sourceMessages,
  latestTurn: {
    turnId,
    state: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: "2026-07-22T10:00:02.000Z",
    assistantMessageId,
  },
};

const importedMessages: ThreadHandoffImportedMessage[] = [
  {
    messageId: MessageId.makeUnsafe("import-user"),
    role: "user",
    text: "Question",
    attachments: sourceMessages[0]!.attachments,
    createdAt: now,
    updatedAt: now,
  },
  {
    messageId: MessageId.makeUnsafe("import-assistant"),
    role: "assistant",
    text: "Completed answer",
    createdAt: "2026-07-22T10:00:01.000Z",
    // Client state can lack the delayed completion timestamp; it is not part of
    // transcript identity, so the authoritative comparison intentionally ignores it.
    updatedAt: "2026-07-22T10:00:01.000Z",
  },
];

describe("validateMessageForkImport", () => {
  it("accepts the exact prefix through a terminal assistant with a stale streaming flag", () => {
    expect(
      validateMessageForkImport({
        sourceThread,
        sourceMessageId: assistantMessageId,
        importedMessages,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a streaming assistant while its turn is still running", () => {
    expect(
      validateMessageForkImport({
        sourceThread: {
          ...sourceThread,
          latestTurn: {
            ...sourceThread.latestTurn!,
            state: "running",
            completedAt: null,
          },
        },
        sourceMessageId: assistantMessageId,
        importedMessages,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid-source",
      expectedImportedMessageCount: 0,
    });
  });

  it("rejects same-length imports whose text or attachments do not match the source prefix", () => {
    expect(
      validateMessageForkImport({
        sourceThread,
        sourceMessageId: assistantMessageId,
        importedMessages: [
          {
            ...importedMessages[0]!,
            text: "Different question",
          },
          importedMessages[1]!,
        ],
      }),
    ).toEqual({
      ok: false,
      reason: "import-mismatch",
      expectedImportedMessageCount: 2,
    });

    expect(
      validateMessageForkImport({
        sourceThread,
        sourceMessageId: assistantMessageId,
        importedMessages: [
          {
            ...importedMessages[0]!,
            attachments: [],
          },
          importedMessages[1]!,
        ],
      }),
    ).toEqual({
      ok: false,
      reason: "import-mismatch",
      expectedImportedMessageCount: 2,
    });
  });
});

describe("validateImportedMessageIds", () => {
  it("rejects duplicate ids inside an import", () => {
    expect(
      validateImportedMessageIds({
        importedMessages: [
          importedMessages[0]!,
          { ...importedMessages[1]!, messageId: importedMessages[0]!.messageId },
        ],
        existingMessageIds: new Set(),
      }),
    ).toEqual({
      ok: false,
      conflictingMessageId: importedMessages[0]!.messageId,
    });
  });

  it("rejects ids already owned by any projected thread", () => {
    expect(
      validateImportedMessageIds({
        importedMessages,
        existingMessageIds: new Set([importedMessages[1]!.messageId]),
      }),
    ).toEqual({
      ok: false,
      conflictingMessageId: importedMessages[1]!.messageId,
    });
  });
});
