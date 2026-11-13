import {
  isProviderSendTurnSupportedImageMimeType,
  OrchestrationV2CommandOutputFrame,
  OrchestrationV2GetTurnItemResult,
  OrchestrationV2ThreadHistoryPage,
  ROOM_MESSAGE_MAX_ATTACHMENT_BYTES,
  ROOM_MESSAGE_MAX_ATTACHMENTS,
  ROOM_PARTICIPANT_PARAM,
  ROOM_ROUTE_PREFIX,
  RoomItemRequest,
  RoomJoinRequest,
  RoomPostRequest,
  RoomStreamEvent,
  roomSessionCookieName,
} from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { assetFileResponse, downloadContentDisposition } from "../../http.ts";
import type { GuestUpload } from "../../guest/guestAttachments.ts";
import { RoomAccessError, ThreadRoomService } from "./ThreadRoomService.ts";

// Cloudflare closes idle streams after about 100 seconds.
const HEARTBEAT_INTERVAL = Duration.seconds(20);
const NO_STORE = { "cache-control": "no-store" };
// A file never runs as a page on this origin, whatever its bytes.
const FILE_HEADERS = {
  ...NO_STORE,
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};
const JSON_MAX_BODY_BYTES = 64 * 1024;

const decodeJoin = Schema.decodeUnknownEffect(RoomJoinRequest);
const decodePost = Schema.decodeUnknownEffect(RoomPostRequest);
const decodeItemRequest = Schema.decodeUnknownEffect(RoomItemRequest);
const encodeStreamEvent = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(RoomStreamEvent)),
);
const encodeOutputFrame = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CommandOutputFrame),
);
const encodeItem = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2GetTurnItemResult));
const encodeHistoryPage = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage));

const errorResponse = (error: RoomAccessError) =>
  HttpServerResponse.json(
    { reason: error.reason, message: error.message },
    {
      status:
        error.reason === "invalid" ||
        error.reason === "closed" ||
        error.reason === "removed" ||
        error.reason === "role" ||
        error.reason === "unavailable"
          ? 403
          : error.reason === "empty" ||
              error.reason === "too_many_files" ||
              error.reason === "too_large" ||
              error.reason === "unsupported_file"
            ? 400
            : error.reason === "rate_limited"
              ? 429
              : 409,
      headers: NO_STORE,
    },
  );

const badRequest = HttpServerResponse.json(
  { reason: "invalid", message: "The request was not valid." },
  { status: 400, headers: NO_STORE },
);

const query = (request: HttpServerRequest.HttpServerRequest) =>
  new URLSearchParams(request.url.split("?", 2)[1] ?? "");

/** The session of the participant the request names in `?p=`. */
const sessionOf = (request: HttpServerRequest.HttpServerRequest) => {
  const participantId = query(request).get(ROOM_PARTICIPANT_PARAM);
  return participantId === null
    ? ""
    : (request.cookies[roomSessionCookieName(participantId)] ?? "");
};
const session = Effect.map(HttpServerRequest.HttpServerRequest, sessionOf);
const param = (name: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) => query(request).get(name));

const eventStreamResponse = <A>(
  events: Stream.Stream<A>,
  encode: (event: A) => Effect.Effect<string, Schema.SchemaError>,
) => {
  const data = events.pipe(
    Stream.mapEffect((event) =>
      encode(event).pipe(
        Effect.map((json) => [`data: ${json}\n\n`]),
        Effect.catch(() =>
          Effect.logWarning("Dropped a room stream event that failed to encode.").pipe(
            Effect.as([]),
          ),
        ),
      ),
    ),
    Stream.flattenIterable,
  );
  const heartbeat = Stream.tick(HEARTBEAT_INTERVAL).pipe(Stream.map(() => ": ping\n\n"));
  return HttpServerResponse.stream(
    data.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
    {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    },
  );
};

// Anyone who can reach the tunnel can post to these routes.
const readJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? "0") > JSON_MAX_BODY_BYTES) {
    return yield* new RoomAccessError({ reason: "too_large" });
  }
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
  );
});

const joinRoute = HttpRouter.add(
  "POST",
  `${ROOM_ROUTE_PREFIX}/join`,
  Effect.gen(function* () {
    const body = yield* readJson.pipe(Effect.flatMap(decodeJoin), Effect.option);
    if (body._tag === "None") return yield* badRequest;
    const rooms = yield* ThreadRoomService;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return yield* rooms.join(body.value).pipe(
      Effect.flatMap(({ token, participantId, expiresAt }) =>
        HttpServerResponse.json({ participantId }, { headers: NO_STORE }).pipe(
          Effect.flatMap(
            HttpServerResponse.setCookie(roomSessionCookieName(participantId), token, {
              httpOnly: true,
              secure: true,
              sameSite: "strict",
              path: ROOM_ROUTE_PREFIX,
              maxAge: Duration.millis(Math.max(0, Date.parse(expiresAt) - now)),
            }),
          ),
        ),
      ),
      Effect.catchTags({ RoomAccessError: errorResponse }),
    );
  }),
);

// Lets a returning guest skip the name form when this browser already joined.
const sessionRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/session`,
  Effect.gen(function* () {
    const rooms = yield* ThreadRoomService;
    return yield* rooms
      .check(yield* session)
      .pipe(
        Effect.as(HttpServerResponse.empty({ status: 204, headers: NO_STORE })),
        Effect.catchTags({ RoomAccessError: errorResponse }),
      );
  }),
);

const UPLOAD_LIMITS = Multipart.limitsServices({
  maxParts: ROOM_MESSAGE_MAX_ATTACHMENTS + 6,
  maxFileSize: ROOM_MESSAGE_MAX_ATTACHMENT_BYTES,
  maxTotalSize: ROOM_MESSAGE_MAX_ATTACHMENT_BYTES + 64 * 1024,
  // By default a JSON part is read as a field, which would drop a guest's `.json` file.
  fieldMimeTypes: [],
});

const readPost = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!request.headers["content-type"]?.startsWith("multipart/form-data")) {
    const body = yield* readJson.pipe(Effect.flatMap(decodePost), Effect.option);
    return body._tag === "None" ? null : { fields: body.value, uploads: [] };
  }
  const parts = yield* request.multipart.pipe(
    Effect.provideContext(UPLOAD_LIMITS),
    Effect.mapError(
      (error) =>
        new RoomAccessError({
          reason:
            error.reason._tag === "TooManyParts"
              ? "too_many_files"
              : error.reason._tag === "Parse"
                ? "rejected"
                : "too_large",
        }),
    ),
  );
  const fields = yield* decodePost({
    text: parts.text ?? "",
    to: parts.to,
    ...(typeof parts.replyTo === "string" && parts.replyTo !== ""
      ? { replyTo: parts.replyTo }
      : {}),
    ...(parts.suggested === "true" ? { suggested: true } : {}),
  }).pipe(Effect.option);
  if (fields._tag === "None") return null;
  const files = parts.file;
  const uploads: ReadonlyArray<GuestUpload> = Array.isArray(files)
    ? files.filter(Multipart.isPersistedFile).map(({ name, contentType, path }) => ({
        name,
        contentType,
        path,
      }))
    : [];
  return { fields: fields.value, uploads };
});

const postRoute = HttpRouter.add(
  "POST",
  `${ROOM_ROUTE_PREFIX}/messages`,
  Effect.gen(function* () {
    const rooms = yield* ThreadRoomService;
    const token = yield* session;
    // The session is checked before the body is read, so only a member can make the server
    // parse and store up to 10 MB.
    yield* rooms.check(token);
    const submission = yield* readPost;
    if (submission === null) return yield* badRequest;
    yield* rooms.post(token, submission.fields, submission.uploads);
    return HttpServerResponse.empty({ status: 204, headers: NO_STORE });
  }).pipe(Effect.catchTags({ RoomAccessError: errorResponse }), Effect.scoped),
);

const itemActionRoute = (path: string, act: "send" | "remove") =>
  HttpRouter.add(
    "POST",
    `${ROOM_ROUTE_PREFIX}/${path}`,
    Effect.gen(function* () {
      const body = yield* readJson.pipe(Effect.flatMap(decodeItemRequest), Effect.option);
      if (body._tag === "None") return yield* badRequest;
      const rooms = yield* ThreadRoomService;
      yield* rooms[act](yield* session, body.value.itemId);
      return HttpServerResponse.empty({ status: 204, headers: NO_STORE });
    }).pipe(Effect.catchTags({ RoomAccessError: errorResponse })),
  );

const stopRoute = HttpRouter.add(
  "POST",
  `${ROOM_ROUTE_PREFIX}/stop`,
  Effect.gen(function* () {
    const rooms = yield* ThreadRoomService;
    yield* rooms.stop(yield* session);
    return HttpServerResponse.empty({ status: 204, headers: NO_STORE });
  }).pipe(Effect.catchTags({ RoomAccessError: errorResponse })),
);

const streamRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/stream`,
  Effect.gen(function* () {
    const rooms = yield* ThreadRoomService;
    return yield* rooms.stream(yield* session).pipe(
      Effect.map((events) => eventStreamResponse(events, encodeStreamEvent)),
      Effect.catchTags({ RoomAccessError: errorResponse }),
    );
  }),
);

// Served with the asset route's sandbox CSP: the page gets an opaque origin, so its scripts cannot
// send the guest cookie or call these routes as the guest.
const renderRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/render`,
  Effect.gen(function* () {
    const itemId = yield* param("item");
    if (!itemId) return yield* badRequest;
    const rooms = yield* ThreadRoomService;
    return yield* rooms.render(yield* session, itemId).pipe(
      Effect.flatMap(({ path, title }) =>
        assetFileResponse({ path, mimeType: "text/html", fileName: htmlRenderFileName(title) }),
      ),
      Effect.map((response) => HttpServerResponse.setHeaders(response, NO_STORE)),
      Effect.catchTags({ RoomAccessError: errorResponse }),
    );
  }),
);

const itemRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/item`,
  Effect.gen(function* () {
    const itemId = yield* param("item");
    if (!itemId) return yield* badRequest;
    const rooms = yield* ThreadRoomService;
    return yield* rooms.item(yield* session, itemId).pipe(
      Effect.flatMap((result) =>
        encodeItem(result).pipe(
          Effect.mapError(() => new RoomAccessError({ reason: "unavailable" })),
        ),
      ),
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
      Effect.catchTags({ RoomAccessError: errorResponse }),
    );
  }),
);

const historyRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/history`,
  Effect.gen(function* () {
    const cursor = yield* param("cursor");
    if (!cursor) return yield* badRequest;
    const rooms = yield* ThreadRoomService;
    return yield* rooms.history(yield* session, cursor).pipe(
      Effect.flatMap((page) =>
        encodeHistoryPage(page).pipe(
          Effect.mapError(() => new RoomAccessError({ reason: "unavailable" })),
        ),
      ),
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
      Effect.catchTags({ RoomAccessError: errorResponse }),
    );
  }),
);

const commandOutputRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/command-output`,
  Effect.gen(function* () {
    const itemId = yield* param("item");
    if (!itemId) return yield* badRequest;
    const rooms = yield* ThreadRoomService;
    return yield* rooms.commandOutput(yield* session, itemId).pipe(
      Effect.map((frames) => eventStreamResponse(frames, encodeOutputFrame)),
      Effect.catchTags({ RoomAccessError: errorResponse }),
    );
  }),
);

// Images of the four checked types load inline; anything else downloads as bytes.
const attachmentRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/attachment`,
  Effect.gen(function* () {
    const itemId = yield* param("item");
    const attachmentId = yield* param("id");
    if (!itemId || !attachmentId) return yield* badRequest;
    const rooms = yield* ThreadRoomService;
    return yield* rooms.attachment(yield* session, itemId, attachmentId).pipe(
      Effect.flatMap(({ path, attachment }) =>
        HttpServerResponse.file(path, {
          headers: {
            ...FILE_HEADERS,
            ...(attachment.type === "image" &&
            isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
              ? { "content-type": attachment.mimeType }
              : {
                  "content-type": "application/octet-stream",
                  "content-disposition": downloadContentDisposition(attachment.name),
                }),
          },
        }),
      ),
      Effect.catchTags({ RoomAccessError: errorResponse }),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500, headers: NO_STORE })),
    );
  }),
);

// Only an image an agent reply shows loads; anything else on the host is refused.
const mediaRoute = HttpRouter.add(
  "GET",
  `${ROOM_ROUTE_PREFIX}/media`,
  Effect.gen(function* () {
    const path = yield* param("path");
    if (!path) return yield* badRequest;
    const rooms = yield* ThreadRoomService;
    return yield* rooms.media(yield* session, path).pipe(
      Effect.flatMap(({ path, mimeType }) =>
        HttpServerResponse.file(path, { headers: { ...FILE_HEADERS, "content-type": mimeType } }),
      ),
      Effect.catchTags({ RoomAccessError: errorResponse }),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500, headers: NO_STORE })),
    );
  }),
);

export const layer = Layer.mergeAll(
  joinRoute,
  sessionRoute,
  postRoute,
  itemActionRoute("send", "send"),
  itemActionRoute("delete", "remove"),
  stopRoute,
  streamRoute,
  renderRoute,
  itemRoute,
  historyRoute,
  commandOutputRoute,
  attachmentRoute,
  mediaRoute,
);
