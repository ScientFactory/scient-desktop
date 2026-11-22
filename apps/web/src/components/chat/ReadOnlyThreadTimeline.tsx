import type { LegendListRef } from "@legendapp/list/react";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { T } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { SideThreadsOpenContext } from "~/hooks/useSideThreadTrigger";
import { useTheme } from "~/hooks/useTheme";
import { deriveActiveWorkStartedAt, derivePhase } from "~/session-logic";
import type { ChatFileAttachment } from "~/types";

import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { MessagesTimeline, type MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { TimelineRow, TurnItemSource } from "./timelineRowContext";
// SCIENT-FORK: Scient's reading end (chat/useReadingFollow.ts).
import { useReadingFollow } from "./useReadingFollow";

// The timeline needs an environment id to key its rows. No environment answers to this one, so a
// row that would ask the thread's environment for something gets nothing.
const NO_ENVIRONMENT_ID = EnvironmentId.make("guest");
const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
const ignore = () => {};

/**
 * A thread's own timeline, built from its projection alone and read-only: every action that would
 * reach the thread's environment (fork, revert, reply, diffs, files, other threads, shell,
 * approvals) is left out, so its control does not render. The guest page and a linked
 * environment's thread both show a thread this way.
 */
export function ReadOnlyThreadTimeline(props: {
  /** Keys the list. It holds no ":" so the timeline finds no environment thread behind it. */
  readonly threadKey: string;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
  /** Where expanded rows read an item's detail. */
  readonly turnItemSource: TurnItemSource;
  /** Preview URLs for the messages' attachments, keyed by attachment id. */
  readonly attachmentUrls: (
    items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  ) => ReadonlyMap<string, string>;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (file: ChatFileAttachment) => void;
  readonly renderHtmlRender: (row: Extract<TimelineRow, { kind: "html-render" }>) => ReactNode;
  readonly renderFooter?: (items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) => ReactNode;
  /** What stands below the timeline, where the composer would. */
  readonly children: (controls: { readonly scrollToEnd: () => void }) => ReactNode;
}) {
  const { threadKey, projection } = props;
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  // The rest is what ChatView derives from the same projection.
  const [projectQuestionHistory] = useState(() => createQuestionHistoryProjector());
  const items = projectQuestionHistory(projection);
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: items,
    optimisticMessages: NO_OPTIMISTIC_MESSAGES,
    attachmentUrlById: props.attachmentUrls(items),
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
  });
  const activityRun = deriveThreadActivityRun(projection);
  const runtime = deriveThreadStructureRuntime(projection);
  const runlessWorkStartedAt = deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const workStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const runningRunId = runtime?.activeRunId ?? null;
  // SCIENT-FORK:START
  const currentRouteThreadKeyRef = useRef<string | null>(threadKey);
  // SCIENT-FORK:END
  const follow = useReadingFollow({
    legendListRef: listRef,
    composerOverlayElement: null,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    // Not a server thread: new turns follow the end instead of anchoring near the top.
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: activityRun,
    activeRunningTurnId: runningRunId,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    // SCIENT-FORK:START — Scient's reading end (chat/useTimelineFollow.ts).
    timelineMessages: entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    isDraftHeroState: false,
    hasLatestRun: activityRun !== null,
    turnUnfinished: isWorking,
    currentRouteThreadKeyRef,
    // SCIENT-FORK:END
    setTimelineAnchor: ignore,
  });
  return (
    <>
      <div className="relative min-h-0 flex-1">
        <SideThreadsOpenContext value={false}>
          <MessagesTimeline
            listRef={listRef}
            timelineEntries={entries}
            isWorking={isWorking}
            activeTurnStartedAt={workStartedAt}
            latestRun={activityRun}
            runningRunId={runningRunId}
            turnDiffSummaries={NO_TURN_DIFFS}
            runs={projection.runs}
            routeThreadKey={threadKey}
            onOpenThread={ignore}
            supportsConversationRollback={false}
            onRevertToTurnCount={ignore}
            isRevertingCheckpoint={false}
            onImageExpand={props.onImageExpand}
            onFileOpen={props.onFileOpen}
            onFileDownload={props.onFileOpen}
            renderHtmlRender={props.renderHtmlRender}
            turnItemSource={props.turnItemSource}
            historyControls={props.historyControls}
            activeThreadEnvironmentId={NO_ENVIRONMENT_ID}
            markdownCwd={undefined}
            resolvedTheme={resolvedTheme}
            timestampFormat="locale"
            workspaceRoot={undefined}
            anchorMessageId={null}
            onAnchorReady={ignore}
            onAnchorSizeChanged={ignore}
            contentInsetEndAdjustment={0}
            emptyPlaceholderInset={0}
            // SCIENT-FORK:START — Scient's reading end; it never live-follows, so a reader at the
            // end stays there as the footer grows.
            onIsAtEndChange={follow.onIsAtEndChange}
            onViewportAttach={follow.attachTimelineViewport}
            onFooterGrow={() => {
              if (follow.isTimelineAtLogicalEndStable()) follow.scrollToEnd();
            }}
            // SCIENT-FORK:END
            footer={props.renderFooter?.(items) ?? null}
          />
        </SideThreadsOpenContext>
        {/* SCIENT-FORK:START — Scient's reading end replaces the shared Scroll to end button. */}
        {follow.showScrollToBottom ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
            <Button
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => follow.scrollToEnd(true)}
              className="pointer-events-auto"
              size="xs"
              variant="glass"
            >
              <ChevronDownIcon className="size-3.5" />
              <T>Scroll to end</T>
            </Button>
          </div>
        ) : null}
        {/* SCIENT-FORK:END */}
      </div>
      {props.children({ scrollToEnd: () => follow.scrollToEnd(true) })}
    </>
  );
}
