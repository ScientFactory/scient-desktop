import {
  ROOM_MESSAGE_MAX_ATTACHMENTS,
  ROOM_MESSAGE_MAX_ATTACHMENT_BYTES,
  ROOM_MESSAGE_MAX_LENGTH,
  ROOM_REPLY_EXCERPT_MAX_LENGTH,
  type OrchestrationV2TurnItem,
  type RoomReplyTarget,
} from "@t3tools/contracts";

export type RoomMessageItem = Extract<OrchestrationV2TurnItem, { type: "room_message" }>;

export function roomAuthorLabel(author: RoomReplyTarget["author"]): string {
  return author.kind === "owner" ? "You" : author.kind === "agent" ? "Agent" : author.name;
}

export function roomReplyTarget(
  item: Pick<RoomMessageItem, "id" | "author" | "text">,
): RoomReplyTarget {
  return {
    itemId: item.id,
    author: item.author,
    excerpt: item.text.slice(0, ROOM_REPLY_EXCERPT_MAX_LENGTH),
  };
}

export function roomDeliveryLabel(item: Pick<RoomMessageItem, "deliveries">): string | null {
  const sent = item.deliveries?.findLast((delivery) => delivery.status === "sent");
  if (sent) return `Sent to the agent by ${roomAuthorLabel(sent.by)}`;
  return item.deliveries?.some((delivery) => delivery.status === "cancelled")
    ? "Send to the agent cancelled"
    : null;
}

export function roomPostError(draft: {
  readonly text: string;
  readonly context?: { readonly records: ReadonlyArray<unknown> };
  readonly attachments: ReadonlyArray<{ readonly sizeBytes: number }>;
}): string | null {
  if (draft.context?.records.length)
    return "Added context only goes to the agent. Remove it to post to people.";
  if (!draft.text.trim() && draft.attachments.length === 0) return "Add a message or file.";
  if (draft.text.trim().length > ROOM_MESSAGE_MAX_LENGTH)
    return `Room messages can contain at most ${ROOM_MESSAGE_MAX_LENGTH} characters.`;
  if (draft.attachments.length > ROOM_MESSAGE_MAX_ATTACHMENTS)
    return `Attach at most ${ROOM_MESSAGE_MAX_ATTACHMENTS} files to a room message.`;
  if (
    draft.attachments.reduce((size, attachment) => size + attachment.sizeBytes, 0) >
    ROOM_MESSAGE_MAX_ATTACHMENT_BYTES
  )
    return "These files are too large for a room message.";
  return null;
}
