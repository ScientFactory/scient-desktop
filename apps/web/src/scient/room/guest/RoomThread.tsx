import type { LegendListRef } from "@legendapp/list/react";
import {
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
import { T, useGT, useMessages } from "gt-react";
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
import { useReadingFollow } from "~/components/chat/useReadingFollow";
import { Button } from "~/components/ui/button";
import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { deriveActiveWorkStartedAt, derivePhase } from "~/session-logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { RoomAgentToggle } from "../RoomAgentToggle";
import { useRoomDirectStore } from "../roomDirectStore";
import {
  RoomGuestActionsContext,
  type RoomMessageItem,
  RoomViewerContext,
  roomPersonClass,
} from "../RoomMessageRow";
import { RoomComposeBox } from "./RoomComposeBox";
import { RoomHtmlRender } from "./RoomHtmlRender";
import {
  createRoomAttachmentUrls,
  formatRoomExpiry,
  roomAttachmentUrl,
  roomRoleLabel,
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
  const gt = useGT();
  const messages = useMessages();
  const participantId = view.me.participantId;
  const viewer = { kind: "guest", participantId } as const;
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
  const role = view.me.role;
  const directKey = `guest:${participantId}`;
  const direct =
    useRoomDirectStore((state) => state.direct[directKey] === true) && role === "agent";
  // A message is for everyone here until someone sends it to the agent, unless this person
  // turned on "straight to the agent".
  const post = async (text: string, files: ReadonlyArray<File>) => {
    const form = new FormData();
    form.append("text", text);
    form.append("to", direct ? "agent" : "people");
    for (const file of files) form.append("file", file, file.name);
    const failure = await postRoom(participantId, "messages", form);
    if (failure === null) void follow.scrollToEnd(true);
    return failure;
  };
  const stop = async () => {
    setStopping(true);
    setError(await postRoom(participantId, "stop", undefined));
    setStopping(false);
  };
  const guestActions = {
    viewer,
    canSendToAgent: role === "agent",
    canDelete: false,
    canDeleteOwn: role !== "watch",
    Attachments: RoomAttachments,
    onSend: (item: RoomMessageItem) => action("send", item),
    onDelete: (item: RoomMessageItem) => action("delete", item),
  };
  return (
    <ParticipantContext value={participantId}>
      <RoomViewerContext value={viewer}>
        <RoomGuestActionsContext value={guestActions}>
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{view.title}</h1>
            <RoomFaces
              view={view}
              expiry={formatRoomExpiry(view.expiresAt, Date.parse(`${nowMinute}Z`), messages)}
            />
            {role === "agent" && isWorking ? (
              <Button size="xs" variant="outline" disabled={stopping} onClick={() => void stop()}>
                <T>Stop agent</T>
              </Button>
            ) : null}
          </header>
          {error !== null ? (
            <p role="alert" className="px-4 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="relative flex min-h-0 flex-1">
            <section
              aria-label={gt("Thread", { $context: "the conversation" })}
              className="flex min-w-0 flex-1 flex-col"
            >
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
                    onViewportAttach={follow.attachTimelineViewport}
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
                        <T>Scroll to end</T>
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
              {role !== "watch" ? (
                <div className="chat-content-lane shrink-0 px-4 pb-4">
                  <RoomComposeBox
                    placeholder={direct ? gt("Message the agent") : gt("Message everyone")}
                    onSubmit={post}
                    agentSwitch={
                      role === "agent" ? (
                        <RoomAgentToggle
                          on={direct}
                          onChange={(on) => useRoomDirectStore.getState().setDirect(directKey, on)}
                        />
                      ) : undefined
                    }
                  />
                </div>
              ) : null}
            </section>
          </div>
        </RoomGuestActionsContext>
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
  const gt = useGT();
  const messages = useMessages();
  return (
    <ul aria-label={gt("People")} className="flex shrink-0 -space-x-1">
      {view.participants.map((person) => {
        const me = person.participantId === view.me.participantId;
        const name = me ? gt("{name} (you)", { name: person.name }) : person.name;
        const role = roomRoleLabel(person.role, messages);
        return (
          <li key={person.participantId}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border-2 border-background bg-guest-surface text-[10px] font-medium text-guest-foreground",
                      roomPersonClass(person.participantId),
                      !person.online && "opacity-45",
                    )}
                  />
                }
              >
                {initialsOf(person.name)}
                <span className="sr-only">
                  {person.online
                    ? gt("{name}, {role}, here now", { name, role })
                    : gt("{name}, {role}", { name, role })}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {name} · {role}
                {me ? ` · ${expiry}` : ""}
              </TooltipPopup>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
