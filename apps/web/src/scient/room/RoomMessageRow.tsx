import {
  AuthOrchestrationOperateScope,
  type ChatAttachment,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
  type RoomAuthor,
  type RoomMessageAttribution,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowUpIcon, XIcon } from "lucide-react";
import { type ComponentType, createContext, use, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { GuestMessageAttachments } from "~/components/chat/GuestMessageAttachments";
import { TimelineRowCtx } from "~/components/chat/timelineRowContext";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { isImageAttachment } from "~/types";

export type RoomMessageItem = Extract<OrchestrationV2TurnItem, { readonly type: "room_message" }>;

/** Who reads the thread: the owner, or one participant on the guest page. */
export type RoomViewer =
  | { readonly kind: "owner" }
  | { readonly kind: "guest"; readonly participantId: string };

/** What a viewer can do with a message the agent has not been given. */
export interface RoomMessageActions {
  readonly viewer: RoomViewer;
  readonly canSendToAgent: boolean;
  /** Deleting anyone's message; people can always delete their own. */
  readonly canDelete: boolean;
  /** Draws a message's files where this viewer can open them. */
  readonly Attachments: ComponentType<{ readonly item: RoomMessageItem }>;
  readonly onSend: (item: RoomMessageItem) => Promise<void>;
  readonly onDelete: (item: RoomMessageItem) => Promise<void>;
}

/** The guest page's actions. Without it, the rows act for the owner of the thread. */
export const RoomGuestActionsContext = createContext<RoomMessageActions | null>(null);

/** The viewer, for the rows that say who sent a message on. */
export const RoomViewerContext = createContext<RoomViewer>({ kind: "owner" });

const PERSON_CLASSES = [
  "room-person-0",
  "room-person-1",
  "room-person-2",
  "room-person-3",
  "room-person-4",
  "room-person-5",
] as const;

/**
 * Each person keeps one colour, set as the guest colour for what is inside: the owner's is fixed
 * (null), a guest's follows their participant id.
 */
export function roomPersonClass(participantId: string | null): string {
  if (participantId === null) return "room-person-owner";
  let hash = 0;
  for (const char of participantId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PERSON_CLASSES[hash % PERSON_CLASSES.length] ?? "room-person-0";
}

/** The colour of a message's writer. */
export const roomPersonClassOf = (author: RoomAuthor) =>
  roomPersonClass(author.kind === "guest" ? author.participantId : null);

const isViewer = (viewer: RoomViewer, author: RoomAuthor) =>
  author.kind === "owner"
    ? viewer.kind === "owner"
    : viewer.kind === "guest" && viewer.participantId === author.participantId;

function authorLabel(author: RoomAuthor, viewer: RoomViewer): string {
  if (isViewer(viewer, author)) return "You";
  return author.kind === "owner" ? "Owner" : author.name;
}

/**
 * A message people can read and the agent cannot yet: drawn like a queued message, in its
 * writer's colour. Once sent, it leaves the thread and returns as the agent's next message.
 */
export function RoomMessageRow({ item }: { readonly item: RoomMessageItem }) {
  const guest = use(RoomGuestActionsContext);
  const { threadRef } = use(TimelineRowCtx);
  if (guest !== null) return <RoomMessageCard item={item} actions={guest} />;
  if (threadRef === null) return <RoomMessageCard item={item} actions={null} />;
  return <OwnerRoomMessageRow item={item} threadRef={threadRef} />;
}

const OWNER = { kind: "owner" } as const;

function OwnerRoomMessageRow({
  item,
  threadRef,
}: {
  readonly item: RoomMessageItem;
  readonly threadRef: ScopedThreadRef;
}) {
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const sendRoomMessage = useOrchestrationCommand(threadEnvironment.sendRoomMessage, {
    label: "send message to agent",
  });
  const roomAction = useOrchestrationCommand(threadEnvironment.roomAction, {
    label: "delete message",
  });
  const target = { environmentId: threadRef.environmentId };
  return (
    <OwnerThreadContext value={threadRef}>
      <RoomMessageCard
        item={item}
        actions={{
          viewer: OWNER,
          canSendToAgent: canOperate,
          canDelete: canOperate,
          Attachments: OwnerRoomAttachments,
          onSend: async (message) => {
            await sendRoomMessage({
              ...target,
              input: { threadId: threadRef.threadId, itemId: message.id },
            });
          },
          onDelete: async (message) => {
            await roomAction({
              ...target,
              input: {
                threadId: threadRef.threadId,
                action: { type: "delete", itemId: message.id },
              },
            });
          },
        }}
      />
    </OwnerThreadContext>
  );
}

const OwnerThreadContext = createContext<ScopedThreadRef | null>(null);

/** A message's files, served by the owner's environment and opened in the side panel. */
function OwnerRoomAttachments({ item }: { readonly item: RoomMessageItem }) {
  const threadRef = use(OwnerThreadContext);
  const images = (item.attachments ?? []).filter(isImageAttachment);
  const urls = useAssetUrls(
    threadRef?.environmentId ?? ("" as EnvironmentId),
    images.map((image) => ({ _tag: "attachment" as const, attachmentId: image.id })),
  );
  if (threadRef === null) return null;
  const open = (attachment: ChatAttachment) => {
    if (attachment.type !== "file" && attachment.type !== "image") return;
    useRightPanelStore.getState().openAttachment(threadRef, {
      type: "file",
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  };
  return (
    <GuestMessageAttachments
      attachments={item.attachments ?? []}
      imageUrl={(attachment) =>
        urls[images.findIndex((image) => image.id === attachment.id)] ?? undefined
      }
      onOpenImage={open}
      onOpenFile={open}
    />
  );
}

function RoomMessageCard({
  item,
  actions,
}: {
  readonly item: RoomMessageItem;
  readonly actions: RoomMessageActions | null;
}) {
  const [busy, setBusy] = useState(false);
  const viewer = actions?.viewer ?? OWNER;
  const mine = isViewer(viewer, item.author);
  const author = authorLabel(item.author, viewer);
  const canSend = actions?.canSendToAgent === true;
  const canDelete = actions !== null && (actions.canDelete || mine);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  return (
    <article
      className={cn("group flex flex-col items-end gap-1", roomPersonClassOf(item.author))}
      aria-label={`${author}, not sent to the agent`}
      data-room-message={item.roomMessageId}
    >
      <p className="me-1 text-2xs text-guest-foreground">{author}</p>
      {/* Dashed and unfilled, like a queued message: the agent has not been given it. */}
      <div className="flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl border border-dashed border-guest/50 px-3 py-2 text-sm text-muted-foreground">
        {(item.attachments?.length ?? 0) > 0 && actions !== null ? (
          <actions.Attachments item={item} />
        ) : null}
        {item.text ? (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</p>
        ) : null}
      </div>
      {canSend || canDelete ? (
        <div className="flex items-center gap-1">
          {canSend ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              aria-label={mine ? "Send to agent" : `Send ${author}'s message to agent`}
              onClick={() => run(() => actions.onSend(item))}
            >
              <ArrowUpIcon />
              Send to agent
            </Button>
          ) : null}
          {canDelete ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label="Delete message"
                    onClick={() => run(() => actions.onDelete(item))}
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Delete</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Above a message from a thread room, on one line: who sent it on to the agent when that was
 * someone else, then who wrote it, in their colour. The owner's own message needs neither.
 */
export function RoomSentLine({ room }: { readonly room: RoomMessageAttribution }) {
  const viewer = use(RoomViewerContext);
  const { author, sentBy } = room;
  const sameSender =
    author.kind === sentBy.kind &&
    (author.kind !== "guest" ||
      (sentBy.kind === "guest" && author.participantId === sentBy.participantId));
  if (sameSender && author.kind === "owner") return null;
  return (
    <p className="me-1 text-2xs text-muted-foreground">
      {/* The writer's name ends the line, where it sits above every message of theirs. */}
      {sameSender ? null : `Sent by ${authorLabel(sentBy, viewer)} · `}
      <span className="text-guest-foreground">{authorLabel(author, viewer)}</span>
    </p>
  );
}
