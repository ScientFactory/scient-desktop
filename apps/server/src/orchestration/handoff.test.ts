// FILE: handoff.test.ts
// Purpose: Verifies automatic transcript replay stays bounded without shrinking explicit handoffs.
// Layer: Orchestration mapping tests
// Depends on: handoff.

import { MessageId, ThreadId, type OrchestrationMessage } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildHandoffBootstrapText,
  buildMessageForkBootstrapText,
  buildPriorTranscriptBootstrapText,
  listImportedForkProviderAttachments,
} from "./handoff.ts";

const message = (
  index: number,
  role: "user" | "assistant",
  text: string,
  source: "native" | "handoff-import" = "native",
): OrchestrationMessage => ({
  id: MessageId.makeUnsafe(`message-${index}`),
  role,
  text,
  turnId: null,
  streaming: false,
  source,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
});

const thread = (messages: ReadonlyArray<OrchestrationMessage>) => ({
  title: "Budgeted thread",
  branch: null,
  worktreePath: null,
  messages,
});

describe("transcript bootstrap budgets", () => {
  it("keeps short prior transcripts intact", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} short message`),
    );

    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-9");

    expect(text).not.toBeNull();
    expect(text).not.toContain("omitted to fit the context budget");
    for (let index = 0; index < 9; index += 1) {
      expect(text).toContain(`marker-${index}`);
    }
  });

  it("caps automatic replay at 32k while preserving the newest summaries", () => {
    const filler = "x".repeat(400);
    const messages = Array.from({ length: 301 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} ${filler}`),
    );

    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-300");

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(32_000);
    expect(text).toContain("omitted to fit the context budget");
    expect(text).toContain("marker-299");
    expect(text).not.toContain("marker-0 ");
    expect(text!.indexOf("marker-250")).toBeLessThan(text!.indexOf("marker-290"));
  });

  it("respects a caller budget smaller than the automatic ceiling", () => {
    const filler = "y".repeat(400);
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} ${filler}`),
    );

    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-59", 8_000);

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(8_000);
    expect(text).toContain("marker-58");
  });

  it("retains the larger explicit handoff budget", () => {
    const filler = "h".repeat(400);
    const messages = Array.from({ length: 180 }, (_, index) =>
      message(
        index,
        index % 2 === 0 ? "user" : "assistant",
        `handoff-${index} ${filler}`,
        "handoff-import",
      ),
    );

    const text = buildHandoffBootstrapText({
      ...thread(messages),
      handoff: {
        sourceThreadId: ThreadId.makeUnsafe("source-thread"),
        sourceProvider: "claudeAgent",
        importedAt: "2026-07-18T00:00:00.000Z",
        bootstrapStatus: "pending",
      },
    });

    expect(text).not.toBeNull();
    expect(text!.length).toBeGreaterThan(32_000);
    expect(text!.length).toBeLessThanOrEqual(90_000);
    expect(text).toContain("handoff-179");
  });

  it("serializes assistant selections as context without treating them as provider files", () => {
    const selectedMessage: OrchestrationMessage = {
      ...message(1, "user", "Rewrite this", "native"),
      source: "fork-import",
      attachments: [
        {
          type: "assistant-selection",
          id: "selection-critical-excerpt",
          assistantMessageId: MessageId.makeUnsafe("selected-assistant-message"),
          text: "critical selected excerpt",
        },
      ],
    };
    const selectedThread = thread([selectedMessage]);

    const text = buildMessageForkBootstrapText(selectedThread);

    expect(text).toContain("Rewrite this");
    expect(text).toContain("critical selected excerpt");
    expect(listImportedForkProviderAttachments(selectedThread)).toEqual([]);
  });
});
