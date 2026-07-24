// FILE: MessagesTimeline.changedFiles.browser.tsx
// Purpose: Browser and geometry regressions for settled-turn changed-files disclosures.
// Layer: Vitest browser tests

import "../../index.css";

import { CheckpointRef, MessageId, TurnId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import type { TurnDiffFileChange, TurnDiffSummary } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const NOOP = () => {};

function assistantEntry(
  messageId: MessageId,
  turnId: TurnId,
  createdAt: string,
): TimelineEntries[number] {
  return {
    id: `entry-${messageId}`,
    kind: "message",
    createdAt,
    message: {
      id: messageId,
      role: "assistant",
      turnId,
      text: "Done.",
      createdAt,
      completedAt: createdAt,
      streaming: false,
    },
  };
}

function userEntry(
  messageId: MessageId,
  turnId: TurnId,
  createdAt: string,
): TimelineEntries[number] {
  return {
    id: `entry-${messageId}`,
    kind: "message",
    createdAt,
    message: {
      id: messageId,
      role: "user",
      turnId,
      text: "Please update this.",
      createdAt,
      streaming: false,
    },
  };
}

function makeFiles(count: number): TurnDiffFileChange[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `apps/web/src/changed-${index + 1}.tsx`,
    additions: 4,
    deletions: 1,
  }));
}

function makeSummary(
  turnId: TurnId,
  assistantMessageId: MessageId,
  files: TurnDiffFileChange[],
  checkpointTurnCount: number,
): TurnDiffSummary {
  return {
    turnId,
    assistantMessageId,
    completedAt: `2026-07-24T06:00:0${checkpointTurnCount}.000Z`,
    status: "ready",
    checkpointRef: CheckpointRef.makeUnsafe(`checkpoint-${checkpointTurnCount}`),
    checkpointTurnCount,
    checkpointTurnCounts: [checkpointTurnCount],
    files,
  };
}

function ChangedFilesTimeline(props: { includeOlderChange?: boolean; currentFileCount: number }) {
  const oldTurnId = TurnId.makeUnsafe("turn-old-change");
  const oldAssistantId = MessageId.makeUnsafe("assistant-old-change");
  const currentTurnId = TurnId.makeUnsafe("turn-current-change");
  const currentUserId = MessageId.makeUnsafe("user-current-change");
  const currentAssistantId = MessageId.makeUnsafe("assistant-current-change");
  const includeOlderChange = props.includeOlderChange === true;
  const timelineEntries: TimelineEntries = [
    ...(includeOlderChange
      ? [
          assistantEntry(oldAssistantId, oldTurnId, "2026-07-24T06:00:01.000Z"),
          userEntry(currentUserId, currentTurnId, "2026-07-24T06:00:02.000Z"),
        ]
      : []),
    assistantEntry(currentAssistantId, currentTurnId, "2026-07-24T06:00:03.000Z"),
  ];
  const summaries = new Map<MessageId, TurnDiffSummary>([
    ...(includeOlderChange
      ? [[oldAssistantId, makeSummary(oldTurnId, oldAssistantId, makeFiles(1), 1)] as const]
      : []),
    [
      currentAssistantId,
      makeSummary(currentTurnId, currentAssistantId, makeFiles(props.currentFileCount), 2),
    ],
  ]);

  return (
    <div style={{ height: 260 }}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={timelineEntries}
        turnDiffSummaryByAssistantMessageId={summaries}
        nowIso="2026-07-24T06:00:04.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={NOOP}
        onOpenTurnDiff={NOOP}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={NOOP}
        onUndoTurnFiles={NOOP}
        isRevertingCheckpoint={false}
        onImageExpand={NOOP}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

describe("MessagesTimeline changed-files disclosure", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps controls visible and supports keyboard expansion without mixing turn state", async () => {
    const screen = await render(<ChangedFilesTimeline includeOlderChange currentFileCount={6} />);

    try {
      const oldCard = document.querySelector<HTMLElement>(
        '[data-changed-files-turn-id="turn-old-change"]',
      );
      const currentCard = document.querySelector<HTMLElement>(
        '[data-changed-files-turn-id="turn-current-change"]',
      );
      expect(oldCard?.dataset.changedFilesState).toBe("collapsed");
      expect(currentCard?.dataset.changedFilesState).toBe("collapsed");
      expect(currentCard?.textContent).toContain("Undo");
      expect(currentCard?.textContent).toContain("Review");

      const oldToggle = oldCard?.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand changed files list"]',
      );
      expect(oldToggle?.getAttribute("aria-expanded")).toBe("false");
      expect(oldToggle).not.toBeNull();
      oldToggle?.focus();
      await userEvent.keyboard("{Enter}");

      await expect.poll(() => oldCard?.dataset.changedFilesState).toBe("expanded");
      expect(oldToggle?.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(oldToggle);
      expect(oldCard?.querySelector("[aria-hidden='true'][inert]")).toBeNull();

      currentCard
        ?.querySelector<HTMLButtonElement>('button[aria-label="Expand changed files list"]')
        ?.click();
      await expect.poll(() => currentCard?.dataset.changedFilesState).toBe("expanded");
      expect(oldCard?.dataset.changedFilesState).toBe("expanded");
    } finally {
      await screen.unmount();
    }
  });

  it("leaves a small current change readable by default", async () => {
    const screen = await render(<ChangedFilesTimeline currentFileCount={2} />);

    try {
      const card = document.querySelector<HTMLElement>(
        '[data-changed-files-turn-id="turn-current-change"]',
      );
      expect(card?.dataset.changedFilesState).toBe("expanded");
      expect(card?.textContent).toContain("changed-1.tsx");
      expect(card?.textContent).toContain("changed-2.tsx");
      expect(
        card?.querySelector('[role="group"][aria-label="8 additions, 2 deletions"]'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("grows the tail card and keeps the live edge visible after expansion [geometry:linux]", async () => {
    const screen = await render(<ChangedFilesTimeline currentFileCount={10} />);

    try {
      const card = document.querySelector<HTMLElement>(
        '[data-changed-files-turn-id="turn-current-change"]',
      );
      const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
      const toggle = card?.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand changed files list"]',
      );
      expect(card).not.toBeNull();
      expect(scroller).not.toBeNull();
      expect(toggle).not.toBeNull();
      const collapsedHeight = card?.getBoundingClientRect().height ?? 0;
      const collapsedScrollHeight = scroller?.scrollHeight ?? 0;

      toggle?.click();
      await expect.poll(() => card?.dataset.changedFilesState).toBe("expanded");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 320));

      const expandedHeight = card?.getBoundingClientRect().height ?? 0;
      expect(expandedHeight).toBeGreaterThan(collapsedHeight + 100);
      expect(scroller?.scrollHeight ?? 0).toBeGreaterThan(collapsedScrollHeight + 100);
      const distanceFromEnd =
        (scroller?.scrollHeight ?? 0) - (scroller?.scrollTop ?? 0) - (scroller?.clientHeight ?? 0);
      expect(distanceFromEnd).toBeLessThanOrEqual(2);
    } finally {
      await screen.unmount();
    }
  });
});
