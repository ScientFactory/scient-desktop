import type {
  OrchestrationV2TurnItem,
  RoomAuthor,
  RoomMessageAttribution,
  RoomReplyTarget,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CornerUpLeftIcon, SendIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { type ComponentType, createContext, use, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type RoomMessageItem = Extract<OrchestrationV2TurnItem, { readonly type: "room_message" }>;

/** Who reads the timeline: the owner, or one participant on the guest page. */
export type RoomViewer =
  | { readonly kind: "owner" }
  | { readonly kind: "guest"; readonly participantId: string };

/** What the room's rows can do here. Without it, rows only show the messages. */
export interface RoomTimelineActions {
  readonly viewer: RoomViewer;
  readonly canPost: boolean;
  readonly canSendToAgent: boolean;
  /** Deleting anyone's message; people can always delete their own. */
  readonly canDelete: boolean;
  /** Draws a message's files where this viewer can open them. */
  readonly Attachments: ComponentType<{ readonly item: RoomMessageItem }>;
  readonly onReply: (target: RoomReplyTarget) => void;
  readonly onSend: (item: RoomMessageItem) => Promise<void>;
  readonly onDelete: (item: RoomMessageItem) => Promise<void>;
}

export const RoomTimelineContext = createContext<RoomTimelineActions | null>(null);

const isViewer = (viewer: RoomViewer | undefined, author: RoomAuthor) =>
  viewer !== undefined &&
  (author.kind === "owner"
    ? viewer.kind === "owner"
    : viewer.kind === "guest" && viewer.participantId === author.participantId);

/** How a room shows an author's name to this viewer. */
export function roomAuthorLabel(author: RoomReplyTarget["author"], viewer?: RoomViewer): string {
  if (author.kind === "agent") return "Agent";
  if (isViewer(viewer, author)) return "You";
  return author.kind === "owner" ? "Owner" : author.name;
}

const timeOf = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const EXCERPT_PREVIEW = 140;

/** A message posted to people: it keeps its place; sending it to the agent adds a new message. */
export function RoomMessageRow({ item }: { readonly item: RoomMessageItem }) {
  const actions = use(RoomTimelineContext);
  const [busy, setBusy] = useState<"send" | "delete" | null>(null);
  const viewer = actions?.viewer;
  const mine = isViewer(viewer, item.author);
  const deleted = item.deletedAt !== undefined;
  const lastSend = item.deliveries?.findLast((delivery) => delivery.status === "sent");
  const cancelled =
    lastSend === undefined && item.deliveries?.some((delivery) => delivery.status === "cancelled");
  const author = roomAuthorLabel(item.author, viewer);
  const canDelete = actions !== null && !deleted && (actions.canDelete || mine);
  const run = (kind: "send" | "delete", action: () => Promise<void>) => {
    setBusy(kind);
    void action().finally(() => setBusy(null));
  };

  const postedAt = item.startedAt ?? item.updatedAt;
  const replyTarget: RoomReplyTarget = {
    itemId: item.id,
    author: item.author,
    excerpt: item.text.slice(0, EXCERPT_PREVIEW),
  };

  return (
    <article
      className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}
      data-room-message={item.roomMessageId}
      aria-label={`${author}, to people`}
    >
      <p className="mx-1 flex items-center gap-1 text-2xs text-muted-foreground">
        <span className={item.author.kind === "guest" ? "text-guest-foreground" : undefined}>
          {author}
        </span>
        <span aria-hidden>·</span>
        <UsersIcon aria-hidden className="size-3" />
        <span>To people</span>
        <span aria-hidden>·</span>
        <time dateTime={DateTime.formatIso(postedAt)}>{timeOf(DateTime.formatIso(postedAt))}</time>
      </p>
      {item.replyTo !== undefined && !deleted ? (
        <p className="mx-1 max-w-[80%] truncate border-s-2 border-border ps-2 text-xs text-muted-foreground">
          {roomAuthorLabel(item.replyTo.author, viewer)}: {item.replyTo.excerpt}
        </p>
      ) : null}
      <div
        className={cn(
          "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl p-3",
          deleted
            ? "border border-dashed border-border text-muted-foreground"
            : item.author.kind === "guest"
              ? "bg-guest-surface text-message-foreground"
              : "border border-border text-message-foreground",
        )}
      >
        {deleted ? (
          <p className="text-sm italic">Message deleted</p>
        ) : (
          <>
            {actions !== null && (item.attachments?.length ?? 0) > 0 ? (
              <actions.Attachments item={item} />
            ) : null}
            {item.text ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                {item.text}
              </p>
            ) : null}
          </>
        )}
      </div>
      {!deleted && item.suggested === true && lastSend === undefined ? (
        <p className="mx-1 text-2xs text-guest-foreground">
          {mine
            ? "You suggested sending this to the agent"
            : `${author} suggests sending this to the agent`}
        </p>
      ) : null}
      {lastSend !== undefined ? (
        <p className="mx-1 text-2xs text-muted-foreground">
          Sent to the agent by {roomAuthorLabel(lastSend.by, viewer)} · {timeOf(lastSend.at)}
        </p>
      ) : cancelled ? (
        <p className="mx-1 text-2xs text-muted-foreground">Sending to the agent was cancelled</p>
      ) : null}
      {actions !== null && !deleted ? (
        <div className="flex items-center gap-1">
          {actions.canPost ? (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={`Reply to ${author}`}
              onClick={() => actions.onReply(replyTarget)}
            >
              <CornerUpLeftIcon aria-hidden />
              Reply
            </Button>
          ) : null}
          {actions.canSendToAgent ? (
            <Button
              size="xs"
              variant={
                item.suggested === true && lastSend === undefined ? "outline" : "ghost-muted"
              }
              disabled={busy !== null}
              aria-label={`Send ${mine ? "your" : `${author}'s`} message to the agent`}
              onClick={() => run("send", () => actions.onSend(item))}
            >
              <SendIcon aria-hidden />
              {lastSend === undefined ? "Send to agent" : "Send again"}
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null}
              aria-label="Delete message"
              onClick={() => run("delete", () => actions.onDelete(item))}
            >
              <Trash2Icon aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** Above a message the agent got from the room: where it came from and who sent it. */
export function RoomSentLine({ room }: { readonly room: RoomMessageAttribution }) {
  const viewer = use(RoomTimelineContext)?.viewer;
  const direct = room.itemId === undefined;
  return (
    <p className="me-1 flex items-center gap-1 text-2xs text-muted-foreground">
      <UsersIcon aria-hidden className="size-3" />
      {direct
        ? "From the room, to the agent"
        : `From the room · sent by ${roomAuthorLabel(room.sentBy, viewer)}`}
    </p>
  );
}
