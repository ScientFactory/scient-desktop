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

function ChangedFilesTimeline(props: {
  includeOlderChange?: boolean;
  includeNewerAnswer?: boolean;
  currentFileCount: number;
  currentFiles?: TurnDiffFileChange[];
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
}) {
  const oldTurnId = TurnId.makeUnsafe("turn-old-change");
  const oldAssistantId = MessageId.makeUnsafe("assistant-old-change");
  const currentTurnId = TurnId.makeUnsafe("turn-current-change");
  const currentUserId = MessageId.makeUnsafe("user-current-change");
  const currentAssistantId = MessageId.makeUnsafe("assistant-current-change");
  const newerTurnId = TurnId.makeUnsafe("turn-newer-answer");
  const newerUserId = MessageId.makeUnsafe("user-newer-answer");
  const newerAssistantId = MessageId.makeUnsafe("assistant-newer-answer");
  const includeOlderChange = props.includeOlderChange === true;
  const currentFiles = props.currentFiles ?? makeFiles(props.currentFileCount);
  const timelineEntries: TimelineEntries = [
    ...(includeOlderChange
      ? [
          assistantEntry(oldAssistantId, oldTurnId, "2026-07-24T06:00:01.000Z"),
          userEntry(currentUserId, currentTurnId, "2026-07-24T06:00:02.000Z"),
        ]
      : []),
    assistantEntry(currentAssistantId, currentTurnId, "2026-07-24T06:00:03.000Z"),
    ...(props.includeNewerAnswer
      ? [
          userEntry(newerUserId, newerTurnId, "2026-07-24T06:00:04.000Z"),
          assistantEntry(newerAssistantId, newerTurnId, "2026-07-24T06:00:05.000Z"),
        ]
      : []),
  ];
  const summaries = new Map<MessageId, TurnDiffSummary>([
    ...(includeOlderChange
      ? [[oldAssistantId, makeSummary(oldTurnId, oldAssistantId, makeFiles(1), 1)] as const]
      : []),
    [currentAssistantId, makeSummary(currentTurnId, currentAssistantId, currentFiles, 2)],
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
        nowIso="2026-07-24T06:00:06.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={NOOP}
        onOpenTurnDiff={props.onOpenTurnDiff ?? NOOP}
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
      expect(currentCard?.dataset.changedFilesState).toBe("preview");
      expect(currentCard?.textContent).toContain("Undo");
      expect(currentCard?.textContent).toContain("Review");
      expect(
        currentCard?.querySelector('[role="group"][aria-label="Previewing 3 of 6 changed files"]'),
      ).not.toBeNull();
      const preview = currentCard?.querySelector<HTMLElement>(
        '[data-changed-files-preview="true"]',
      );
      const hiddenFullList = currentCard?.querySelector<HTMLElement>("[aria-hidden='true'][inert]");
      expect(hiddenFullList).not.toBeNull();
      expect(preview).not.toBeNull();
      expect(hiddenFullList?.contains(preview ?? null)).toBe(false);

      const oldToggle = oldCard?.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand changed files list, 1 file"]',
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
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Expand changed files list, 6 files"]',
        )
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

  it("previews a single high-churn file with singular, bounded copy", async () => {
    const file = { path: "apps/web/src/large.ts", additions: 201, deletions: 0 };
    const screen = await render(
      <ChangedFilesTimeline currentFileCount={1} currentFiles={[file]} />,
    );

    try {
      const card = document.querySelector<HTMLElement>(
        '[data-changed-files-turn-id="turn-current-change"]',
      );
      expect(card?.dataset.changedFilesState).toBe("preview");
      expect(
        card?.querySelector('[role="group"][aria-label="Previewing 1 of 1 changed file"]'),
      ).not.toBeNull();
      expect(
        card?.querySelector<HTMLButtonElement>(
          'button[aria-label="Show all 1 changed file"]:not([data-changed-files-disclosure-toggle])',
        )?.textContent,
      ).toContain("Show all 1 file");
    } finally {
      await screen.unmount();
    }
  });

  it("opens representative files directly and preserves focus when showing the full list", async () => {
    const files = [
      { path: "apps/web/src/components/chat/MessagesTimeline.tsx", additions: 128, deletions: 24 },
      { path: "apps/web/src/components/chat/ChangedFilesCard.tsx", additions: 84, deletions: 11 },
      {
        path: "apps/web/src/components/chat/ChangedFilesCard.test.tsx",
        additions: 96,
        deletions: 3,
      },
      { path: "apps/server/src/provider/Layers/OpenCodeAdapter.ts", additions: 44, deletions: 17 },
      { path: "packages/contracts/src/orchestration.ts", additions: 28, deletions: 9 },
      { path: "README.md", additions: 5, deletions: 1 },
    ];
    const opened: Array<{ turnId: TurnId; filePath?: string }> = [];
    const screen = await render(
      <ChangedFilesTimeline
        currentFileCount={files.length}
        currentFiles={files}
        onOpenTurnDiff={(turnId, filePath) =>
          opened.push(filePath === undefined ? { turnId } : { turnId, filePath })
        }
      />,
    );

    try {
      const card = document.querySelector<HTMLElement>(
        '[data-changed-files-turn-id="turn-current-change"]',
      );
      expect(card?.dataset.changedFilesState).toBe("preview");
      const providerFile = card?.querySelector<HTMLButtonElement>(
        'button[title="apps/server/src/provider/Layers/OpenCodeAdapter.ts"]',
      );
      expect(providerFile?.textContent).toContain("Layers/OpenCodeAdapter.ts");
      expect(providerFile?.getAttribute("aria-label")).toBe(
        "apps/server/src/provider/Layers/OpenCodeAdapter.ts, 44 additions, 17 deletions",
      );
      providerFile?.focus();
      await userEvent.keyboard("{Enter}");
      expect(opened.at(-1)?.filePath).toBe("apps/server/src/provider/Layers/OpenCodeAdapter.ts");
      expect(card?.dataset.changedFilesState).toBe("preview");

      const showAll = card?.querySelector<HTMLButtonElement>(
        'button[aria-label="Show all 6 changed files"]:not([data-changed-files-disclosure-toggle])',
      );
      const headerToggle = card?.querySelector<HTMLButtonElement>(
        'button[data-changed-files-disclosure-toggle="true"]',
      );
      expect(showAll).not.toBeNull();
      showAll?.focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => card?.dataset.changedFilesState).toBe("expanded");
      expect(document.activeElement).toBe(headerToggle);
      expect(card?.querySelector('[data-changed-files-preview="true"]')).toBeNull();
      expect(card?.textContent).toContain("README.md");
      expect(card?.textContent).toContain("Show less");
      expect(card?.querySelector('button[aria-expanded="false"]')).toBeNull();

      headerToggle?.click();
      await expect.poll(() => card?.dataset.changedFilesState).toBe("collapsed");
      expect(card?.querySelector('[data-changed-files-preview="true"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("drops an automatic preview when the turn becomes historical but keeps user overrides", async () => {
    const view = (includeNewerAnswer: boolean) => (
      <ChangedFilesTimeline currentFileCount={6} includeNewerAnswer={includeNewerAnswer} />
    );
    const screen = await render(view(false));

    try {
      const currentCard = () =>
        document.querySelector<HTMLElement>('[data-changed-files-turn-id="turn-current-change"]');
      expect(currentCard()?.dataset.changedFilesState).toBe("preview");

      await screen.rerender(view(true));
      await expect.poll(() => currentCard()?.dataset.changedFilesState).toBe("collapsed");

      await screen.rerender(view(false));
      await expect.poll(() => currentCard()?.dataset.changedFilesState).toBe("preview");
      currentCard()
        ?.querySelector<HTMLButtonElement>('button[data-changed-files-disclosure-toggle="true"]')
        ?.click();
      await expect.poll(() => currentCard()?.dataset.changedFilesState).toBe("expanded");

      await screen.rerender(view(true));
      await expect.poll(() => currentCard()?.dataset.changedFilesState).toBe("expanded");
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
      const showAll = card?.querySelector<HTMLButtonElement>(
        'button[aria-label="Show all 10 changed files"]:not([data-changed-files-disclosure-toggle])',
      );
      expect(card).not.toBeNull();
      expect(scroller).not.toBeNull();
      expect(showAll).not.toBeNull();
      expect(card?.dataset.changedFilesState).toBe("preview");
      const previewHeight = card?.getBoundingClientRect().height ?? 0;
      const previewScrollHeight = scroller?.scrollHeight ?? 0;

      showAll?.click();
      await expect.poll(() => card?.dataset.changedFilesState).toBe("expanded");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 320));

      const finalFileRow = Array.from(
        card?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((button) => button.textContent?.includes("changed-10.tsx"));
      const overflowToggle = Array.from(
        card?.querySelectorAll<HTMLButtonElement>('button[aria-expanded="true"]') ?? [],
      ).find((button) => button.textContent?.includes("Show less"));
      expect(finalFileRow).not.toBeUndefined();
      expect(finalFileRow?.closest("[aria-hidden='true'][inert]")).toBeNull();
      expect(overflowToggle).not.toBeUndefined();

      const expandedHeight = card?.getBoundingClientRect().height ?? 0;
      expect(expandedHeight).toBeGreaterThan(previewHeight + 40);
      expect(scroller?.scrollHeight ?? 0).toBeGreaterThan(previewScrollHeight + 40);
      const distanceFromEnd =
        (scroller?.scrollHeight ?? 0) - (scroller?.scrollTop ?? 0) - (scroller?.clientHeight ?? 0);
      expect(distanceFromEnd).toBeLessThanOrEqual(2);
    } finally {
      await screen.unmount();
    }
  });
});
