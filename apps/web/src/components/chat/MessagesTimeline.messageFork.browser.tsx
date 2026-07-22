// FILE: MessagesTimeline.messageFork.browser.tsx
// Purpose: Browser regression for accessible message-fork actions and exact boundary dispatch.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

function MessageForkTimeline() {
  const [selectedMessageId, setSelectedMessageId] = useState<MessageId | null>(null);

  return (
    <div style={{ height: 480 }}>
      <output data-selected-message-id={selectedMessageId ?? ""}>{selectedMessageId}</output>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-fork-browser-user",
            kind: "message",
            createdAt: "2026-07-22T08:00:00.000Z",
            message: {
              id: MessageId.makeUnsafe("message-fork-browser-user"),
              role: "user",
              text: "Question",
              createdAt: "2026-07-22T08:00:00.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-fork-browser-assistant",
            kind: "message",
            createdAt: "2026-07-22T08:00:01.000Z",
            message: {
              id: MessageId.makeUnsafe("message-fork-browser-assistant"),
              role: "assistant",
              text: "Answer",
              createdAt: "2026-07-22T08:00:01.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-07-22T08:00:02.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onForkFromMessage={setSelectedMessageId}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

describe("MessagesTimeline message fork action", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("places Fork after Copy and dispatches the exact clicked message id", async () => {
    const screen = await render(<MessageForkTimeline />);

    try {
      const forkButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Fork conversation from this message"]',
        ),
      );
      expect(forkButtons).toHaveLength(2);

      for (const forkButton of forkButtons) {
        const actionButtons = Array.from(
          forkButton.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        );
        const copyIndex = actionButtons.findIndex(
          (button) => button.getAttribute("aria-label") === "Copy message",
        );
        const forkIndex = actionButtons.indexOf(forkButton);
        expect(copyIndex).toBeGreaterThanOrEqual(0);
        expect(forkIndex).toBe(copyIndex + 1);
      }

      forkButtons[1]?.click();
      await expect
        .poll(() => document.querySelector("output")?.getAttribute("data-selected-message-id"))
        .toBe("message-fork-browser-assistant");
    } finally {
      await screen.unmount();
    }
  });
});
