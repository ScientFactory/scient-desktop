import {
  GuestMessageId,
  GuestShareId,
  ROOM_MESSAGE_MAX_ATTACHMENTS,
  ROOM_MESSAGE_MAX_LENGTH,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_REPLY_EXCERPT_MAX_LENGTH,
  type MessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RoomAuthor,
  type RoomMessageId,
  type RoomParticipant,
  RoomParticipantId,
  type RoomReplyTarget,
  type RoomRole,
  type ThreadRoom,
  type ThreadRoomOwnerAction,
  type ThreadRoomServerAction,
  TurnItemId,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export type RoomMessageItem = Extract<OrchestrationV2TurnItem, { readonly type: "room_message" }>;

/** What a guest may be told when a room request is refused. */
export const ROOM_FAILURE = {
  closed: "This room is closed.",
  notMember: "You are no longer in this room.",
  role: "Your role in this room does not allow that.",
  empty: "Write a message or attach a file.",
  gone: "That message is no longer available.",
  justSent: "This message was just sent to the agent.",
} as const;

const OWNER: RoomAuthor = { kind: "owner" };
const LEGACY_GUEST_PARTICIPANT = RoomParticipantId.make("guest-link");

export const roomMessageItemId = (roomMessageId: RoomMessageId) =>
  TurnItemId.make(`room:${roomMessageId}`);

/** A run with visible work: anything but a run still waiting in the queue. */
const hasStarted = (run: Pick<OrchestrationV2Run, "status">) => run.status !== "queued";

/**
 * The run whose position range a new room message joins: the latest run that started. The message
 * sorts after what that run showed when it was posted, and before every later run.
 */
export function roomAnchorRunOrdinal(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "ordinal">>,
): number | null {
  let latest: number | null = null;
  for (const run of runs) {
    if (hasStarted(run) && (latest === null || run.ordinal > latest)) latest = run.ordinal;
  }
  return latest;
}

const isExpired = (participant: Pick<RoomParticipant, "expiresAt">, now: DateTime.Utc) =>
  DateTime.toEpochMillis(now) >= Date.parse(participant.expiresAt);

/** A participant who joined and can still use the room. */
export function activeParticipant(
  room: ThreadRoom | null | undefined,
  participantId: RoomParticipantId,
  now: DateTime.Utc,
): (RoomParticipant & { readonly name: string }) | null {
  const participant = room?.participants.find((candidate) => candidate.id === participantId);
  if (participant === undefined || participant.name === null || isExpired(participant, now)) {
    return null;
  }
  return { ...participant, name: participant.name };
}

export const roleCanPost = (role: RoomRole) => role !== "watch";
export const roleCanUseAgent = (role: RoomRole) => role === "agent";

const uniqueName = (room: ThreadRoom, participantId: RoomParticipantId, name: string) => {
  const taken = new Set(
    room.participants.flatMap((participant) =>
      participant.id === participantId || participant.name === null
        ? []
        : [participant.name.toLocaleLowerCase()],
    ),
  );
  if (!taken.has(name.toLocaleLowerCase())) return name;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name} ${suffix}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
};

const excerptOf = (text: string) =>
  text.length <= ROOM_REPLY_EXCERPT_MAX_LENGTH
    ? text
    : `${text.slice(0, ROOM_REPLY_EXCERPT_MAX_LENGTH - 1).trimEnd()}…`;

/** What a reply points at: a room message, a user message or an agent reply. */
function roomReplyTarget(item: OrchestrationV2TurnItem): RoomReplyTarget | null {
  switch (item.type) {
    case "room_message":
      return item.deletedAt === undefined
        ? { itemId: item.id, author: item.author, excerpt: excerptOf(item.text) }
        : null;
    case "assistant_message":
      return { itemId: item.id, author: { kind: "agent" }, excerpt: excerptOf(item.text) };
    case "user_message": {
      const guest = item.context?.guest;
      const author: RoomAuthor =
        item.context?.room?.author ??
        (guest === undefined
          ? OWNER
          : // A message from a T3 guest link names its guest but no room participant.
            { kind: "guest", participantId: LEGACY_GUEST_PARTICIPANT, name: guest.name });
      return { itemId: item.id, author, excerpt: excerptOf(guest?.text ?? item.text) };
    }
    default:
      return null;
  }
}

export interface RoomDecision {
  /** The thread with its new room, or null when the room did not change. */
  readonly thread: OrchestrationV2AppThread | null;
  /** Room message items to write. */
  readonly items: ReadonlyArray<RoomMessageItem>;
  /** Files no longer held by any message. */
  readonly releasedAttachmentIds: ReadonlyArray<string>;
}

const unchanged: RoomDecision = { thread: null, items: [], releasedAttachmentIds: [] };

const withRoom = (
  thread: OrchestrationV2AppThread,
  room: ThreadRoom | null,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  ...thread,
  room:
    room === null
      ? null
      : { ...room, participants: room.participants.filter((p) => !isExpired(p, now)) },
  updatedAt: now,
});

const WAITING_LIMIT = 50;

/** The thread with a room message no longer waiting on the owner, or null if it was not. */
function withoutWaiting(
  thread: OrchestrationV2AppThread,
  itemId: TurnItemId,
  now: DateTime.Utc,
): OrchestrationV2AppThread | null {
  const room = thread.room ?? null;
  if (room === null || !(room.waiting ?? []).includes(itemId)) return null;
  return withRoom(
    thread,
    { ...room, waiting: (room.waiting ?? []).filter((id) => id !== itemId) },
    now,
  );
}

/** Opening the thread is seeing what people wrote. */
export function roomAfterVisit(thread: OrchestrationV2AppThread): OrchestrationV2AppThread["room"] {
  const room = thread.room ?? null;
  return room === null || (room.waiting?.length ?? 0) === 0 ? room : { ...room, waiting: [] };
}

/** Participants whose access ended are dropped whenever the room changes. */

const newRoomMessage = (input: {
  readonly thread: OrchestrationV2AppThread;
  readonly roomMessageId: RoomMessageId;
  readonly author: RoomAuthor;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly replyTo: RoomReplyTarget | undefined;
  readonly suggested: boolean;
  readonly anchorRunOrdinal: number | null;
  readonly now: DateTime.Utc;
}): RoomMessageItem => ({
  id: roomMessageItemId(input.roomMessageId),
  threadId: input.thread.id,
  type: "room_message",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  // The event sink assigns the position from `anchorRunOrdinal`.
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: input.now,
  completedAt: input.now,
  updatedAt: input.now,
  roomMessageId: input.roomMessageId,
  author: input.author,
  text: input.text,
  ...(input.attachments.length === 0 ? {} : { attachments: [...input.attachments] }),
  ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  ...(input.suggested ? { suggested: true } : {}),
  anchorRunOrdinal: input.anchorRunOrdinal,
});

const deletedItem = (item: RoomMessageItem, now: DateTime.Utc): RoomMessageItem => {
  const { attachments, suggested: _suggested, ...rest } = item;
  // The files stay on disk while the thread lasts (a fork or sent copy may hold them); their ids
  // stay too, so deleting the thread removes them.
  const heldFileIds = (attachments ?? []).map((attachment) => attachment.id);
  return {
    ...rest,
    text: "",
    deletedAt: DateTime.formatIso(now),
    ...(heldFileIds.length === 0 ? {} : { heldFileIds }),
    updatedAt: now,
  };
};

export interface RoomDecisionInput {
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
  readonly anchorRunOrdinal: number | null;
  /** The item a reply or a delete names, read before deciding. */
  readonly target: OrchestrationV2TurnItem | null;
  /** True when a room message with the new message's id already exists. */
  readonly messageExists: boolean;
}

const validPost = (text: string, attachments: ReadonlyArray<ChatAttachment>) =>
  (text.trim() !== "" || attachments.length > 0) &&
  text.length <= ROOM_MESSAGE_MAX_LENGTH &&
  attachments.length <= ROOM_MESSAGE_MAX_ATTACHMENTS;

const replyFor = (
  replyTo: TurnItemId | undefined,
  target: OrchestrationV2TurnItem | null,
): Result.Result<RoomReplyTarget | undefined, string> => {
  if (replyTo === undefined) return Result.succeed(undefined);
  const reply = target === null || target.id !== replyTo ? null : roomReplyTarget(target);
  return reply === null ? Result.fail(ROOM_FAILURE.gone) : Result.succeed(reply);
};

export function decideOwnerRoomAction(
  input: RoomDecisionInput & { readonly action: ThreadRoomOwnerAction },
): Result.Result<RoomDecision, string> {
  const { thread, action, now } = input;
  const room = thread.room ?? null;
  switch (action.type) {
    case "post": {
      if (room === null) return Result.fail("Invite someone before posting to people.");
      if (input.messageExists) return Result.fail("This message was already posted.");
      if (!validPost(action.text, action.attachments)) return Result.fail(ROOM_FAILURE.empty);
      return Result.map(replyFor(action.replyTo, input.target), (replyTo) => ({
        ...unchanged,
        // Answering in the room is the owner looking at it.
        thread:
          (room.waiting?.length ?? 0) === 0
            ? null
            : withRoom(thread, { ...room, waiting: [] }, now),
        items: [
          newRoomMessage({
            thread,
            roomMessageId: action.roomMessageId,
            author: OWNER,
            text: action.text,
            attachments: action.attachments,
            replyTo,
            suggested: false,
            anchorRunOrdinal: input.anchorRunOrdinal,
            now,
          }),
        ],
      }));
    }
    case "delete": {
      const item = input.target;
      if (item?.type !== "room_message" || item.id !== action.itemId) {
        return Result.fail(ROOM_FAILURE.gone);
      }
      if (item.deletedAt !== undefined) return Result.succeed(unchanged);
      return Result.succeed({
        ...unchanged,
        thread: withoutWaiting(thread, item.id, now),
        items: [deletedItem(item, now)],
      });
    }
    case "set-role":
    case "remove": {
      if (room === null) return Result.fail(ROOM_FAILURE.closed);
      const participant = room.participants.find((p) => p.id === action.participantId);
      if (participant === undefined) return Result.fail("This person is not in the room.");
      const participants =
        action.type === "remove"
          ? room.participants.filter((p) => p.id !== action.participantId)
          : room.participants.map((p) =>
              p.id === action.participantId ? { ...p, role: action.role } : p,
            );
      // Removing the last person, or the last unopened link, ends sharing: there is no
      // separate Stop sharing step.
      return Result.succeed({
        ...unchanged,
        thread: withRoom(thread, participants.length === 0 ? null : { ...room, participants }, now),
      });
    }
    case "close":
      return Result.succeed(
        room === null ? unchanged : { ...unchanged, thread: withRoom(thread, null, now) },
      );
  }
}

export function decideServerRoomAction(
  input: RoomDecisionInput & { readonly action: ThreadRoomServerAction },
): Result.Result<RoomDecision, string> {
  const { thread, action, now } = input;
  if (thread.archivedAt !== null) return Result.fail(ROOM_FAILURE.closed);
  const room = thread.room ?? null;
  switch (action.type) {
    case "invite": {
      const base: ThreadRoom =
        room === null
          ? {
              id: action.roomId,
              host: action.host,
              createdAt: DateTime.formatIso(now),
              participants: [],
            }
          : // Invites point at the current Connect host; older links stop with the old one.
            { ...room, host: action.host };
      const live = base.participants.filter((p) => !isExpired(p, now));
      if (live.length >= ROOM_PARTICIPANT_LIMIT) return Result.fail("full");
      const participant: RoomParticipant = {
        id: action.participantId,
        name: null,
        role: action.role,
        invitedAt: DateTime.formatIso(now),
        expiresAt: action.expiresAt,
        joinedAt: null,
      };
      return Result.succeed({
        ...unchanged,
        thread: withRoom(thread, { ...base, participants: [...live, participant] }, now),
      });
    }
    case "join": {
      const participant = room?.participants.find((p) => p.id === action.participantId);
      if (room === null || participant === undefined || isExpired(participant, now)) {
        return Result.fail(ROOM_FAILURE.notMember);
      }
      if (participant.name !== null) return Result.fail("used");
      const name = uniqueName(room, participant.id, action.name);
      const participants = room.participants.map((p) =>
        p.id === participant.id ? { ...p, name, joinedAt: DateTime.formatIso(now) } : p,
      );
      return Result.succeed({
        ...unchanged,
        thread: withRoom(thread, { ...room, participants }, now),
      });
    }
    case "guest-post": {
      const participant = activeParticipant(room, action.participantId, now);
      if (room === null || participant === null) return Result.fail(ROOM_FAILURE.notMember);
      if (!roleCanPost(participant.role)) return Result.fail(ROOM_FAILURE.role);
      if (input.messageExists) return Result.fail("This message was already posted.");
      if (!validPost(action.text, action.attachments)) return Result.fail(ROOM_FAILURE.empty);
      const itemId = roomMessageItemId(action.roomMessageId);
      return Result.map(replyFor(action.replyTo, input.target), (replyTo) => ({
        ...unchanged,
        thread: withRoom(
          thread,
          { ...room, waiting: [...(room.waiting ?? []), itemId].slice(-WAITING_LIMIT) },
          now,
        ),
        items: [
          newRoomMessage({
            thread,
            roomMessageId: action.roomMessageId,
            author: { kind: "guest", participantId: participant.id, name: participant.name },
            text: action.text,
            attachments: action.attachments,
            replyTo,
            // Someone with agent rights sends their own messages; a suggestion is for the others.
            suggested: action.suggested && !roleCanUseAgent(participant.role),
            anchorRunOrdinal: input.anchorRunOrdinal,
            now,
          }),
        ],
      }));
    }
    case "guest-delete": {
      const participant = activeParticipant(room, action.participantId, now);
      if (participant === null) return Result.fail(ROOM_FAILURE.notMember);
      const item = input.target;
      if (
        item?.type !== "room_message" ||
        item.id !== action.itemId ||
        item.author.kind !== "guest" ||
        item.author.participantId !== participant.id
      ) {
        return Result.fail(ROOM_FAILURE.gone);
      }
      if (item.deletedAt !== undefined) return Result.succeed(unchanged);
      return Result.succeed({
        ...unchanged,
        thread: withoutWaiting(thread, item.id, now),
        items: [deletedItem(item, now)],
      });
    }
  }
}

// Within this window a second send of the same message is taken as a double click.
const DUPLICATE_SEND_WINDOW_MS = 15_000;

const describeSender = (author: RoomAuthor) =>
  author.kind === "owner" ? "the owner" : `guest ${author.name}`;

const describeReplyAuthor = (author: RoomReplyTarget["author"]) =>
  author.kind === "agent" ? "you" : describeSender(author);

/**
 * The words the agent gets for a room message. They say who wrote it and who sent it, so the agent
 * never takes a guest's words for the owner's, and a guest can never start a slash command.
 */
function roomMessageAgentText(item: RoomMessageItem, sentBy: RoomAuthor): string {
  const ownWords = item.author.kind === "owner" && sentBy.kind === "owner";
  const lines: string[] = [];
  if (!ownWords) {
    lines.push(
      `Message from ${describeSender(item.author)} in the discussion, sent by ${describeSender(sentBy)}:`,
    );
  }
  if (item.replyTo !== undefined) {
    lines.push(
      `(In reply to ${describeReplyAuthor(item.replyTo.author)}: "${item.replyTo.excerpt}")`,
    );
  }
  const body = item.text.trim() === "" ? "Files from the discussion." : item.text;
  return [...lines, ...(lines.length === 0 ? [] : [""]), body].join("\n");
}

export interface RoomSend {
  readonly item: RoomMessageItem;
  /** The thread once the message no longer waits on the owner, or null. */
  readonly thread: OrchestrationV2AppThread | null;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context: OrchestrationMessageContext;
}

/** Sends a room message to the agent: the item records the send, the agent gets its words. */
export function decideRoomMessageSend(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly item: OrchestrationV2TurnItem | null;
  readonly sentBy: RoomAuthor;
  readonly messageId: MessageId;
  readonly now: DateTime.Utc;
}): Result.Result<RoomSend, string> {
  const { item, sentBy, now } = input;
  if (item?.type !== "room_message" || item.deletedAt !== undefined) {
    return Result.fail(ROOM_FAILURE.gone);
  }
  const lastSent = item.deliveries?.findLast((delivery) => delivery.status === "sent");
  if (
    lastSent !== undefined &&
    DateTime.toEpochMillis(now) - Date.parse(lastSent.at) < DUPLICATE_SEND_WINDOW_MS
  ) {
    return Result.fail(ROOM_FAILURE.justSent);
  }
  const room = input.thread.room ?? null;
  const updated: RoomMessageItem = {
    ...item,
    deliveries: [
      ...(item.deliveries ?? []),
      { messageId: input.messageId, by: sentBy, at: DateTime.formatIso(now), status: "sent" },
    ],
    updatedAt: now,
  };
  const startedAt = item.startedAt ?? item.updatedAt;
  return Result.succeed({
    item: updated,
    thread: withoutWaiting(input.thread, item.id, now),
    text: roomMessageAgentText(item, sentBy),
    attachments: item.attachments ?? [],
    context: {
      version: 1,
      records: [],
      ...(item.author.kind === "guest"
        ? {
            guest: {
              guestMessageId: GuestMessageId.make(item.roomMessageId),
              name: item.author.name,
              text: item.text,
              ...(room === null ? {} : { shareId: GuestShareId.make(room.id) }),
            },
          }
        : {}),
      room: {
        itemId: item.id,
        author: item.author,
        sentBy,
        postedAt: DateTime.formatIso(startedAt),
        text: item.text,
      },
    },
  });
}

/** A guest with agent rights writes to the agent: their words, named as theirs. */
export function guestDirectSend(input: {
  readonly room: ThreadRoom;
  readonly participant: { readonly id: RoomParticipantId; readonly name: string };
  readonly messageId: MessageId;
  readonly text: string;
  readonly now: DateTime.Utc;
}): { readonly text: string; readonly context: OrchestrationMessageContext } {
  const author: RoomAuthor = {
    kind: "guest",
    participantId: input.participant.id,
    name: input.participant.name,
  };
  const words = input.text.trim() === "" ? "Files from the discussion." : input.text;
  return {
    text: `Message from guest ${input.participant.name}:\n\n${words}`,
    context: {
      version: 1,
      records: [],
      guest: {
        guestMessageId: GuestMessageId.make(input.messageId),
        name: input.participant.name,
        text: input.text,
        shareId: GuestShareId.make(input.room.id),
      },
      room: {
        author,
        sentBy: author,
        postedAt: DateTime.formatIso(input.now),
        text: input.text,
      },
    },
  };
}

/** The queued send of a room message was cancelled, so the agent never got it. */
export function roomItemAfterCancelledSend(
  item: OrchestrationV2TurnItem,
  messageId: MessageId,
  now: DateTime.Utc,
): RoomMessageItem | null {
  if (item.type !== "room_message") return null;
  const delivery = item.deliveries?.find((candidate) => candidate.messageId === messageId);
  if (delivery?.status !== "sent") return null;
  return {
    ...item,
    deliveries: (item.deliveries ?? []).map((candidate) =>
      candidate.messageId === messageId
        ? { ...candidate, status: "cancelled" as const }
        : candidate,
    ),
    updatedAt: now,
  };
}

/** Room attribution comes only from the server; a client cannot claim it. */
export function withoutRoomAttribution<
  C extends { readonly context?: OrchestrationMessageContext | undefined },
>(command: C): C {
  if (command.context?.room === undefined) return command;
  const { room: _room, ...context } = command.context;
  return { ...command, context };
}
