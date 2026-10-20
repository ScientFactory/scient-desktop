import { describe, expect, it } from "vite-plus/test";
import { MessageId, ThreadId, type OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { keepAwakeProgressToken } from "./scientKeepAwake.ts";

const now = DateTime.makeUnsafe(1000);
const message: OrchestrationV2ConversationMessage = {
  createdBy: "agent",
  creationSource: "provider",
  id: MessageId.make("assistant-message"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  role: "assistant",
  text: "Working",
  attachments: [],
  streaming: true,
  createdAt: now,
  updatedAt: now,
};
const snapshot = { runs: [], attempts: [], nodes: [], turnItems: [], messages: [message] };

describe("keep-awake progress evidence", () => {
  it("ignores backend polls, session timestamps, and unrelated thread edits", () => {
    const initial = keepAwakeProgressToken(snapshot);
    const polled = {
      ...snapshot,
      updatedAt: DateTime.makeUnsafe(200_000),
      keepAwakeHealth: "unowned",
      thread: { title: "Renamed" },
      providerSessions: [{ updatedAt: DateTime.makeUnsafe(200_000) }],
    };
    expect(keepAwakeProgressToken(polled)).toBe(initial);
  });

  it("recognizes new assistant execution output", () => {
    expect(
      keepAwakeProgressToken({
        ...snapshot,
        messages: [{ ...message, text: "More output", updatedAt: DateTime.makeUnsafe(20_000) }],
      }),
    ).not.toBe(keepAwakeProgressToken(snapshot));
  });
});
