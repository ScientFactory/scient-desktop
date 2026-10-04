import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasCommittedConversationMessages } from "./composerModelPickerFork";

const queuedRunId = RunId.make("queued-run");
const sentRunId = RunId.make("sent-run");

describe("model picker conversation history", () => {
  it("does not infer a conversation from an empty draft or pending queue preview", () => {
    // Only durable projection facts enter the predicate; local draft/preview text does not.
    expect(hasCommittedConversationMessages({ messages: [], runs: [], items: [] })).toBe(false);
  });

  it("excludes held queued-only messages and historical queued presentation items", () => {
    expect(
      hasCommittedConversationMessages({
        messages: [{ runId: queuedRunId }],
        runs: [{ id: queuedRunId, status: "queued" }],
        items: [{ type: "user_message", runId: queuedRunId }],
      }),
    ).toBe(false);
  });

  it("includes an admitted conversation while queued followups remain held", () => {
    expect(
      hasCommittedConversationMessages({
        messages: [{ runId: queuedRunId }, { runId: sentRunId }],
        runs: [
          { id: queuedRunId, status: "queued" },
          { id: sentRunId, status: "running" },
        ],
        items: [],
      }),
    ).toBe(true);
  });

  it("includes inherited history and committed items while projection messages catch up", () => {
    expect(
      hasCommittedConversationMessages({
        messages: [],
        runs: [],
        items: [{ type: "assistant_message", runId: null }],
      }),
    ).toBe(true);
    expect(
      hasCommittedConversationMessages({ messages: [{ runId: null }], runs: [], items: [] }),
    ).toBe(true);
  });

  it("does not mistake provider setup or reasoning for conversation messages", () => {
    expect(
      hasCommittedConversationMessages({
        messages: [],
        runs: [],
        items: [{ type: "reasoning", runId: sentRunId }],
      }),
    ).toBe(false);
  });
});
