import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

const baseProps = {
  hasMessages: true,
  activeTurnStartedAt: null,
  turnDiffSummaryByAssistantMessageId: new Map(),
  nowIso: "2026-07-22T07:00:02.000Z",
  expandedWorkGroups: {},
  onToggleWorkGroup: () => {},
  onOpenTurnDiff: () => {},
  revertTurnCountByUserMessageId: new Map(),
  onRevertUserMessage: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  markdownCwd: "/tmp/project",
  resolvedTheme: "light" as const,
  timestampFormat: "locale" as const,
  workspaceRoot: "/tmp/project",
};

describe("MessagesTimeline bidirectional rendering", () => {
  it("carries Hebrew user direction into an ambiguous streaming assistant opening", async () => {
    const screen = await render(
      <MessagesTimeline
        {...baseProps}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-07-22T07:00:01.000Z"
        timelineEntries={[
          {
            id: "entry-user-bidi",
            kind: "message",
            createdAt: "2026-07-22T07:00:00.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-bidi"),
              role: "user",
              text: "@src/App.tsx שלום, בדוק את הקובץ",
              createdAt: "2026-07-22T07:00:00.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-assistant-bidi",
            kind: "message",
            createdAt: "2026-07-22T07:00:01.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-bidi"),
              role: "assistant",
              text: "Scient הוא",
              turnId: TurnId.makeUnsafe("turn-bidi"),
              createdAt: "2026-07-22T07:00:01.000Z",
              streaming: true,
            },
          },
        ]}
      />,
    );

    try {
      await vi.waitFor(() => {
        const userRow = document.querySelector<HTMLElement>('[data-message-role="user"]');
        const userParagraph = userRow?.querySelector<HTMLElement>(".chat-markdown p");
        const userChip = userParagraph?.querySelector<HTMLElement>('[dir="ltr"]');
        const assistantRow = document.querySelector<HTMLElement>('[data-message-role="assistant"]');
        const assistantParagraph = assistantRow?.querySelector<HTMLElement>(".chat-markdown p");

        expect(getComputedStyle(userParagraph!).direction).toBe("rtl");
        expect(getComputedStyle(userChip!).direction).toBe("ltr");
        expect(assistantParagraph?.textContent).toBe("Scient הוא");
        expect(getComputedStyle(assistantParagraph!).direction).toBe("rtl");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the user-message editor bidirectional", async () => {
    const screen = await render(
      <MessagesTimeline
        {...baseProps}
        isWorking={false}
        activeTurnInProgress={false}
        timelineEntries={[
          {
            id: "entry-edit-user-bidi",
            kind: "message",
            createdAt: "2026-07-22T07:00:00.000Z",
            message: {
              id: MessageId.makeUnsafe("message-edit-user-bidi"),
              role: "user",
              text: "ערוך את ההודעה הזאת",
              createdAt: "2026-07-22T07:00:00.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-edit-assistant-bidi",
            kind: "message",
            createdAt: "2026-07-22T07:00:01.000Z",
            message: {
              id: MessageId.makeUnsafe("message-edit-assistant-bidi"),
              role: "assistant",
              text: "בוצע.",
              turnId: TurnId.makeUnsafe("turn-edit-bidi"),
              createdAt: "2026-07-22T07:00:01.000Z",
              streaming: false,
            },
          },
        ]}
        onEditUserMessage={() => true}
      />,
    );

    try {
      await screen.getByRole("button", { name: "Edit message" }).click();
      const textarea = screen.getByRole("textbox", { name: "Edit message" }).element();
      expect(textarea.getAttribute("dir")).toBe("auto");
      expect(getComputedStyle(textarea).direction).toBe("rtl");
      expect(getComputedStyle(textarea).textAlign).toBe("start");
    } finally {
      await screen.unmount();
    }
  });
});
