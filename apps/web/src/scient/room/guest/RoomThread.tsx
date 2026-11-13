import type { LegendListRef } from "@legendapp/list/react";
import {
  ROOM_ROLE_LABEL,
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type RoomGuestView,
  type RoomReplyTarget,
} from "@t3tools/contracts";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import { ChevronDownIcon } from "lucide-react";
import { createContext, use, useRef, useState } from "react";

import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import { GuestMessageAttachments } from "~/components/chat/GuestMessageAttachments";
import { HostImageUrlContext } from "~/components/chat/hostImageUrl";
import {
  MessagesTimeline,
  type MessagesTimelineHistoryControls,
} from "~/components/chat/MessagesTimeline";
import type { TimelineRow } from "~/components/chat/timelineRowContext";
import { useTimelineFollow } from "~/components/chat/useTimelineFollow";
import { Button } from "~/components/ui/button";
import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { deriveActiveWorkStartedAt, derivePhase } from "~/session-logic";
import { RoomTimelineContext, type RoomMessageItem } from "../RoomMessageRow";
import { RoomComposer } from "./RoomComposer";
import { RoomHtmlRender } from "./RoomHtmlRender";
import {
  createRoomAttachmentUrls,
  formatRoomExpiry,
  roomAttachmentUrl,
  roomUrl,
} from "./roomGuest.logic";
import { postRoom } from "./roomGuestApi";
import { roomTurnItemSource } from "./roomTurnItemSource";

const ROOM_ENVIRONMENT_ID = EnvironmentId.make("room-guest");
const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
const ignore = () => {};
const openInNewTab = (url: string) => {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
};
const openExpandedImage = (preview: ExpandedImagePreview) => {
  const src = preview.images[preview.index]?.src;
  if (src) openInNewTab(src);
};
const ParticipantContext = createContext("");

function RoomAttachments({ item }: { readonly item: RoomMessageItem }) {
  const participantId = use(ParticipantContext);
  const url = (file: { readonly id: string }) => roomAttachmentUrl(participantId, item.id, file.id);
  return (
    <GuestMessageAttachments
      attachments={item.attachments ?? []}
      imageUrl={url}
      onOpenImage={(file) => openInNewTab(url(file))}
      fileHref={url}
    />
  );
}

export function RoomThread({
  view,
  projection,
  historyControls,
}: {
  readonly view: RoomGuestView;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
}) {
  const participantId = view.me.participantId;
  const [reply, setReply] = useState<RoomReplyTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const nowMinute = useNowMinute();
  // No ":" so the timeline finds no environment thread behind the key.
  const threadKey = `room-guest-${participantId}`;
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const [projectQuestionHistory] = useState(() => createQuestionHistoryProjector());
  const items = projectQuestionHistory(projection);
  const [attachmentUrls] = useState(() => createRoomAttachmentUrls(participantId));
  const [turnItemSource] = useState(() => roomTurnItemSource(participantId));
  const attachmentUrlById = attachmentUrls(items);
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: items,
    optimisticMessages: NO_OPTIMISTIC_MESSAGES,
    attachmentUrlById,
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
  });
  const openFile = useStableCallback((file: { readonly id: string }) =>
    openInNewTab(attachmentUrlById.get(file.id) ?? ""),
  );
  const hostImageUrl = useStableCallback((path: string) =>
    roomUrl("media", participantId, { path }),
  );
  const activityRun = deriveThreadActivityRun(projection);
  const runtime = deriveThreadStructureRuntime(projection);
  const runlessWorkStartedAt = deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const workStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const runningRunId = runtime?.activeRunId ?? null;
  const currentRouteThreadKeyRef = useRef<string | null>(threadKey);
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerOverlayElement: null,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    // Not a server thread: new turns follow the end instead of anchoring near the top.
    isServerThread: false,
    serverProjection: null,
    timelineMessages: entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    isDraftHeroState: false,
    hasLatestRun: activityRun !== null,
    turnUnfinished: isWorking,
    currentRouteThreadKeyRef,
    setTimelineAnchor: ignore,
  });
  const renderHtmlRender = useStableCallback(
    (row: Extract<TimelineRow, { kind: "html-render" }>) => (
      <RoomHtmlRender itemId={row.id} reference={row.htmlRender} participantId={participantId} />
    ),
  );
  const action = async (path: "send" | "delete", item: RoomMessageItem) => {
    setError(await postRoom(participantId, path, { itemId: item.id }));
  };
  const stop = async () => {
    setStopping(true);
    setError(await postRoom(participantId, "stop", undefined));
    setStopping(false);
  };
  return (
    <ParticipantContext value={participantId}>
      <RoomTimelineContext
        value={{
          viewer: { kind: "guest", participantId },
          canPost: view.me.role !== "watch",
          canSendToAgent: view.me.role === "agent",
          canDelete: false,
          Attachments: RoomAttachments,
          onReply: setReply,
          onSend: (item) => action("send", item),
          onDelete: (item) => action("delete", item),
        }}
      >
        <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{view.title}</h1>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatRoomExpiry(view.expiresAt, Date.parse(`${nowMinute}Z`))}
            </span>
            {view.me.role === "agent" && isWorking ? (
              <Button size="sm" variant="outline" disabled={stopping} onClick={() => void stop()}>
                Stop agent
              </Button>
            ) : null}
          </div>
          <ul
            aria-label="People in the room"
            className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
          >
            {view.participants.map((person) => (
              <li key={person.participantId} className="flex items-center gap-1.5">
                <span
                  role="img"
                  aria-label={person.online ? "Online" : "Offline"}
                  className={
                    person.online
                      ? "size-1.5 rounded-full bg-success"
                      : "size-1.5 rounded-full bg-muted-foreground/40"
                  }
                />
                <span>
                  {person.name}
                  {person.participantId === participantId ? " (you)" : ""} ·{" "}
                  {ROOM_ROLE_LABEL[person.role]}
                </span>
              </li>
            ))}
          </ul>
        </header>
        {error !== null ? (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="relative min-h-0 flex-1">
          <HostImageUrlContext value={hostImageUrl}>
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
              onImageExpand={openExpandedImage}
              onFileOpen={openFile}
              onFileDownload={openFile}
              renderHtmlRender={renderHtmlRender}
              turnItemSource={turnItemSource}
              historyControls={historyControls}
              activeThreadEnvironmentId={ROOM_ENVIRONMENT_ID}
              markdownCwd={undefined}
              resolvedTheme={resolvedTheme}
              timestampFormat="locale"
              workspaceRoot={undefined}
              anchorMessageId={null}
              onAnchorReady={ignore}
              onAnchorSizeChanged={ignore}
              contentInsetEndAdjustment={0}
              emptyPlaceholderInset={0}
              onIsAtEndChange={follow.onIsAtEndChange}
              onManualNavigation={follow.cancelTimelinePositioning}
              cancelPositionRestoreRef={follow.cancelPositionRestoreRef}
            />
          </HostImageUrlContext>
          {follow.showScrollToBottom ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
              <div className="pointer-events-auto">
                <Button
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => follow.scrollToEnd(true)}
                  size="xs"
                  variant="glass"
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to end
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="chat-content-lane shrink-0 px-4 pb-4">
          <RoomComposer
            participantId={participantId}
            role={view.me.role}
            reply={reply}
            onCancelReply={() => setReply(null)}
            onSent={(sentReply) => {
              setReply((current) => (current === sentReply ? null : current));
              follow.scrollToEnd(true);
            }}
          />
        </div>
      </RoomTimelineContext>
    </ParticipantContext>
  );
}
