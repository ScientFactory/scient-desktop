/**
 * A thread room: people the owner invited watch the thread and talk with each other there. A
 * room message goes to people only; the agent receives it only when someone with agent rights
 * sends it, as a new message that links back to it.
 */
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnItemId,
} from "../baseSchemas.ts";
import { ChatAttachment } from "../chatAttachment.ts";
import {
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
  GUEST_MESSAGE_MAX_LENGTH,
  GuestRedeemRequest,
} from "../guestShare.ts";
import type { makeTurnItemBaseFields } from "./orchestrationV2Fork.ts";

export const ThreadRoomId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadRoomId"));
export type ThreadRoomId = typeof ThreadRoomId.Type;
export const RoomParticipantId = TrimmedNonEmptyString.pipe(Schema.brand("RoomParticipantId"));
export type RoomParticipantId = typeof RoomParticipantId.Type;
export const RoomMessageId = TrimmedNonEmptyString.pipe(Schema.brand("RoomMessageId"));
export type RoomMessageId = typeof RoomMessageId.Type;

export const ROOM_PARTICIPANT_LIMIT = 16;
export const ROOM_MESSAGE_MAX_LENGTH = GUEST_MESSAGE_MAX_LENGTH;
export const ROOM_MESSAGE_MAX_ATTACHMENTS = GUEST_MESSAGE_MAX_ATTACHMENTS;
export const ROOM_MESSAGE_MAX_ATTACHMENT_BYTES = GUEST_MESSAGE_MAX_ATTACHMENT_BYTES;
export const ROOM_REPLY_EXCERPT_MAX_LENGTH = 200;
const ROOM_WAITING_LIMIT = 50;

/** What a person in the room may do; the room is the same conversation for everyone. */
export const RoomRole = Schema.Literals(["watch", "discuss", "agent"]);
export type RoomRole = typeof RoomRole.Type;

export const ROOM_ROLE_LABEL: Record<RoomRole, string> = {
  watch: "Can view",
  discuss: "Can chat",
  agent: "Can use agent",
};

export const RoomAccessDuration = Schema.Literals(["day", "week", "month"]);
export type RoomAccessDuration = typeof RoomAccessDuration.Type;
export const ROOM_ACCESS_DURATION_MS: Record<RoomAccessDuration, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

export const RoomParticipant = Schema.Struct({
  id: RoomParticipantId,
  /** Null until the person opens their invite and gives a name. */
  name: Schema.NullOr(TrimmedNonEmptyString),
  role: RoomRole,
  invitedAt: IsoDateTime,
  /** The invite and, once joined, the access end here. */
  expiresAt: IsoDateTime,
  joinedAt: Schema.NullOr(IsoDateTime),
});
export type RoomParticipant = typeof RoomParticipant.Type;

export const ThreadRoom = Schema.Struct({
  id: ThreadRoomId,
  /** The Connect hostname the invites point at; guest routes require it to still serve. */
  host: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  participants: Schema.Array(RoomParticipant).check(Schema.isMaxLength(ROOM_PARTICIPANT_LIMIT)),
  /** Guests' messages since the owner last looked, newest last; they count as waiting on the owner. */
  waiting: Schema.optional(Schema.Array(TurnItemId).check(Schema.isMaxLength(ROOM_WAITING_LIMIT))),
});
export type ThreadRoom = typeof ThreadRoom.Type;

/** How many guest messages a room waits on the owner for, as the sidebar counts them. */
export const roomWaitingCount = (room: ThreadRoom | null | undefined): number =>
  room?.waiting?.length ?? 0;

export const RoomAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("owner") }),
  Schema.Struct({
    kind: Schema.Literal("guest"),
    participantId: RoomParticipantId,
    name: TrimmedNonEmptyString,
  }),
]);
export type RoomAuthor = typeof RoomAuthor.Type;

/** What a reply points at, copied when it is written so it survives the original's deletion. */
export const RoomReplyTarget = Schema.Struct({
  itemId: TurnItemId,
  author: Schema.Union([...RoomAuthor.members, Schema.Struct({ kind: Schema.Literal("agent") })]),
  excerpt: Schema.String,
});
export type RoomReplyTarget = typeof RoomReplyTarget.Type;

/** One time a room message was sent to the agent. */
export const RoomDelivery = Schema.Struct({
  messageId: MessageId,
  by: RoomAuthor,
  at: IsoDateTime,
  /** Cancelled when the queued send was cancelled before the agent got it. */
  status: Schema.Literals(["sent", "cancelled"]),
});
export type RoomDelivery = typeof RoomDelivery.Type;

const RoomMessageFields = {
  roomMessageId: RoomMessageId,
  author: RoomAuthor,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  replyTo: Schema.optional(RoomReplyTarget),
  /** A Discuss participant asked for this to go to the agent. */
  suggested: Schema.optional(Schema.Boolean),
  deliveries: Schema.optional(Schema.Array(RoomDelivery)),
  /** Deleted messages keep their place and author; text and files are gone. */
  deletedAt: Schema.optional(IsoDateTime),
  /** A deleted message's file ids, so they are removed with the thread. Never shown. */
  heldFileIds: Schema.optional(Schema.Array(Schema.String)),
  /** The run whose position range the message joined: the latest started run when posted. */
  anchorRunOrdinal: Schema.NullOr(NonNegativeInt),
} as const;

/** The room payload of a room message, as older clients receive it inside a notice. */
const RoomMessagePayload = Schema.Struct(RoomMessageFields);

const roomAuthorName = (author: RoomAuthor): string =>
  author.kind === "owner" ? "Owner" : author.name;

type TurnItemBaseFields = ReturnType<typeof makeTurnItemBaseFields>;

/**
 * Room messages are timeline items with no run, node or provider: they carry no execution
 * authority. Older clients decode them as the system notice they are stored and sent as.
 */
export const makeRoomMessageItems = (baseFields: TurnItemBaseFields) => {
  const RoomMessageItemShape = Schema.Struct({
    ...baseFields,
    type: Schema.Literal("room_message"),
    ...RoomMessageFields,
  });
  const roomMessageOwnership = Schema.makeFilter(
    (item: typeof RoomMessageItemShape.Type) =>
      (item.runId === null &&
        item.nodeId === null &&
        item.providerThreadId === null &&
        item.providerTurnId === null &&
        item.nativeItemRef === null) ||
      "A room message cannot carry execution authority.",
  );
  const RoomMessageItem = RoomMessageItemShape.check(roomMessageOwnership);
  const RoomMessageNotice = Schema.Struct({
    ...baseFields,
    runId: Schema.Null,
    nodeId: Schema.Null,
    providerThreadId: Schema.Null,
    providerTurnId: Schema.Null,
    nativeItemRef: Schema.Null,
    type: Schema.Literal("system_notice"),
    message: Schema.String,
    roomMessage: RoomMessagePayload,
  });
  const decodeNotice = SchemaGetter.transform(
    ({
      type: _type,
      message: _message,
      roomMessage,
      ...fields
    }: typeof RoomMessageNotice.Type): typeof RoomMessageItem.Type => ({
      ...fields,
      type: "room_message",
      ...roomMessage,
    }),
  );
  const encodeNotice = SchemaGetter.transform(
    (item: typeof RoomMessageItem.Type): typeof RoomMessageNotice.Type => {
      const {
        type: _type,
        roomMessageId,
        author,
        text,
        attachments,
        replyTo,
        suggested,
        deliveries,
        deletedAt,
        heldFileIds,
        anchorRunOrdinal,
        ...fields
      } = item;
      return {
        ...fields,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        type: "system_notice",
        message:
          deletedAt === undefined
            ? `${roomAuthorName(author)} (to people): ${text}`
            : `${roomAuthorName(author)} deleted a message`,
        roomMessage: {
          roomMessageId,
          author,
          text,
          ...(attachments === undefined ? {} : { attachments }),
          ...(replyTo === undefined ? {} : { replyTo }),
          ...(suggested === undefined ? {} : { suggested }),
          ...(deliveries === undefined ? {} : { deliveries }),
          ...(deletedAt === undefined ? {} : { deletedAt }),
          ...(heldFileIds === undefined ? {} : { heldFileIds }),
          anchorRunOrdinal,
        },
      };
    },
  );
  const jsonDates = <F extends { readonly startedAt: unknown }>(fields: F) => ({
    ...fields,
    startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    updatedAt: Schema.DateTimeUtcFromString,
  });
  return {
    RoomMessageItem,
    RoomMessageNoticeItem: RoomMessageNotice.pipe(
      Schema.decodeTo(Schema.toType(RoomMessageItem), {
        decode: decodeNotice,
        encode: encodeNotice,
      }),
    ),
    RoomMessageItemJson: RoomMessageItemShape.mapFields(jsonDates).check(roomMessageOwnership),
    RoomMessageNoticeItemJson: RoomMessageNotice.mapFields(jsonDates).pipe(
      Schema.decodeTo(Schema.toType(RoomMessageItem), {
        decode: decodeNotice,
        encode: encodeNotice,
      }),
    ),
  };
};

/** Owner actions, sent from the owner's clients through the thread command path. */
export const ThreadRoomOwnerAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("post"),
    roomMessageId: RoomMessageId,
    text: TrimmedString.check(Schema.isMaxLength(ROOM_MESSAGE_MAX_LENGTH)),
    attachments: Schema.Array(ChatAttachment).check(
      Schema.isMaxLength(ROOM_MESSAGE_MAX_ATTACHMENTS),
    ),
    replyTo: Schema.optional(TurnItemId),
  }),
  Schema.Struct({ type: Schema.Literal("delete"), itemId: TurnItemId }),
  Schema.Struct({
    type: Schema.Literal("set-role"),
    participantId: RoomParticipantId,
    role: RoomRole,
  }),
  Schema.Struct({ type: Schema.Literal("remove"), participantId: RoomParticipantId }),
  Schema.Struct({ type: Schema.Literal("close") }),
]);
export type ThreadRoomOwnerAction = typeof ThreadRoomOwnerAction.Type;

/** Actions only the server's room service sends: invites it signed, and guests' requests. */
export const ThreadRoomServerAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("invite"),
    /** Used when the thread has no room yet. */
    roomId: ThreadRoomId,
    host: TrimmedNonEmptyString,
    participantId: RoomParticipantId,
    role: RoomRole,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("join"),
    participantId: RoomParticipantId,
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("guest-post"),
    participantId: RoomParticipantId,
    roomMessageId: RoomMessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    replyTo: Schema.optional(TurnItemId),
    suggested: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("guest-delete"),
    participantId: RoomParticipantId,
    itemId: TurnItemId,
  }),
]);
export type ThreadRoomServerAction = typeof ThreadRoomServerAction.Type;

/**
 * Server-built record of who a message to the agent came from. `itemId` links back to the room
 * message it sent; a guest's direct message to the agent has none.
 */
export const RoomMessageAttribution = Schema.Struct({
  itemId: Schema.optional(TurnItemId),
  author: RoomAuthor,
  sentBy: RoomAuthor,
  postedAt: IsoDateTime,
  /** The words as people saw them; the message text is what the agent got. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(ROOM_MESSAGE_MAX_LENGTH))),
});
export type RoomMessageAttribution = typeof RoomMessageAttribution.Type;

// Owner RPCs.

export const RoomInviteInput = Schema.Struct({
  threadId: ThreadId,
  role: RoomRole,
  duration: RoomAccessDuration,
});
export type RoomInviteInput = typeof RoomInviteInput.Type;

export const RoomInviteResult = Schema.Struct({
  url: TrimmedNonEmptyString,
  participantId: RoomParticipantId,
});
export type RoomInviteResult = typeof RoomInviteResult.Type;

export const RoomInviteLinkInput = Schema.Struct({
  threadId: ThreadId,
  participantId: RoomParticipantId,
});
export type RoomInviteLinkInput = typeof RoomInviteLinkInput.Type;

const ROOM_INVITE_MESSAGES = {
  disabled: "Guest links are off. Turn them on in Settings > Labs.",
  connect_unavailable:
    "Other devices can't reach this computer through Scient Connect right now. Check Settings > Sharing & access.",
  thread_unavailable: "This thread cannot be shared.",
  full: `A room holds up to ${ROOM_PARTICIPANT_LIMIT} people. Remove someone to invite another.`,
  not_pending: "This person already joined, so their invite no longer works.",
} as const;

export class RoomInviteError extends Schema.TaggedError<RoomInviteError>()("RoomInviteError", {
  reason: Schema.Literals([
    "disabled",
    "connect_unavailable",
    "thread_unavailable",
    "full",
    "not_pending",
  ]),
}) {
  override get message(): string {
    return ROOM_INVITE_MESSAGES[this.reason];
  }
}

export const RoomPresenceInput = Schema.Struct({ threadId: ThreadId });
export type RoomPresenceInput = typeof RoomPresenceInput.Type;
/** Participants with the room open in a browser right now. */
export const RoomPresence = Schema.Struct({ online: Schema.Array(RoomParticipantId) });
export type RoomPresence = typeof RoomPresence.Type;

// Guest routes.

export const ROOM_ROUTE_PREFIX = "/api/room";
/** Room pages share T3's guest page route, which already runs without the app shell or pairing. */
export const ROOM_PAGE_PATH = "/guest";
/** Marks the guest route as a room page; after joining it names the participant. */
export const ROOM_PAGE_PARAM = "room";
/** Every guest route names the participant it acts as. */
export const ROOM_PARTICIPANT_PARAM = "p";
export const roomSessionCookieName = (participantId: string) => `scient_room_${participantId}`;

export const RoomJoinRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  name: GuestRedeemRequest.fields.name,
});
export type RoomJoinRequest = typeof RoomJoinRequest.Type;

export const RoomPostRequest = Schema.Struct({
  text: TrimmedString.check(Schema.isMaxLength(ROOM_MESSAGE_MAX_LENGTH)),
  to: Schema.Literals(["people", "agent"]),
  replyTo: Schema.optional(TurnItemId),
  suggested: Schema.optional(Schema.Boolean),
});
export type RoomPostRequest = typeof RoomPostRequest.Type;

export const RoomItemRequest = Schema.Struct({ itemId: TurnItemId });
export type RoomItemRequest = typeof RoomItemRequest.Type;

export const RoomGuestView = Schema.Struct({
  roomId: ThreadRoomId,
  title: Schema.String,
  me: Schema.Struct({
    participantId: RoomParticipantId,
    name: TrimmedNonEmptyString,
    role: RoomRole,
  }),
  participants: Schema.Array(
    Schema.Struct({
      participantId: RoomParticipantId,
      name: TrimmedNonEmptyString,
      role: RoomRole,
      online: Schema.Boolean,
    }),
  ),
  expiresAt: IsoDateTime,
});
export type RoomGuestView = typeof RoomGuestView.Type;
