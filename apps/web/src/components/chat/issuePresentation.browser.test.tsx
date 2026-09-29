import "../../index.css";
import { EnvironmentId, EventId, MessageId, TurnId, ApprovalRequestId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { MessagesTimeline } from "./MessagesTimeline";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";

const listRef = createRef<LegendListRef>();
const env = EnvironmentId.make("issue-presentation-fixture");
const base = {
  listRef,
  isWorking: false,
  activeTurnStartedAt: null,
  latestTurn: null,
  runningTurnId: null,
  turnDiffSummaries: [],
  onOpenTurnDiff: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: env,
  markdownCwd: undefined,
  resolvedTheme: "light" as const,
  timestampFormat: "locale" as const,
  workspaceRoot: undefined,
  anchorMessageId: null,
  onAnchorReady: () => {},
  contentInsetEndAdjustment: 100,
  onIsAtEndChange: vi.fn(),
  onManualNavigation: () => {},
};

it("keeps a successful answer clean and puts retry feedback on its approval", async () => {
  await page.viewport(1000, 800);
  const host = document.createElement("div");
  Object.assign(host.style, {
    width: "900px",
    height: "650px",
    display: "flex",
    flexDirection: "column",
    background: "white",
    color: "black",
  });
  document.body.append(host);
  const root = createRoot(host);
  const date = "2026-09-29T00:00:00.000Z";
  const turnId = TurnId.make("fixture-turn");
  const activities = [
    {
      id: EventId.make("capture-failure"),
      kind: "checkpoint.capture.failed",
      tone: "error" as const,
      summary: "Checkpoint capture failed",
      createdAt: date,
      turnId,
      payload: {
        detail:
          "VCS process failed in GitVcsDriver.checkpoints.captureCheckpoint: git status (/example/project) exited with 1 - Changed files exceed the checkpoint capture size limit (512 MiB per file, 1 GiB total).",
      },
    },
  ];
  const messages = [
    {
      id: MessageId.make("user"),
      role: "user" as const,
      text: "hey, are you there?",
      turnId,
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
    {
      id: MessageId.make("answer"),
      role: "assistant" as const,
      text: "Here. What do you need?",
      turnId,
      createdAt: date,
      updatedAt: date,
      streaming: false,
    },
  ];
  try {
    flushSync(() =>
      root.render(
        <>
          <div style={{ height: "500px" }}>
            <MessagesTimeline
              {...base}
              routeThreadKey="fixture"
              timelineEntries={deriveTimelineEntries(
                messages,
                [],
                deriveWorkLogEntries(activities),
              )}
            />
          </div>
          <div style={{ padding: "24px", borderTop: "1px solid #ddd" }}>
            <ComposerPendingApprovalPanel
              approval={{
                requestId: ApprovalRequestId.make("approval"),
                requestKind: "command",
                createdAt: date,
                detail: "git status",
                responseError: "Approval could not be sent. Try again.",
              }}
              pendingCount={1}
            />
          </div>
        </>,
      ),
    );
    await expect.poll(() => host.textContent).toContain("Here. What do you need?");
    if (import.meta.env.VITE_SCIENT_ISSUE_SCREENSHOT) {
      await page.screenshot({ path: import.meta.env.VITE_SCIENT_ISSUE_SCREENSHOT, element: host });
    }
    expect(host.textContent).not.toContain("VCS process failed");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Approval could not be sent. Try again.",
    );
  } finally {
    root.unmount();
    host.remove();
  }
});
