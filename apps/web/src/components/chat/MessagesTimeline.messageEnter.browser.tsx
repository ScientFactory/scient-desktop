// FILE: MessagesTimeline.messageEnter.browser.tsx
// Purpose: Browser regression for the subtle enter animation on newly sent user messages.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, ThreadId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { deriveTimelineEntries } from "../../session-logic";
import { useUserMessageEditDraftStore } from "../../userMessageEditDraftStore";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;
const HYDRATING_THREAD_ID = ThreadId.makeUnsafe("thread-hydrating-edit-draft");

function userEntry(id: string, text: string): TimelineEntries[number] {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  };
}

function MessageEnterTimeline() {
  const [entries, setEntries] = useState<TimelineEntries>(() => [
    userEntry("initial-user-message", "Already here."),
  ]);
  const [enteringUserMessageIds, setEnteringUserMessageIds] = useState<ReadonlySet<MessageId>>(
    () => new Set(),
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          const messageId = MessageId.makeUnsafe("fresh-user-message");
          setEnteringUserMessageIds(new Set([messageId]));
          setEntries((current) => [...current, userEntry("fresh-user-message", "Just sent.")]);
        }}
      >
        Append sent message
      </button>
      <div style={{ height: 420 }}>
        <MessagesTimeline
          hasMessages={entries.length > 0}
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          enteringUserMessageIds={enteringUserMessageIds}
          timelineEntries={entries}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-03-17T19:12:30.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </div>
  );
}

function HydratingTimeline() {
  const [entries, setEntries] = useState<TimelineEntries>(() => []);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setEntries([userEntry("hydrated-user-message", "Loaded from history.")]);
        }}
      >
        Load saved message
      </button>
      <div style={{ height: 420 }}>
        <MessagesTimeline
          activeThreadId={HYDRATING_THREAD_ID}
          hasMessages={entries.length > 0}
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          timelineEntries={entries}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-03-17T19:12:30.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </div>
  );
}

describe("MessagesTimeline message enter animation", () => {
  afterEach(() => {
    useUserMessageEditDraftStore.getState().clearAll();
    document.body.innerHTML = "";
  });

  it("animates only newly sent user messages", async () => {
    const screen = await render(<MessageEnterTimeline />);

    try {
      const initialRow = document.querySelector<HTMLElement>(
        '[data-message-id="initial-user-message"]',
      );
      expect(initialRow).not.toBeNull();
      expect(initialRow?.classList.contains("chat-message-send-enter")).toBe(false);

      document.querySelector<HTMLButtonElement>("button")?.click();

      await expect
        .poll(() =>
          document
            .querySelector<HTMLElement>('[data-message-id="fresh-user-message"]')
            ?.classList.contains("chat-message-send-enter"),
        )
        .toBe(true);

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });

      await expect
        .poll(() =>
          document
            .querySelector<HTMLElement>('[data-message-id="fresh-user-message"]')
            ?.classList.contains("chat-message-send-enter"),
        )
        .toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("retains a rejected edit while thread detail is temporarily empty", async () => {
    useUserMessageEditDraftStore.getState().begin(HYDRATING_THREAD_ID, {
      messageId: MessageId.makeUnsafe("hydrated-user-message"),
      draftText: "replacement kept through hydration",
      originalText: "Loaded from history.",
      originalRevision: "2026-03-17T19:12:28.000Z",
      attemptCreatedAt: "2026-03-17T19:12:29.000Z",
    });
    useUserMessageEditDraftStore
      .getState()
      .markRejected(HYDRATING_THREAD_ID, MessageId.makeUnsafe("hydrated-user-message"));
    const screen = await render(<HydratingTimeline />);

    try {
      expect(
        useUserMessageEditDraftStore.getState().draftsByThreadId[HYDRATING_THREAD_ID],
      ).toBeDefined();
      await screen.getByRole("button", { name: "Load saved message" }).click();
      const recoveredEdit = screen.getByRole("textbox", { name: "Edit message" });
      await expect.element(recoveredEdit).toHaveValue("replacement kept through hydration");
      await expect.element(recoveredEdit).toHaveFocus();
    } finally {
      await screen.unmount();
    }
  });

  it("does not animate user messages loaded by transcript hydration", async () => {
    const screen = await render(<HydratingTimeline />);

    try {
      document.querySelector<HTMLButtonElement>("button")?.click();

      await expect
        .poll(
          () =>
            document.querySelector<HTMLElement>('[data-message-id="hydrated-user-message"]') !==
            null,
        )
        .toBe(true);
      expect(
        document
          .querySelector<HTMLElement>('[data-message-id="hydrated-user-message"]')
          ?.classList.contains("chat-message-send-enter"),
      ).toBe(false);
    } finally {
      await screen.unmount();
    }
  });
});
