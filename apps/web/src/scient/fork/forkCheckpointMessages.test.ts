import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findLatestCompletedAssistantMessageId,
  findPrecedingCompletedAssistantMessageId,
} from "./forkCheckpointMessages";

describe("findLatestCompletedAssistantMessageId", () => {
  it("selects the latest settled terminal response while a newer turn is active", () => {
    const result = findLatestCompletedAssistantMessageId({
      timelineEntries: [
        {
          id: "assistant-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Completed response",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-2" as never,
            role: "assistant",
            text: "Still working",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:21Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: RunId.make("turn-2"),
        status: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      runningRunId: RunId.make("turn-2"),
    });

    expect(result).toBe("assistant-1");
  });
});

describe("findPrecedingCompletedAssistantMessageId", () => {
  it("uses the terminal completed response before the selected user message", () => {
    const result = findPrecedingCompletedAssistantMessageId({
      timelineEntries: [
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Interim",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:02Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Final",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:02Z",
            updatedAt: "2026-01-01T00:00:02Z",
            streaming: false,
          },
        },
        {
          id: "selected-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:03Z",
          message: {
            id: "selected-user" as never,
            role: "user",
            text: "Fork this",
            runId: null,
            createdAt: "2026-01-01T00:00:03Z",
            updatedAt: "2026-01-01T00:00:03Z",
            streaming: false,
          },
        },
      ],
      sourceUserMessageId: "selected-user" as never,
    });

    expect(result).toBe("assistant-final");
  });

  it("returns no checkpoint boundary before the first user message", () => {
    expect(
      findPrecedingCompletedAssistantMessageId({
        timelineEntries: [
          {
            id: "selected-user-entry",
            kind: "message",
            createdAt: "2026-01-01T00:00:00Z",
            message: {
              id: "selected-user" as never,
              role: "user",
              text: "Start here",
              runId: null,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              streaming: false,
            },
          },
        ],
        sourceUserMessageId: "selected-user" as never,
      }),
    ).toBeNull();
  });
});
