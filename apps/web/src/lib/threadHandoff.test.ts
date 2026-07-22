import { MessageId, type ModelSelection, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  buildThreadForkImportedMessagesThrough,
  resolveThreadForkableMessageIds,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffTitle,
  resolveThreadHandoffModelSelection,
} from "./threadHandoff";

describe("threadHandoff", () => {
  it("imports only completed conversation messages through the selected fork boundary", () => {
    const firstUserId = MessageId.makeUnsafe("message-user-1");
    const firstAssistantId = MessageId.makeUnsafe("message-assistant-1");
    const secondUserId = MessageId.makeUnsafe("message-user-2");

    const imported = buildThreadForkImportedMessagesThrough(
      {
        messages: [
          {
            id: firstUserId,
            role: "user",
            text: "First question",
            createdAt: "2026-07-22T08:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("message-system-1"),
            role: "system",
            text: "Internal status",
            createdAt: "2026-07-22T08:00:01.000Z",
            streaming: false,
          },
          {
            id: firstAssistantId,
            role: "assistant",
            text: "First answer",
            createdAt: "2026-07-22T08:00:02.000Z",
            completedAt: "2026-07-22T08:00:03.000Z",
            streaming: false,
          },
          {
            id: secondUserId,
            role: "user",
            text: "Later question",
            createdAt: "2026-07-22T08:01:00.000Z",
            streaming: false,
          },
        ],
      },
      firstAssistantId,
    );

    expect(imported).toHaveLength(2);
    expect(imported.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "First question" },
      { role: "assistant", text: "First answer" },
    ]);
    expect(imported.every((message) => message.messageId !== firstUserId)).toBe(true);
    expect(imported.every((message) => message.messageId !== firstAssistantId)).toBe(true);
  });

  it("rejects missing or streaming fork boundaries", () => {
    const streamingId = MessageId.makeUnsafe("message-streaming");
    const thread = {
      messages: [
        {
          id: streamingId,
          role: "assistant" as const,
          text: "Still running",
          createdAt: "2026-07-22T08:00:00.000Z",
          streaming: true,
        },
      ],
    };

    expect(buildThreadForkImportedMessagesThrough(thread, streamingId)).toEqual([]);
    expect(
      buildThreadForkImportedMessagesThrough(thread, MessageId.makeUnsafe("message-missing")),
    ).toEqual([]);
  });

  it("fails closed for a queued user boundary after a live assistant", () => {
    const priorUserId = MessageId.makeUnsafe("message-prior-user");
    const liveAssistantId = MessageId.makeUnsafe("message-live-assistant");
    const queuedUserId = MessageId.makeUnsafe("message-queued-user");
    const liveTurnId = TurnId.makeUnsafe("turn-live");
    const thread = {
      messages: [
        {
          id: priorUserId,
          role: "user" as const,
          text: "Prior question",
          createdAt: "2026-07-22T08:00:00.000Z",
          streaming: false,
        },
        {
          id: liveAssistantId,
          role: "assistant" as const,
          text: "Still answering",
          turnId: liveTurnId,
          createdAt: "2026-07-22T08:00:01.000Z",
          streaming: true,
        },
        {
          id: queuedUserId,
          role: "user" as const,
          text: "Queued follow-up",
          createdAt: "2026-07-22T08:00:02.000Z",
          streaming: false,
        },
      ],
      latestTurn: {
        turnId: liveTurnId,
        state: "running" as const,
        requestedAt: "2026-07-22T08:00:00.000Z",
        startedAt: "2026-07-22T08:00:00.500Z",
        completedAt: null,
        assistantMessageId: liveAssistantId,
      },
      session: null,
    };

    expect(buildThreadForkImportedMessagesThrough(thread, queuedUserId)).toEqual([]);
    expect([...resolveThreadForkableMessageIds(thread)]).toEqual([priorUserId]);
  });

  it("treats an active-turn assistant as unsafe even before its streaming flag arrives", () => {
    const assistantId = MessageId.makeUnsafe("message-active-nonstreaming-assistant");
    const turnId = TurnId.makeUnsafe("turn-active-nonstreaming-assistant");
    const thread = {
      messages: [
        {
          id: assistantId,
          role: "assistant" as const,
          text: "Projected before the stream flag",
          turnId,
          createdAt: "2026-07-22T08:00:01.000Z",
          streaming: false,
        },
      ],
      latestTurn: {
        turnId,
        state: "running" as const,
        requestedAt: "2026-07-22T08:00:00.000Z",
        startedAt: "2026-07-22T08:00:00.500Z",
        completedAt: null,
        assistantMessageId: assistantId,
      },
      session: null,
    };

    expect(buildThreadForkImportedMessagesThrough(thread, assistantId)).toEqual([]);
    expect(resolveThreadForkableMessageIds(thread).size).toBe(0);
  });

  it("imports the settled latest assistant when its raw streaming flag is stale", () => {
    const assistantId = MessageId.makeUnsafe("message-stale-streaming-assistant");
    const turnId = TurnId.makeUnsafe("turn-stale-streaming-assistant");

    const imported = buildThreadForkImportedMessagesThrough(
      {
        messages: [
          {
            id: MessageId.makeUnsafe("message-stale-streaming-user"),
            role: "user",
            text: "Question",
            createdAt: "2026-07-22T08:00:00.000Z",
            streaming: false,
          },
          {
            id: assistantId,
            role: "assistant",
            text: "Completed answer",
            turnId,
            createdAt: "2026-07-22T08:00:01.000Z",
            completedAt: "2026-07-22T08:00:02.000Z",
            streaming: true,
          },
        ],
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-07-22T08:00:00.000Z",
          startedAt: "2026-07-22T08:00:00.500Z",
          completedAt: "2026-07-22T08:00:02.000Z",
          assistantMessageId: assistantId,
        },
        session: null,
      },
      assistantId,
    );

    expect(imported.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Question" },
      { role: "assistant", text: "Completed answer" },
    ]);
  });

  it("imports every settled stale-streaming assistant row from the terminal turn", () => {
    const firstAssistantId = MessageId.makeUnsafe("message-stale-streaming-assistant-first");
    const latestAssistantId = MessageId.makeUnsafe("message-stale-streaming-assistant-latest");
    const turnId = TurnId.makeUnsafe("turn-stale-streaming-assistants");

    const imported = buildThreadForkImportedMessagesThrough(
      {
        messages: [
          {
            id: firstAssistantId,
            role: "assistant",
            text: "First completed row",
            turnId,
            createdAt: "2026-07-22T08:00:01.000Z",
            streaming: true,
          },
          {
            id: latestAssistantId,
            role: "assistant",
            text: "Latest completed row",
            turnId,
            createdAt: "2026-07-22T08:00:02.000Z",
            streaming: true,
          },
        ],
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-07-22T08:00:00.000Z",
          startedAt: "2026-07-22T08:00:00.500Z",
          completedAt: "2026-07-22T08:00:03.000Z",
          assistantMessageId: latestAssistantId,
        },
        session: null,
      },
      latestAssistantId,
    );

    expect(imported.map(({ text }) => text)).toEqual([
      "First completed row",
      "Latest completed row",
    ]);
  });

  it("lists all supported handoff targets except the active provider", () => {
    const providers = [
      "codex",
      "claudeAgent",
      "cursor",
      "antigravity",
      "grok",
      "droid",
      "kilo",
      "opencode",
      "pi",
    ] as const;

    for (const source of providers) {
      expect(resolveAvailableHandoffTargetProviders(source)).toEqual(
        providers.filter((provider) => provider !== source),
      );
    }
  });

  it("preserves the source thread title for the created handoff thread", () => {
    expect(resolveThreadHandoffTitle({ title: "General Greeting" })).toBe("General Greeting");
    expect(resolveThreadHandoffTitle({ title: "  Debug   Grok handoff  " })).toBe(
      "Debug Grok handoff",
    );
  });

  it("prefers sticky model selection for the chosen handoff target", () => {
    const stickySelection = {
      provider: "antigravity",
      model: "Gemini 3.5 Flash",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        targetProvider: "antigravity",
        projectDefaultModelSelection: {
          provider: "antigravity",
          model: "Claude Sonnet 4.6",
        },
        stickyModelSelectionByProvider: {
          antigravity: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("falls back to the resolved provider default model when no sticky or project default exists", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "antigravity",
            model: "Gemini 3.5 Flash",
          },
        },
        targetProvider: "codex",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });
});
