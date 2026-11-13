import {
  type ChatAttachment,
  ChatAttachmentId,
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2TurnItem,
  ROOM_ACCESS_DURATION_MS,
  ROOM_PAGE_PARAM,
  ROOM_PAGE_PATH,
  RoomInviteError,
  type RoomInviteInput,
  type RoomInviteLinkInput,
  type RoomInviteResult,
  type RoomJoinRequest,
  RoomMessageId,
  RoomParticipantId,
  type RoomPostRequest,
  type RoomPresence,
  type RoomPresenceInput,
  type RoomStreamEvent,
  ThreadId,
  ThreadRoomId,
  type ThreadRoom,
  TurnItemId,
} from "@t3tools/contracts";
import { chatMarkdownImageSources } from "@t3tools/shared/markdownPipeline";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  attachmentFileExtension,
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  threadHtmlRenderAttachmentIds,
} from "../../attachmentStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../../auth/utils.ts";
import * as PayloadSigner from "../../auth/PayloadSigner.ts";
import { CloudManagedEndpointRuntime } from "../../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../../config.ts";
import {
  classifyGuestUploads,
  GUEST_UPLOAD_HEADER_BYTES,
  guestHostImageType,
  type GuestUpload,
  matchesImageSignature,
  repliesShowImage,
} from "../../guest/guestAttachments.ts";
import { guestThreadModel } from "../../guest/guestView.ts";
import * as CommandOutputHub from "../../orchestration-v2/CommandOutputHub.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { coalesceThreadLiveStream } from "../../orchestration-v2/ThreadLiveEventCoalescer.ts";
import { buildBoundedThreadStreamSnapshot } from "../../orchestration-v2/ThreadStream.ts";
import {
  projectTurnItemForDetail,
  projectTurnItemForWire,
  threadStreamEventItem,
} from "../../orchestration-v2/WireProjection.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import {
  activeParticipant,
  ROOM_FAILURE,
  roleCanPost,
  roleCanUseAgent,
} from "./threadRoomDecider.ts";
import { roomGuestView } from "./roomView.ts";

const SIGNING_SECRET_NAME = "thread-room-signing-key";
const ID_BYTES = 16;
const SNAPSHOT_ROW_LIMIT = 600;
const SNAPSHOT_USER_TURN_LIMIT = 20;
const ACCESS_RECHECK_INTERVAL = Duration.seconds(30);
// Posts a guest can make in a minute, so one person cannot flood the room or the disk.
const POSTS_PER_MINUTE = 20;
const SENT_REPLIES_LIMIT = 64;

const ROOM_ACCESS_MESSAGES = {
  invalid: "This invite link is not valid.",
  closed: ROOM_FAILURE.closed,
  removed: ROOM_FAILURE.notMember,
  used: "This invite was already used. Ask the owner for a new one.",
  role: ROOM_FAILURE.role,
  empty: ROOM_FAILURE.empty,
  gone: ROOM_FAILURE.gone,
  just_sent: ROOM_FAILURE.justSent,
  too_many_files: "Attach up to 4 files to a message.",
  too_large: "Attached files can total up to 10 MB per message.",
  unsupported_file: "This file cannot be attached. Images must be PNG, JPEG, GIF, or WebP.",
  rate_limited: "You are sending messages too quickly. Wait a moment.",
  unavailable: "This item is not available.",
  rejected: "The owner's computer rejected this request.",
} as const;

/** What a guest is told. The message comes from `reason`, never from a cause. */
export class RoomAccessError extends Schema.TaggedError<RoomAccessError>()("RoomAccessError", {
  reason: Schema.Literals([
    "invalid",
    "closed",
    "removed",
    "used",
    "role",
    "empty",
    "gone",
    "just_sent",
    "too_many_files",
    "too_large",
    "unsupported_file",
    "rate_limited",
    "unavailable",
    "rejected",
  ]),
}) {
  override get message(): string {
    return ROOM_ACCESS_MESSAGES[this.reason];
  }
}

const failureReason = (cause: unknown): RoomAccessError["reason"] => {
  switch (cause) {
    case ROOM_FAILURE.closed:
      return "closed";
    case ROOM_FAILURE.notMember:
      return "removed";
    case ROOM_FAILURE.role:
      return "role";
    case ROOM_FAILURE.empty:
      return "empty";
    case ROOM_FAILURE.gone:
      return "gone";
    case ROOM_FAILURE.justSent:
      return "just_sent";
    case "used":
      return "used";
    default:
      return "rejected";
  }
};

const InviteClaims = Schema.Struct({ t: ThreadId, p: RoomParticipantId });
const SessionClaims = Schema.Struct({
  kind: Schema.Literal("room-session"),
  threadId: ThreadId,
  roomId: ThreadRoomId,
  participantId: RoomParticipantId,
});
type SessionClaims = typeof SessionClaims.Type;
const decodeInviteClaims = Schema.decodeUnknownOption(Schema.fromJsonString(InviteClaims));
const decodeSessionClaims = Schema.decodeUnknownOption(Schema.fromJsonString(SessionClaims));

export interface RoomSession {
  readonly thread: OrchestrationV2AppThread;
  readonly room: ThreadRoom;
  readonly participant: ReturnType<typeof activeParticipant> & {};
}

export class ThreadRoomService extends Context.Service<
  ThreadRoomService,
  {
    readonly invite: (input: RoomInviteInput) => Effect.Effect<RoomInviteResult, RoomInviteError>;
    readonly inviteLink: (
      input: RoomInviteLinkInput,
    ) => Effect.Effect<RoomInviteResult, RoomInviteError>;
    readonly presence: (input: RoomPresenceInput) => Stream.Stream<RoomPresence>;
    /** Spends an invite and returns the session token for the guest's cookie. */
    readonly join: (request: RoomJoinRequest) => Effect.Effect<
      {
        readonly token: string;
        readonly participantId: RoomParticipantId;
        readonly expiresAt: string;
      },
      RoomAccessError
    >;
    readonly check: (session: string) => Effect.Effect<RoomSession, RoomAccessError>;
    readonly post: (
      session: string,
      request: RoomPostRequest,
      uploads: ReadonlyArray<GuestUpload>,
    ) => Effect.Effect<void, RoomAccessError>;
    readonly send: (session: string, itemId: TurnItemId) => Effect.Effect<void, RoomAccessError>;
    readonly remove: (session: string, itemId: TurnItemId) => Effect.Effect<void, RoomAccessError>;
    readonly stop: (session: string) => Effect.Effect<void, RoomAccessError>;
    readonly stream: (
      session: string,
    ) => Effect.Effect<Stream.Stream<RoomStreamEvent>, RoomAccessError>;
    readonly item: (
      session: string,
      itemId: string,
    ) => Effect.Effect<OrchestrationV2GetTurnItemResult, RoomAccessError>;
    readonly history: (
      session: string,
      cursor: string,
    ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, RoomAccessError>;
    readonly render: (
      session: string,
      itemId: string,
    ) => Effect.Effect<{ readonly path: string; readonly title: string }, RoomAccessError>;
    readonly commandOutput: (
      session: string,
      itemId: string,
    ) => Effect.Effect<Stream.Stream<OrchestrationV2CommandOutputFrame>, RoomAccessError>;
    readonly attachment: (
      session: string,
      itemId: string,
      attachmentId: string,
    ) => Effect.Effect<
      { readonly path: string; readonly attachment: ChatAttachment },
      RoomAccessError
    >;
    readonly media: (
      session: string,
      path: string,
    ) => Effect.Effect<{ readonly path: string; readonly mimeType: string }, RoomAccessError>;
  }
>()("t3/scient/room/ThreadRoomService") {}

/** The files a timeline item holds that people in the room can open. */
const itemFiles = (item: OrchestrationV2TurnItem): ReadonlyArray<ChatAttachment> =>
  item.type === "user_message" || item.type === "room_message" ? (item.attachments ?? []) : [];

const threadOf = (event: OrchestrationV2DomainEvent): OrchestrationV2AppThread | null => {
  switch (event.type) {
    case "thread.metadata-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.guest-share-updated":
      return event.payload;
    default:
      return null;
  }
};

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const commandOutputs = yield* CommandOutputHub.CommandOutputHub;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const analytics = yield* AnalyticsService.AnalyticsService;
  const signer = yield* PayloadSigner.make(SIGNING_SECRET_NAME);

  const randomId = random.randomBytes(ID_BYTES).pipe(Effect.map(base64UrlEncode), Effect.orDie);
  const commandId = (label: string) =>
    random.uuidV4().pipe(
      Effect.map((uuid) => CommandId.make(`server:thread-room:${label}:${uuid}`)),
      Effect.orDie,
    );

  // Nothing secret is stored: tokens are signed claims, checked against the live room each time,
  // so removing a person or closing the room revokes their tokens.
  const signToken = (claims: unknown) => {
    const payload = base64UrlEncode(JSON.stringify(claims));
    return signer.sign(payload).pipe(
      Effect.orDie,
      Effect.map((signature) => `${payload}.${signature}`),
    );
  };
  const readToken = Effect.fnUntraced(function* (token: string) {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return Option.none<string>();
    if (!(yield* signer.verify(payload, signature).pipe(Effect.orDie)))
      return Option.none<string>();
    return Option.some(base64UrlDecodeUtf8(payload));
  });

  const connectHostname = managedEndpoint.inspectConnector.pipe(
    Effect.map((facts) => facts?.hostname ?? null),
  );
  const sharingEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.guestSharingEnabled),
    Effect.orElseSucceed(() => false),
  );

  const readThread = (threadId: ThreadId) =>
    orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread),
      Effect.mapError(() => new RoomAccessError({ reason: "closed" })),
    );

  const roomLive = Effect.fnUntraced(function* (thread: OrchestrationV2AppThread) {
    const room = thread.room ?? null;
    if (
      room === null ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      !(yield* sharingEnabled) ||
      (yield* connectHostname) !== room.host
    ) {
      return null;
    }
    return room;
  });

  /** A session that can still use its room: same room, still a member, unexpired. */
  const authorize = Effect.fn("ThreadRoomService.authorize")(function* (token: string) {
    const raw = yield* readToken(token);
    const claims = Option.flatMap(raw, decodeSessionClaims);
    if (Option.isNone(claims)) return yield* new RoomAccessError({ reason: "invalid" });
    const thread = yield* readThread(claims.value.threadId);
    const room = yield* roomLive(thread);
    if (room === null || room.id !== claims.value.roomId) {
      return yield* new RoomAccessError({ reason: "closed" });
    }
    const participant = activeParticipant(room, claims.value.participantId, yield* DateTime.now);
    if (participant === null) return yield* new RoomAccessError({ reason: "removed" });
    return { thread, room, participant } satisfies RoomSession;
  });

  // Through thread management, so a guest's send passes the same provider checks as the owner's.
  const dispatchForGuest = (
    command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
  ) =>
    threads.dispatch(command).pipe(
      Effect.mapError(
        (error) =>
          new RoomAccessError({
            reason: failureReason("cause" in error ? error.cause : undefined),
          }),
      ),
    );

  const inviteUrl = (host: string, threadId: ThreadId, participantId: RoomParticipantId) =>
    signToken({ t: threadId, p: participantId }).pipe(
      Effect.map(
        (credential) => `https://${host}${ROOM_PAGE_PATH}?${ROOM_PAGE_PARAM}#${credential}`,
      ),
    );

  const invite = Effect.fn("ThreadRoomService.invite")(function* (input: RoomInviteInput) {
    if (!(yield* sharingEnabled)) return yield* new RoomInviteError({ reason: "disabled" });
    const host = yield* connectHostname;
    if (host === null) return yield* new RoomInviteError({ reason: "connect_unavailable" });
    const participantId = RoomParticipantId.make(yield* randomId);
    const now = yield* DateTime.now;
    yield* orchestrator
      .dispatch({
        type: "thread.room.server",
        commandId: yield* commandId("invite"),
        threadId: input.threadId,
        action: {
          type: "invite",
          roomId: ThreadRoomId.make(yield* randomId),
          host,
          participantId,
          role: input.role,
          expiresAt: DateTime.formatIso(
            DateTime.add(now, { milliseconds: ROOM_ACCESS_DURATION_MS[input.duration] }),
          ),
        },
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new RoomInviteError({
              reason: "cause" in error && error.cause === "full" ? "full" : "thread_unavailable",
            }),
        ),
      );
    yield* analytics.record("feature.used", { feature: "thread_room.invite", variant: input.role });
    return { url: yield* inviteUrl(host, input.threadId, participantId), participantId };
  });

  const inviteLink = Effect.fn("ThreadRoomService.inviteLink")(function* (
    input: RoomInviteLinkInput,
  ) {
    const thread = yield* orchestrator.getThreadRecords(input.threadId, []).pipe(
      Effect.map(({ thread }) => thread),
      Effect.mapError(() => new RoomInviteError({ reason: "thread_unavailable" })),
    );
    const room = thread.room ?? null;
    const participant = room?.participants.find((p) => p.id === input.participantId);
    if (room === null || participant === undefined) {
      return yield* new RoomInviteError({ reason: "thread_unavailable" });
    }
    if (participant.name !== null) return yield* new RoomInviteError({ reason: "not_pending" });
    return {
      url: yield* inviteUrl(room.host, input.threadId, participant.id),
      participantId: participant.id,
    };
  });

  // Who has the room open: open guest streams per participant, by thread.
  const online = new Map<ThreadId, Map<RoomParticipantId, number>>();
  const presenceChanges = yield* PubSub.unbounded<ThreadId>();
  const onlineOf = (threadId: ThreadId) => [...(online.get(threadId)?.keys() ?? [])];
  const changeOnline = (threadId: ThreadId, participantId: RoomParticipantId, delta: 1 | -1) =>
    Effect.suspend(() => {
      const counts = online.get(threadId) ?? new Map<RoomParticipantId, number>();
      const next = (counts.get(participantId) ?? 0) + delta;
      if (next <= 0) counts.delete(participantId);
      else counts.set(participantId, next);
      if (counts.size === 0) online.delete(threadId);
      else online.set(threadId, counts);
      return PubSub.publish(presenceChanges, threadId);
    });

  const presence = (input: RoomPresenceInput): Stream.Stream<RoomPresence> =>
    Stream.concat(
      Stream.sync(() => ({ online: onlineOf(input.threadId) })),
      Stream.fromPubSub(presenceChanges).pipe(
        Stream.filter((threadId) => threadId === input.threadId),
        Stream.map(() => ({ online: onlineOf(input.threadId) })),
      ),
    );

  const join = Effect.fn("ThreadRoomService.join")(function* (request: RoomJoinRequest) {
    const claims = Option.flatMap(yield* readToken(request.credential), decodeInviteClaims);
    if (Option.isNone(claims)) return yield* new RoomAccessError({ reason: "invalid" });
    const thread = yield* readThread(claims.value.t);
    const room = yield* roomLive(thread);
    if (room === null) return yield* new RoomAccessError({ reason: "closed" });
    yield* dispatchForGuest({
      type: "thread.room.server",
      commandId: yield* commandId("join"),
      threadId: thread.id,
      action: { type: "join", participantId: claims.value.p, name: request.name },
    });
    const participant = room.participants.find((p) => p.id === claims.value.p);
    if (participant === undefined) return yield* new RoomAccessError({ reason: "removed" });
    yield* analytics.record("feature.used", { feature: "thread_room.join" });
    const token = yield* signToken({
      kind: "room-session",
      threadId: thread.id,
      roomId: room.id,
      participantId: participant.id,
    } satisfies SessionClaims);
    return { token, participantId: participant.id, expiresAt: participant.expiresAt };
  });

  const check = Effect.fn("ThreadRoomService.check")(function* (session: string) {
    return yield* authorize(session);
  });

  // Recent posts per participant, for the rate limit.
  const recentPosts = new Map<RoomParticipantId, Array<number>>();
  const admitPost = Effect.fn("ThreadRoomService.admitPost")(function* (
    participantId: RoomParticipantId,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const recent = (recentPosts.get(participantId) ?? []).filter((at) => nowMs - at < 60_000);
    if (recent.length >= POSTS_PER_MINUTE) {
      return yield* new RoomAccessError({ reason: "rate_limited" });
    }
    recentPosts.set(participantId, [...recent, nowMs]);
  });

  const uploadFailed = new RoomAccessError({ reason: "rejected" });
  const removeStored = (attachments: ReadonlyArray<ChatAttachment>) =>
    Effect.forEach(
      attachments,
      (attachment) => {
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        return path === null
          ? Effect.void
          : fileSystem.remove(path, { force: true }).pipe(Effect.ignore);
      },
      { discard: true },
    );

  /** Checks a guest's files as the owner's composer would take them and stores them for the thread. */
  const storeUploads = Effect.fn("ThreadRoomService.storeUploads")(function* (
    threadId: ThreadId,
    uploads: ReadonlyArray<GuestUpload>,
  ) {
    const inspected = yield* Effect.forEach(uploads, (upload) =>
      Effect.gen(function* () {
        const info = yield* fileSystem.stat(upload.path);
        const file = yield* fileSystem.open(upload.path, { flag: "r" });
        const header = Option.getOrElse(
          yield* file.readAlloc(GUEST_UPLOAD_HEADER_BYTES),
          () => new Uint8Array(),
        );
        return { ...upload, sizeBytes: Number(info.size), header };
      }).pipe(
        Effect.scoped,
        Effect.mapError(() => uploadFailed),
      ),
    );
    const classified = classifyGuestUploads(inspected);
    if (!classified.ok) return yield* new RoomAccessError({ reason: classified.reason });
    const stored: Array<ChatAttachment> = [];
    yield* Effect.forEach(
      classified.attachments,
      (draft, index) =>
        Effect.gen(function* () {
          const id = createAttachmentId(
            threadId,
            draft.type === "file" ? attachmentFileExtension(draft.name) : undefined,
          );
          if (id === null) return yield* uploadFailed;
          const attachment: ChatAttachment = { ...draft, id: ChatAttachmentId.make(id) };
          const path = resolveAttachmentPath({ attachmentsDir, attachment });
          if (path === null) return yield* uploadFailed;
          yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
          yield* fileSystem.copyFile(uploads[index]!.path, path);
          stored.push(attachment);
        }).pipe(Effect.mapError(() => uploadFailed)),
      { discard: true },
    ).pipe(Effect.onError(() => removeStored(stored)));
    return stored;
  });

  const post = Effect.fn("ThreadRoomService.post")(function* (
    session: string,
    request: RoomPostRequest,
    uploads: ReadonlyArray<GuestUpload>,
  ) {
    const { thread, participant } = yield* authorize(session);
    const toAgent = request.to === "agent";
    if (toAgent ? !roleCanUseAgent(participant.role) : !roleCanPost(participant.role)) {
      return yield* new RoomAccessError({ reason: "role" });
    }
    if (request.text === "" && uploads.length === 0) {
      return yield* new RoomAccessError({ reason: "empty" });
    }
    yield* admitPost(participant.id);
    const attachments = yield* storeUploads(thread.id, uploads);
    const dispatched = toAgent
      ? dispatchForGuest({
          type: "thread.room.guest-dispatch",
          commandId: yield* commandId("send"),
          threadId: thread.id,
          participantId: participant.id,
          messageId: MessageId.make(yield* random.uuidV4().pipe(Effect.orDie)),
          send: { type: "new", text: request.text, attachments },
        })
      : dispatchForGuest({
          type: "thread.room.server",
          commandId: yield* commandId("post"),
          threadId: thread.id,
          action: {
            type: "guest-post",
            participantId: participant.id,
            roomMessageId: RoomMessageId.make(yield* random.uuidV4().pipe(Effect.orDie)),
            text: request.text,
            attachments,
            ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
            suggested: request.suggested === true,
          },
        });
    yield* dispatched.pipe(Effect.onError(() => removeStored(attachments)));
    yield* analytics.record("feature.used", {
      feature: toAgent ? "thread_room.guest_send" : "thread_room.post",
      variant: attachments.length === 0 ? "text_only" : "with_files",
    });
  });

  const send = Effect.fn("ThreadRoomService.send")(function* (session: string, itemId: TurnItemId) {
    const { thread, participant } = yield* authorize(session);
    if (!roleCanUseAgent(participant.role)) return yield* new RoomAccessError({ reason: "role" });
    yield* dispatchForGuest({
      type: "thread.room.guest-dispatch",
      commandId: yield* commandId("deliver"),
      threadId: thread.id,
      participantId: participant.id,
      messageId: MessageId.make(yield* random.uuidV4().pipe(Effect.orDie)),
      send: { type: "room-message", itemId },
    });
    yield* analytics.record("feature.used", {
      feature: "thread_room.send_to_agent",
      variant: "guest",
    });
  });

  const remove = Effect.fn("ThreadRoomService.remove")(function* (
    session: string,
    itemId: TurnItemId,
  ) {
    const { thread, participant } = yield* authorize(session);
    yield* dispatchForGuest({
      type: "thread.room.server",
      commandId: yield* commandId("delete"),
      threadId: thread.id,
      action: { type: "guest-delete", participantId: participant.id, itemId },
    });
  });

  const stop = Effect.fn("ThreadRoomService.stop")(function* (session: string) {
    const { thread, participant } = yield* authorize(session);
    if (!roleCanUseAgent(participant.role)) return yield* new RoomAccessError({ reason: "role" });
    yield* dispatchForGuest({
      type: "thread.room.guest-dispatch",
      commandId: yield* commandId("stop"),
      threadId: thread.id,
      participantId: participant.id,
      messageId: MessageId.make(yield* random.uuidV4().pipe(Effect.orDie)),
      send: { type: "stop" },
    });
  });

  // The image replies each participant's stream sent, so an image loads only while their page
  // can show its reply. Past the limit, records of participants with no open stream are dropped.
  const sentImageReplies = new Map<
    RoomParticipantId,
    {
      openStreams: number;
      readonly replies: Map<string, { readonly text: string; sources?: ReadonlyArray<string> }>;
    }
  >();
  const sentRecord = (participantId: RoomParticipantId) => {
    let record = sentImageReplies.get(participantId);
    if (record === undefined) {
      record = { openStreams: 0, replies: new Map() };
      sentImageReplies.set(participantId, record);
      for (const [id, other] of sentImageReplies) {
        if (sentImageReplies.size <= SENT_REPLIES_LIMIT) break;
        if (other.openStreams === 0 && id !== participantId) sentImageReplies.delete(id);
      }
    }
    return record;
  };
  const rememberSent = (
    participantId: RoomParticipantId,
    items: Iterable<OrchestrationV2TurnItem>,
  ) => {
    for (const item of items) {
      if (item.type !== "assistant_message") continue;
      const key = `${item.threadId}\u0000${item.id}`;
      if (item.text.includes("![") || /<img/i.test(item.text)) {
        sentRecord(participantId).replies.set(key, { text: item.text });
      } else {
        sentImageReplies.get(participantId)?.replies.delete(key);
      }
    }
  };

  const stream = Effect.fn("ThreadRoomService.stream")(function* (session: string) {
    const { thread, room, participant } = yield* authorize(session);
    const snapshot = yield* orchestrator
      .getThreadSnapshotWindow(thread.id, {
        rowLimit: SNAPSHOT_ROW_LIMIT,
        userTurnLimit: SNAPSHOT_USER_TURN_LIMIT,
      })
      .pipe(Effect.mapError(() => new RoomAccessError({ reason: "closed" })));
    const providers = yield* providerRegistry.getProviders;
    // Expiry ends the stream below; views only follow the room's membership and roles.
    const openedAt = yield* DateTime.now;
    const viewOf = (current: OrchestrationV2AppThread): RoomStreamEvent | null => {
      const view = roomGuestView(current, participant.id, onlineOf(thread.id), openedAt);
      return view === null
        ? null
        : { type: "view", view, model: guestThreadModel(current.modelSelection, providers) };
    };
    const opening = viewOf(snapshot.projection.thread);
    if (opening === null || snapshot.projection.thread.room?.id !== room.id) {
      return yield* new RoomAccessError({ reason: "closed" });
    }
    let current = snapshot.projection.thread;

    const endReason = (
      event: OrchestrationV2DomainEvent,
    ): "closed" | "removed" | "archived" | null => {
      if (event.type === "thread.archived" || event.type === "thread.deleted") return "archived";
      const updated = threadOf(event);
      if (updated === null) return null;
      if (updated.archivedAt !== null) return "archived";
      if (updated.room?.id !== room.id) return "closed";
      return updated.room.participants.some((p) => p.id === participant.id) ? null : "removed";
    };
    const live = orchestrator
      .streamStoredEventsFrom({ threadId: thread.id, afterSequence: snapshot.snapshotSequence })
      .pipe(
        Stream.map(threadStreamEventItem),
        Stream.takeUntil((item) => endReason(item.event) !== null),
        coalesceThreadLiveStream,
        Stream.map((item): ReadonlyArray<RoomStreamEvent> => {
          if (item.kind !== "event") return [];
          const ended = endReason(item.event);
          if (ended !== null) return [{ type: "ended", reason: ended }];
          if (item.event.type === "turn-item.updated")
            rememberSent(participant.id, [item.event.payload]);
          const updated = threadOf(item.event);
          if (updated !== null) current = updated;
          const view = updated === null ? null : viewOf(updated);
          return view === null ? [{ type: "thread", item }] : [{ type: "thread", item }, view];
        }),
        Stream.flattenIterable,
        // A failed read closes the response without `ended`: the page reconnects and the
        // session check decides whether the room still works.
        Stream.catchCause(() => Stream.empty),
      );
    const presenceViews = Stream.fromPubSub(presenceChanges).pipe(
      Stream.filter((threadId) => threadId === thread.id),
      Stream.flatMap(() => {
        const view = viewOf(current);
        return view === null ? Stream.empty : Stream.make(view);
      }),
    );
    const untilExpiry = Effect.sleep(
      Math.max(0, Date.parse(participant.expiresAt) - DateTime.toEpochMillis(yield* DateTime.now)),
    );
    const openingSnapshot = buildBoundedThreadStreamSnapshot({
      snapshotSequence: snapshot.snapshotSequence,
      projection: snapshot.projection,
    });
    const events = Stream.fromIterable<RoomStreamEvent>([
      opening,
      { type: "thread", item: openingSnapshot },
    ]).pipe(
      Stream.concat(
        // A live read that fails ends the response, so the page reconnects instead of going stale.
        Stream.merge(
          live,
          Stream.merge(
            presenceViews,
            Stream.fromEffect(
              Effect.as(untilExpiry, { type: "ended", reason: "expired" } as const),
            ),
          ),
          { haltStrategy: "left" },
        ),
      ),
      Stream.takeUntil((event) => event.type === "ended"),
      // Connect unlinking or guest links turned off close it quietly; a tunnel that comes back
      // on the same host lets the guest back in.
      Stream.interruptWhen(
        Effect.all([connectHostname, sharingEnabled]).pipe(
          Effect.repeat({
            schedule: Schedule.spaced(ACCESS_RECHECK_INTERVAL),
            until: ([host, enabled]) => host !== room.host || !enabled,
          }),
        ),
      ),
    );
    return Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const record = sentRecord(participant.id);
          record.openStreams += 1;
          rememberSent(
            participant.id,
            openingSnapshot.projection.visibleTurnItems.map((row) => row.item),
          );
          yield* changeOnline(thread.id, participant.id, 1);
          return record;
        }),
        (record) =>
          Effect.gen(function* () {
            record.openStreams -= 1;
            yield* changeOnline(thread.id, participant.id, -1);
          }),
      ).pipe(Effect.as(events)),
    );
  });

  const unavailable = new RoomAccessError({ reason: "unavailable" });

  const threadItem = Effect.fn("ThreadRoomService.threadItem")(function* (
    session: string,
    itemId: string,
  ) {
    const { thread } = yield* authorize(session);
    const item = yield* orchestrator
      .getTurnItem({ threadId: thread.id, itemId: TurnItemId.make(itemId) })
      .pipe(Effect.mapError(() => unavailable));
    return item === null ? yield* unavailable : { thread, item };
  });

  const render = Effect.fn("ThreadRoomService.render")(function* (session: string, itemId: string) {
    const { thread, item } = yield* threadItem(session, itemId);
    if (item.type !== "dynamic_tool") return yield* unavailable;
    const reference = htmlRenderFromToolItem(item);
    const [attachmentId] = threadHtmlRenderAttachmentIds(thread.id, [item]);
    const path =
      attachmentId === undefined
        ? null
        : resolveAttachmentPathById({ attachmentsDir, attachmentId });
    if (reference === undefined || path === null) return yield* unavailable;
    return { path, title: reference.title };
  });

  const item = Effect.fn("ThreadRoomService.item")(function* (session: string, itemId: string) {
    const { item } = yield* threadItem(session, itemId);
    return {
      item:
        item.type === "file_change" ? projectTurnItemForWire(item) : projectTurnItemForDetail(item),
    };
  });

  const history = Effect.fn("ThreadRoomService.history")(function* (
    session: string,
    cursor: string,
  ) {
    const { thread, participant } = yield* authorize(session);
    const page = yield* orchestrator
      .getThreadHistoryPage(thread.id, cursor)
      .pipe(Effect.mapError(() => unavailable));
    rememberSent(
      participant.id,
      page.items.map((row) => row.item),
    );
    return page;
  });

  const commandOutput = Effect.fn("ThreadRoomService.commandOutput")(function* (
    session: string,
    itemId: string,
  ) {
    const { thread, item } = yield* threadItem(session, itemId);
    if (item.type !== "command_execution") return yield* unavailable;
    const untilRevoked = authorize(session).pipe(
      Effect.repeat(Schedule.spaced(ACCESS_RECHECK_INTERVAL)),
      Effect.ignore,
    );
    return commandOutputs.subscribe({ threadId: thread.id, itemId: item.id }).pipe(
      Stream.catchCause(() => Stream.empty),
      Stream.interruptWhen(untilRevoked),
    );
  });

  const attachment = Effect.fn("ThreadRoomService.attachment")(function* (
    session: string,
    itemId: string,
    attachmentId: string,
  ) {
    const { item } = yield* threadItem(session, itemId);
    const found = itemFiles(item).find((candidate) => candidate.id === attachmentId);
    const path =
      found === undefined ? null : resolveAttachmentPath({ attachmentsDir, attachment: found });
    if (found === undefined || path === null) return yield* unavailable;
    const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
    return exists ? { path, attachment: found } : yield* unavailable;
  });

  const media = Effect.fn("ThreadRoomService.media")(function* (session: string, path: string) {
    const { participant } = yield* authorize(session);
    const mimeType = guestHostImageType(path);
    if (mimeType === null) return yield* unavailable;
    const sent = sentImageReplies.get(participant.id)?.replies.values() ?? [];
    if (
      !repliesShowImage(
        path,
        [...sent],
        (reply) => (reply.sources ??= chatMarkdownImageSources(reply.text)),
      )
    ) {
      return yield* unavailable;
    }
    const header = yield* fileSystem.open(path, { flag: "r" }).pipe(
      Effect.flatMap((file) => file.readAlloc(GUEST_UPLOAD_HEADER_BYTES)),
      Effect.scoped,
      Effect.mapError(() => unavailable),
    );
    if (Option.isNone(header) || !matchesImageSignature(mimeType, header.value)) {
      return yield* unavailable;
    }
    return { path, mimeType };
  });

  return ThreadRoomService.of({
    invite,
    inviteLink,
    presence,
    join,
    check,
    post,
    send,
    remove,
    stop,
    stream,
    item,
    history,
    render,
    commandOutput,
    attachment,
    media,
  });
});

export const layer = Layer.effect(ThreadRoomService, make);
