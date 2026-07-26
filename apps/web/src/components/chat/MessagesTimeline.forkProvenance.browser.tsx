// FILE: MessagesTimeline.forkProvenance.browser.tsx
// Purpose: Browser regressions for accessible, responsive fork provenance in virtualized transcripts.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, ThreadId } from "@synara/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";
import type { ForkProvenance } from "./forkProvenance";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const SOURCE_ID = ThreadId.makeUnsafe("fork-source-thread");

function entries(count: number): TimelineEntries {
  return Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 6, 26, 12, 0, index)).toISOString();
    return {
      id: `entry-${index}`,
      kind: "message" as const,
      createdAt,
      message: {
        id: MessageId.makeUnsafe(`message-${index}`),
        role: "user" as const,
        text: `Transcript message ${index}`,
        createdAt,
        streaming: false,
      },
    };
  });
}

function ForkTimeline({
  messageCount,
  provenance,
  width = 640,
}: {
  messageCount: number;
  provenance: ForkProvenance;
  width?: number;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const [openedSource, setOpenedSource] = useState<string>("");
  const timelineEntries = entries(messageCount);

  return (
    <div style={{ width }}>
      <button
        type="button"
        data-testid="scroll-to-beginning"
        onClick={() => void listRef.current?.scrollToIndex({ index: 0, animated: false })}
      >
        Go to beginning
      </button>
      <output data-testid="opened-source">{openedSource}</output>
      <div style={{ height: 360 }}>
        <MessagesTimeline
          hasMessages={timelineEntries.length > 0}
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          listRef={listRef}
          timelineEntries={timelineEntries}
          forkProvenance={provenance}
          turnDiffSummaryByAssistantMessageId={new Map()}
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          onOpenThread={(threadId) => setOpenedSource(threadId)}
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

describe("MessagesTimeline fork provenance", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("identifies and opens the source of a message-boundary fork with keyboard access", async () => {
    const screen = await render(
      <ForkTimeline
        width={300}
        messageCount={1}
        provenance={{
          sourceThreadId: SOURCE_ID,
          sourceMessageId: MessageId.makeUnsafe("source-message"),
          sourceTitle: "Source-experiment-with-a-deliberately-unbroken-long-title",
          sourceAvailable: true,
        }}
      />,
    );

    try {
      const note = page.getByRole("note", { name: "Fork provenance" });
      await expect.element(note).toBeVisible();
      await expect
        .element(note)
        .toHaveTextContent(
          "Forked from a message in Source-experiment-with-a-deliberately-unbroken-long-title",
        );

      const sourceButtonElement = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Open source conversation: Source-experiment-with-a-deliberately-unbroken-long-title"]',
      );
      expect(sourceButtonElement).not.toBeNull();
      sourceButtonElement?.focus();
      expect(document.activeElement).toBe(sourceButtonElement);
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByTestId("opened-source")).toHaveTextContent(SOURCE_ID);
      const scrollContainer = document.querySelector<HTMLElement>(
        '[data-chat-scroll-container="true"]',
      );
      expect(scrollContainer).not.toBeNull();
      expect(scrollContainer!.scrollWidth).toBeLessThanOrEqual(scrollContainer!.clientWidth);
    } finally {
      await screen.unmount();
    }
  });

  it("renders a non-interactive unavailable-source fallback without horizontal overflow", async () => {
    const screen = await render(
      <ForkTimeline
        width={300}
        messageCount={0}
        provenance={{
          sourceThreadId: SOURCE_ID,
          sourceMessageId: null,
          sourceTitle: null,
          sourceAvailable: false,
        }}
      />,
    );

    try {
      const note = page.getByRole("note", { name: "Fork provenance" });
      await expect.element(note).toBeVisible();
      await expect
        .element(note)
        .toHaveTextContent("Forked from another conversation · Source unavailable");
      expect(document.querySelector('[data-fork-provenance="true"] button')).toBeNull();
      const scrollContainer = document.querySelector<HTMLElement>(
        '[data-chat-scroll-container="true"]',
      );
      expect(scrollContainer).not.toBeNull();
      expect(scrollContainer!.scrollWidth).toBeLessThanOrEqual(scrollContainer!.clientWidth);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps provenance as the first virtualized row in a large restored transcript", async () => {
    const screen = await render(
      <ForkTimeline
        messageCount={120}
        provenance={{
          sourceThreadId: SOURCE_ID,
          sourceMessageId: null,
          sourceTitle: "Restored source",
          sourceAvailable: true,
        }}
      />,
    );

    try {
      await userEvent.click(page.getByTestId("scroll-to-beginning"));
      await expect
        .poll(() => document.querySelector('[data-timeline-row-kind="fork-provenance"]') !== null)
        .toBe(true);
      const provenanceRow = document.querySelector<HTMLElement>(
        '[data-timeline-row-kind="fork-provenance"]',
      );
      const firstMessageRow = document.querySelector<HTMLElement>('[data-message-id="message-0"]');
      expect(provenanceRow).not.toBeNull();
      expect(firstMessageRow).not.toBeNull();
      expect(provenanceRow!.getBoundingClientRect().top).toBeLessThan(
        firstMessageRow!.getBoundingClientRect().top,
      );
      await expect
        .element(page.getByRole("button", { name: "Open source conversation: Restored source" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
