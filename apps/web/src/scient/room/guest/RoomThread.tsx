import type { LegendListRef } from "@legendapp/list/react";
import {
  ROOM_ROLE_LABEL,
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type RoomGuestView,
} from "@t3tools/contracts";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import { ChevronDownIcon, MessagesSquareIcon, XIcon } from "lucide-react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  RoomChat,
  RoomComposeBox,
  RoomViewerContext,
  type RoomMessageItem,
  roomChatMessages,
} from "../RoomChat";
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
    // The shared attachment layout aligns to the end; chat lines read from the start.
    <div className="[&>div]:items-start">
      <GuestMessageAttachments
        attachments={item.attachments ?? []}
        imageUrl={url}
        onOpenImage={(file) => openInNewTab(url(file))}
        fileHref={url}
      />
    </div>
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
  const viewer = { kind: "guest", participantId } as const;
  const [chatOpen, setChatOpen] = useState(false);
  const [seenCount, setSeenCount] = useState(0);
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
  const post = (to: "people" | "agent") => async (text: string, files: ReadonlyArray<File>) => {
    const form = new FormData();
    form.append("text", text);
    form.append("to", to);
    for (const file of files) form.append("file", file, file.name);
    const failure = await postRoom(participantId, "messages", form);
    if (failure === null && to === "agent") follow.scrollToEnd(true);
    return failure;
  };
  const stop = async () => {
    setStopping(true);
    setError(await postRoom(participantId, "stop", undefined));
    setStopping(false);
  };
  const role = view.me.role;
  const messages = roomChatMessages(projection.turnItems);
  // On a phone the chat is closed while reading the thread; a dot says something new came in.
  if (chatOpen && seenCount !== messages.length) setSeenCount(messages.length);
  const unread = !chatOpen && messages.length > seenCount;
  const chat = (
    <RoomChat
      messages={messages}
      actions={{
        viewer,
        canPost: role !== "watch",
        canSendToAgent: role === "agent",
        canDelete: false,
        Attachments: RoomAttachments,
        onPost: post("people"),
        onSend: (item) => action("send", item),
        onDelete: (item) => action("delete", item),
      }}
    />
  );
  return (
    <ParticipantContext value={participantId}>
      <RoomViewerContext value={viewer}>
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{view.title}</h1>
          <RoomFaces
            view={view}
            expiry={formatRoomExpiry(view.expiresAt, Date.parse(`${nowMinute}Z`))}
          />
          {role === "agent" && isWorking ? (
            <Button size="xs" variant="outline" disabled={stopping} onClick={() => void stop()}>
              Stop agent
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            className="relative md:hidden"
            aria-label={chatOpen ? "Close chat" : unread ? "Chat, new messages" : "Chat"}
            aria-pressed={chatOpen}
            onClick={() => setChatOpen((open) => !open)}
          >
            {chatOpen ? <XIcon /> : <MessagesSquareIcon />}
            {unread ? (
              <span
                aria-hidden
                className="absolute end-0.5 top-0.5 size-1.5 rounded-full bg-primary"
              />
            ) : null}
          </Button>
        </header>
        {error !== null ? (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="relative flex min-h-0 flex-1">
          <section aria-label="Thread" className="flex min-w-0 flex-1 flex-col">
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
            {role === "agent" ? (
              <div className="chat-content-lane shrink-0 px-4 pb-4">
                <RoomComposeBox placeholder="Message the agent" onSubmit={post("agent")} />
              </div>
            ) : null}
          </section>
          {/* Beside the thread on wide screens; over it on a phone, when opened. */}
          <aside
            aria-label="Chat"
            className={cn(
              "flex-col border-border bg-background md:flex md:w-80 md:shrink-0 md:border-s",
              chatOpen ? "absolute inset-0 z-40 flex md:static" : "hidden",
            )}
          >
            {chat}
          </aside>
        </div>
      </RoomViewerContext>
    </ParticipantContext>
  );
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/u)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/** Who is here: one face per person, with their permission on hover. */
function RoomFaces({ view, expiry }: { readonly view: RoomGuestView; readonly expiry: string }) {
  return (
    <ul aria-label="People" className="flex shrink-0 -space-x-1">
      {view.participants.map((person) => {
        const me = person.participantId === view.me.participantId;
        return (
          <li key={person.participantId}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border-2 border-background bg-accent text-[10px] font-medium text-foreground",
                      !person.online && "opacity-45",
                    )}
                  />
                }
              >
                {initialsOf(person.name)}
                <span className="sr-only">
                  {me ? `${person.name} (you)` : person.name}, {ROOM_ROLE_LABEL[person.role]}
                  {person.online ? ", here now" : ""}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {me ? `${person.name} (you)` : person.name} · {ROOM_ROLE_LABEL[person.role]}
                {me ? ` · ${expiry}` : ""}
              </TooltipPopup>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
