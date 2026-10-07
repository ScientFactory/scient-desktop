import {
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
} from "../../session-logic";

const timestamp = DateTime.makeUnsafe("2026-10-06T00:00:00.000Z");
const base = {
  id: TurnItemId.make("presentation-item"),
  threadId: ThreadId.make("presentation-thread"),
  runId: RunId.make("presentation-run"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: timestamp,
  completedAt: timestamp,
  updatedAt: timestamp,
};

function input(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return {
    visibleTurnItems: items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
      position,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
    optimisticMessages: [],
  };
}

describe("V2 browser action presentation", () => {
  it.each([
    [
      {
        kind: "open-url",
        url: "https://example.com/authorize",
        launchUrl: "http://127.0.0.1:43199/launch",
      },
      "http://127.0.0.1:43199/launch",
    ],
    [{ kind: "open-url", url: "https://example.com/authorize" }, "https://example.com/authorize"],
    [
      { kind: "open-url", url: "https://example.com/authorize", launchUrl: "javascript:alert(1)" },
      "https://example.com/authorize",
    ],
  ])("exposes a user-clickable HTTP link from canonical tool input %j", (toolInput, href) => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "Oh My Pi requests a URL",
      input: toolInput,
      output: "Wait for browser approval.",
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems(input([item]));
    expect(entry).toMatchObject({
      kind: "work",
      entry: {
        externalUrl: { href },
        detail: "Wait for browser approval.\n\nhttps://example.com/authorize",
        toolData: { input: toolInput, output: item.output },
      },
    });
  });

  it.each([
    { kind: "open-url", url: "javascript:alert(1)", launchUrl: "https://example.com/launch" },
    { kind: "open-url", url: "file:///private/document" },
    { kind: "open-url", url: "not a URL" },
    { kind: "ordinary-tool", url: "https://example.com" },
  ])("does not offer a browser action for unrelated or unsafe input %j", (toolInput) => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "Tool",
      input: toolInput,
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems(input([item]));
    expect(entry?.kind).toBe("work");
    if (entry?.kind !== "work") throw new Error("Expected work entry");
    expect(entry.entry.externalUrl).toBeUndefined();
  });
});

describe("imported V2 question answers", () => {
  it.each(["question-first", "answer-first"] as const)(
    "folds the named imported answer during %s incremental paging",
    (order) => {
      const requestId = RuntimeRequestId.make("imported-question");
      const messageId = MessageId.make("imported:message:0042");
      const question = {
        ...base,
        type: "user_input_request" as const,
        requestId,
        questions: [],
        questionAnswer: {
          requestId,
          messageId,
          answers: { color: "Blue" },
          attachmentsByQuestionId: {},
        },
      } satisfies OrchestrationV2TurnItem;
      const answer = {
        ...base,
        id: TurnItemId.make("imported-answer"),
        type: "user_message" as const,
        messageId,
        inputIntent: "steer" as const,
        text: "Which color?\nBlue",
        createdBy: "user" as const,
        creationSource: "server" as const,
        attachments: [],
      } satisfies OrchestrationV2TurnItem;
      const items = order === "question-first" ? [question, answer] : [answer, question];
      const before = input(items.slice(0, 1));
      const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(before);
      const after = {
        ...before,
        visibleTurnItems: [
          ...before.visibleTurnItems,
          ...input(items.slice(1)).visibleTurnItems.map((row) => ({ ...row, position: 1 })),
        ],
      };
      const full = deriveTimelineEntriesFromVisibleTurnItems(after);
      const incremental = deriveTimelineEntriesFromVisibleTurnItemsWithState(after, previous);
      expect(full).toHaveLength(1);
      expect(full[0]).toMatchObject({
        kind: "work",
        entry: { questionAnswer: question.questionAnswer },
      });
      expect(incremental.entries).toEqual(full);
      expect(deriveTimelineEntriesFromVisibleTurnItems(input([answer]))).toMatchObject([
        { kind: "message", message: { id: messageId } },
      ]);
    },
  );
});
