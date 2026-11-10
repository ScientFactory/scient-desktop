import {
  CreateShareRequest,
  EnrollComputerRequest,
  LEASE_GENERATION_HEADER,
  LeaseRequest,
  PatchShareRequest,
  ShareObjectName,
  ShareReportRequest,
  THREAD_META_HEADER,
  ThreadRef,
  decodeThreadMetaHeader,
  type ThreadMeta,
} from "@scientfactory/scient-cloud/api";
import {
  computerJwsCryptoLayer,
  readComputerAuthorization,
  readComputerTokenIdentity,
  requestTarget,
  verifyComputerRequest,
  verifyEnrollmentProof,
} from "@scientfactory/scient-cloud/computer-jws";
import { CONTENT_FRAME_PATH } from "@scientfactory/scient-cloud/content-frame";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Jwt from "effect/jose/Jwt";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  bytesStream,
  decryptStream,
  encryptStream,
  encryptedLength,
  newWrappedDataKey,
  unwrapDataKey,
} from "./AtRest.ts";
import { EMPTY_UPLOAD, readJsonBody, readUpload, type Upload } from "./Body.ts";
import { CloudError, cloudError, errorBody, errorStatus, failWith } from "./CloudError.ts";
import { Objects } from "./Objects.ts";
import { contentFrame, sharePage } from "./Pages.ts";
import { CloudConfig, PeopleAuth, Shares, Users } from "./Services.ts";
import type { AccessCheck } from "./ShareStore.ts";
import { LimitsOverride, type BaseLimits } from "./UserStore.ts";

/** JSON requests are small; a report is a reason of at most 2000 characters. */
const MAX_JSON_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 8 * 1024;
const GZIP_MAGIC = [0x1f, 0x8b];

/** Bytes stored as-is for the client; the runtime must not compress them again. */
const passthrough = { encodeBody: "manual" } as ResponseInit;

const OBJECT_HEADERS = {
  "content-type": "application/octet-stream",
  "content-disposition": "attachment",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "no-store",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const noContent = () => new Response(null, { status: 204 });

const now = Clock.currentTimeMillis;

const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  maxBytes = MAX_JSON_BYTES,
) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (request: Request) =>
    readJsonBody(request, maxBytes).pipe(
      Effect.flatMap((body) =>
        decode(body).pipe(
          Effect.mapError(() => cloudError("invalid_request", "The request body is not valid.")),
        ),
      ),
    );
};

const readEnrollRequest = decodeJson(EnrollComputerRequest);
const readLeaseRequest = decodeJson(LeaseRequest);
const readCreateShareRequest = decodeJson(CreateShareRequest);
const readPatchShareRequest = decodeJson(PatchShareRequest);
const readShareReportRequest = decodeJson(ShareReportRequest, MAX_REPORT_BYTES);
const readLimitsOverride = decodeJson(Schema.NullOr(LimitsOverride));
const decodeThreadRef = Schema.decodeUnknownOption(ThreadRef);
const isShareObjectName = Schema.is(ShareObjectName);

const bearer = (request: Request) => {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || undefined : undefined;
};

const requireUser = Effect.fn("Api.requireUser")(function* (request: Request) {
  const token = bearer(request);
  if (token === undefined) return yield* failWith("unauthorized", "Sign in to continue.");
  const auth = yield* PeopleAuth;
  return (yield* auth.verify(token)).userId;
});

const optionalUser = (request: Request) =>
  bearer(request) === undefined
    ? Effect.undefined
    : requireUser(request).pipe(Effect.map((userId): string | undefined => userId));

/**
 * Verifies the computer token over the exact body, then spends its `jti`. `readBody` reads the
 * body once the computer is known to be enrolled, bounded by its user's limits.
 */
const requireComputer = Effect.fn("Api.requireComputer")(
  function* (
    request: Request,
    readBody: (limits: BaseLimits) => Effect.Effect<Upload, CloudError> = () =>
      Effect.succeed(EMPTY_UPLOAD),
  ) {
    const token = readComputerAuthorization(request.headers.get("authorization"));
    if (token === undefined) return yield* failWith("unauthorized", "Missing computer token.");
    const config = yield* CloudConfig;
    const identity = yield* readComputerTokenIdentity(token);
    const user = (yield* Users).get(identity.userId);
    const { publicKey, limits } = yield* user.computerAuth(identity.environmentId, config.limits);
    const body = yield* readBody(limits);
    const claims = yield* verifyComputerRequest({
      token,
      publicKey,
      environmentId: identity.environmentId,
      userId: identity.userId,
      audience: config.apiOrigin,
      method: request.method,
      target: requestTarget(new URL(request.url)),
      bodySha256: Base64Url.encode(body.sha256),
    }).pipe(Effect.provide(computerJwsCryptoLayer));
    yield* user.consumeJti({
      env: identity.environmentId,
      jti: claims.jti,
      now: yield* now,
    });
    return { userId: identity.userId, env: identity.environmentId, user, body };
  },
  Effect.catchTags({
    ComputerJwsError: (error) =>
      failWith("unauthorized", `Computer token rejected (${error.reason}).`),
  }),
);

/** A person, or any of their enrolled computers (take-over import reads on the new computer). */
const requireReader = (request: Request) =>
  readComputerAuthorization(request.headers.get("authorization")) === undefined
    ? requireUser(request)
    : requireComputer(request).pipe(Effect.map((computer) => computer.userId));

/** A person, or the computer named by the path. */
const requireUserOrComputer = (request: Request, env: string) =>
  readComputerAuthorization(request.headers.get("authorization")) === undefined
    ? requireUser(request)
    : requireComputer(request).pipe(
        Effect.flatMap((computer) =>
          computer.env === env
            ? Effect.succeed(computer.userId)
            : failWith("forbidden", "A computer can only change its own copies."),
        ),
      );

const dataKeyFor = Effect.fn("Api.dataKeyFor")(function* (userId: string) {
  const { kek } = yield* CloudConfig;
  const user = (yield* Users).get(userId);
  const wrapped =
    (yield* user.dataKey(null)) ?? (yield* user.dataKey(yield* newWrappedDataKey(kek, userId)));
  if (wrapped === null) return yield* Effect.die("Data key was not stored.");
  return yield* unwrapDataKey(kek, userId, wrapped);
});

const decryptedResponse = Effect.fn("Api.decryptedResponse")(function* (
  userId: string,
  objectKey: string,
  headers: Record<string, string>,
  init: ResponseInit = {},
) {
  const stored = yield* (yield* Objects).get(objectKey);
  if (stored === undefined) return yield* failWith("not_found", "The stored copy is missing.");
  const dataKey = yield* dataKeyFor(userId);
  return new Response(stored.body.pipeThrough(decryptStream(dataKey, objectKey)), {
    ...init,
    status: 200,
    headers,
  });
});

const storeEncrypted = Effect.fn("Api.storeEncrypted")(function* (
  userId: string,
  objectKey: string,
  body: Uint8Array,
) {
  const dataKey = yield* dataKeyFor(userId);
  yield* (yield* Objects).put(
    objectKey,
    bytesStream(body).pipeThrough(encryptStream(dataKey, objectKey)),
    encryptedLength(body.length),
  );
});

const deleteObjects = Effect.fn("Api.deleteObjects")(function* (keys: ReadonlyArray<string>) {
  yield* (yield* Objects).delete(keys);
});

const snapshotHeaders = {
  "content-type": "application/json",
  "content-encoding": "gzip",
  "cache-control": "no-store",
};

// Computers and sync

const enroll = Effect.fn("Api.enroll")(function* (request: Request) {
  const userId = yield* requireUser(request);
  const input = yield* readEnrollRequest(request);
  const config = yield* CloudConfig;
  const { claims } = yield* Jwt.decodeUnverified(input.proof).pipe(
    Effect.mapError(() => cloudError("unauthorized", "The enrollment proof is not valid.")),
  );
  const nonce = typeof claims.nonce === "string" ? claims.nonce : "";
  yield* verifyEnrollmentProof({
    token: input.proof,
    publicKey: input.publicKey,
    environmentId: input.environmentId,
    userId,
    audience: config.apiOrigin,
    nonce,
  }).pipe(
    Effect.provide(computerJwsCryptoLayer),
    Effect.catchTags({
      ComputerJwsError: (error) =>
        failWith("unauthorized", `The enrollment proof was rejected (${error.reason}).`),
    }),
  );
  const record = yield* (yield* Users).get(userId).enrollComputer({
    environmentId: input.environmentId,
    label: input.label,
    publicKey: input.publicKey,
    nonce,
    now: yield* now,
  });
  return json(200, record);
});

const parseSince = (value: string | null) => {
  if (value === null || value === "") return 0;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : 0;
};

const putThread = Effect.fn("Api.putThread")(function* (
  request: Request,
  env: string,
  thread: string,
) {
  const computer = yield* requireComputer(request, (limits) =>
    readUpload(request, limits.maxSnapshotBytes),
  );
  const body = computer.body.bytes;
  if (computer.env !== env) {
    return yield* failWith("forbidden", "A computer can only upload its own conversations.");
  }
  const meta: ThreadMeta = yield* decodeThreadMetaHeader(
    request.headers.get(THREAD_META_HEADER) ?? "",
  ).pipe(Effect.mapError(() => cloudError("invalid_request", "The thread meta is not valid.")));
  if (body[0] !== GZIP_MAGIC[0] || body[1] !== GZIP_MAGIC[1]) {
    return yield* failWith("invalid_request", "The conversation must be gzip.");
  }
  const { defaults, user } = { defaults: (yield* CloudConfig).limits, user: computer.user };
  const begun = yield* user.beginThreadPut({
    env,
    thread,
    meta,
    bytes: body.length,
    defaults,
    now: yield* now,
  });
  if (begun.status === "unchanged") return json(200, { status: "unchanged" });
  yield* storeEncrypted(computer.userId, begun.objectKey, body).pipe(
    Effect.onExit((exit) =>
      exit._tag === "Failure" ? user.release(begun.reservation) : Effect.void,
    ),
  );
  const replaced = yield* user
    .commitThreadPut({
      env,
      thread,
      meta,
      reservation: begun.reservation,
      objectKey: begun.objectKey,
      bytes: body.length,
      now: yield* now,
    })
    .pipe(Effect.tapError(() => deleteObjects([begun.objectKey])));
  if (replaced !== null) yield* deleteObjects([replaced]);
  return json(200, { status: "stored" });
});

const getThread = Effect.fn("Api.getThread")(function* (
  request: Request,
  env: string,
  thread: string,
) {
  const userId = yield* requireReader(request);
  const found = yield* (yield* Users).get(userId).getThread(env, thread);
  return yield* decryptedResponse(userId, found.objectKey, snapshotHeaders, passthrough);
});

const lease = Effect.fn("Api.lease")(function* (request: Request, env: string, thread: string) {
  const userId = yield* requireUser(request);
  const { to } = yield* readLeaseRequest(request);
  const leased = yield* (yield* Users).get(userId).lease({ env, thread, to, now: yield* now });
  return yield* decryptedResponse(
    userId,
    leased.objectKey,
    { ...snapshotHeaders, [LEASE_GENERATION_HEADER]: String(leased.generation) },
    passthrough,
  );
});

const blobRef = (url: URL, env: string) => {
  const ref = decodeThreadRef({
    env: url.searchParams.get("env"),
    thread: url.searchParams.get("thread"),
  });
  if (Option.isNone(ref)) {
    return failWith("invalid_request", "Name the conversation with ?env=&thread=.");
  }
  if (ref.value.env !== env) {
    return failWith("forbidden", "A computer can only add files to its own conversations.");
  }
  return Effect.succeed(ref.value);
};

const headBlob = Effect.fn("Api.headBlob")(function* (request: Request, sha: string) {
  const computer = yield* requireComputer(request);
  const ref = yield* blobRef(new URL(request.url), computer.env);
  const exists = yield* computer.user.blobHead(sha, ref);
  return new Response(null, { status: exists ? 200 : 404 });
});

const putBlob = Effect.fn("Api.putBlob")(function* (request: Request, sha: string) {
  const computer = yield* requireComputer(request, (limits) =>
    readUpload(request, limits.maxBlobBytes),
  );
  const body = computer.body.bytes;
  const ref = yield* blobRef(new URL(request.url), computer.env);
  if (bytesToHex(computer.body.sha256) !== sha) {
    return yield* failWith("invalid_request", "The file does not match its SHA-256.");
  }
  const { user } = computer;
  const begun = yield* user.beginBlobPut({
    sha,
    ref,
    bytes: body.length,
    defaults: (yield* CloudConfig).limits,
    now: yield* now,
  });
  if (begun.status === "exists") return json(200, { status: "unchanged" });
  yield* storeEncrypted(computer.userId, begun.objectKey, body).pipe(
    Effect.onExit((exit) =>
      exit._tag === "Failure" ? user.release(begun.reservation) : Effect.void,
    ),
  );
  const duplicate = yield* user
    .commitBlobPut({
      sha,
      ref,
      reservation: begun.reservation,
      objectKey: begun.objectKey,
      bytes: body.length,
    })
    .pipe(Effect.tapError(() => deleteObjects([begun.objectKey])));
  if (duplicate !== null) yield* deleteObjects([duplicate]);
  return json(200, { status: "stored" });
});

const getBlob = Effect.fn("Api.getBlob")(function* (request: Request, sha: string) {
  const userId = yield* requireReader(request);
  const blob = yield* (yield* Users).get(userId).blobForRead(sha);
  return yield* decryptedResponse(userId, blob.objectKey, {
    ...OBJECT_HEADERS,
    "content-length": String(blob.bytes),
  });
});

// Shares

const newShareId = () => Base64Url.encode(crypto.getRandomValues(new Uint8Array(16)));

const createShare = Effect.fn("Api.createShare")(function* (request: Request) {
  const userId = yield* requireUser(request);
  const input = yield* readCreateShareRequest(request);
  const id = newShareId();
  const user = (yield* Users).get(userId);
  yield* user.addShare(id);
  yield* (yield* Shares)
    .get(id)
    .create({ owner: userId, request: input, now: yield* now })
    .pipe(Effect.tapError(() => user.removeShare(id)));
  return json(200, { id });
});

const listShares = Effect.fn("Api.listShares")(function* (request: Request) {
  const userId = yield* requireUser(request);
  const ids = yield* (yield* Users).get(userId).listShares();
  const shares = yield* Shares;
  const at = yield* now;
  const records = yield* Effect.forEach(
    ids,
    (id) => shares.get(id).record(userId, at).pipe(Effect.option),
    { concurrency: 8 },
  );
  return json(200, { shares: records.flatMap((record) => Option.toArray(record)) });
});

const ownedShare = Effect.fn("Api.ownedShare")(function* (userId: string, id: string) {
  yield* (yield* Users).get(userId).ownsShare(id);
  return (yield* Shares).get(id);
});

const patchShare = Effect.fn("Api.patchShare")(function* (request: Request, id: string) {
  const userId = yield* requireUser(request);
  const patch = yield* readPatchShareRequest(request);
  const share = yield* ownedShare(userId, id);
  return json(200, yield* share.patch({ owner: userId, patch, now: yield* now }));
});

const revokeShare = Effect.fn("Api.revokeShare")(function* (request: Request, id: string) {
  const userId = yield* requireUser(request);
  const share = yield* ownedShare(userId, id);
  const keys = yield* share.revoke(userId, yield* now);
  yield* deleteObjects(keys);
  yield* (yield* Users).get(userId).removeShare(id);
  return noContent();
});

const parseVersion = (value: string) => {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1
    ? Effect.succeed(version)
    : failWith("invalid_request", "Versions are positive integers.");
};

const parseObjectName = (value: string) =>
  isShareObjectName(value)
    ? Effect.succeed(value)
    : failWith("invalid_request", "Unknown share object.");

/** Stored as received: ciphertext for encrypted links, the sender's chosen bytes otherwise. */
const putShareObject = Effect.fn("Api.putShareObject")(function* (
  request: Request,
  id: string,
  versionText: string,
  nameText: string,
) {
  const userId = yield* requireUser(request);
  const version = yield* parseVersion(versionText);
  const name = yield* parseObjectName(nameText);
  const share = yield* ownedShare(userId, id);
  const user = (yield* Users).get(userId);
  const { maxSnapshotBytes } = yield* user.effectiveLimits((yield* CloudConfig).limits);
  const body = (yield* readUpload(request, maxSnapshotBytes)).bytes;
  const begun = yield* share.beginPut({ owner: userId, version, name, now: yield* now });
  const reservation = yield* user.beginShareWrite({
    id,
    bytes: body.length,
    replacing: begun.replacing,
    defaults: (yield* CloudConfig).limits,
    now: yield* now,
  });
  const objects = yield* Objects;
  yield* objects
    .put(begun.objectKey, bytesStream(body), body.length)
    .pipe(
      Effect.onExit((exit) => (exit._tag === "Failure" ? user.release(reservation) : Effect.void)),
    );
  const committed = yield* share
    .commitPut({
      owner: userId,
      version,
      name,
      objectKey: begun.objectKey,
      bytes: body.length,
      now: yield* now,
    })
    .pipe(
      Effect.tapError(() =>
        Effect.andThen(user.release(reservation), objects.delete([begun.objectKey])),
      ),
    );
  yield* user.commitShareWrite({
    id,
    reservation,
    totalBytes: committed.totalBytes,
    revision: committed.revision,
  });
  if (committed.replacedKey !== null) yield* objects.delete([committed.replacedKey]);
  return noContent();
});

const publishShare = Effect.fn("Api.publishShare")(function* (
  request: Request,
  id: string,
  versionText: string,
) {
  const userId = yield* requireUser(request);
  const version = yield* parseVersion(versionText);
  const share = yield* ownedShare(userId, id);
  return json(200, yield* share.publish({ owner: userId, version, now: yield* now }));
});

const checkAccess = Effect.fn("Api.checkAccess")(function* (
  check: AccessCheck,
  userId: string | undefined,
) {
  if (check.access.mode === "link" || userId === check.owner) return;
  if (userId === undefined) {
    return yield* failWith("unauthorized", "Sign in to open this shared conversation.");
  }
  if (check.access.mode === "people") {
    const invited = new Set(check.access.emails.map((email) => email.toLowerCase()));
    const emails = yield* (yield* PeopleAuth).verifiedEmails(userId);
    if (emails.some((email) => invited.has(email))) return;
  }
  return yield* failWith("forbidden", "This conversation was not shared with this account.");
});

const publicShare = Effect.fn("Api.publicShare")(function* (request: Request, id: string) {
  const found = yield* (yield* Shares).get(id).publicInfo(yield* now);
  yield* checkAccess(found.check, yield* optionalUser(request));
  return json(200, found.info);
});

const publicShareObject = Effect.fn("Api.publicShareObject")(function* (
  request: Request,
  id: string,
  versionText: string,
  nameText: string,
) {
  const version = yield* parseVersion(versionText);
  const name = yield* parseObjectName(nameText);
  const found = yield* (yield* Shares).get(id).publicObject({ version, name, now: yield* now });
  yield* checkAccess(found.check, yield* optionalUser(request));
  const stored = yield* (yield* Objects).get(found.objectKey);
  if (stored === undefined) return yield* failWith("not_found", "The shared copy is missing.");
  return new Response(stored.body, {
    status: 200,
    headers: { ...OBJECT_HEADERS, "content-length": String(stored.size) },
    ...passthrough,
  });
});

const reportShare = Effect.fn("Api.reportShare")(function* (request: Request, id: string) {
  const { reason } = yield* readShareReportRequest(request);
  yield* (yield* Shares).get(id).report({ reason, now: yield* now });
  return noContent();
});

// Limits and admin

const limits = Effect.fn("Api.limits")(function* (request: Request) {
  const config = yield* CloudConfig;
  const userId = readComputerAuthorization(request.headers.get("authorization"))
    ? (yield* requireComputer(request)).userId
    : yield* optionalUser(request);
  if (userId === undefined) return json(200, config.limits);
  return json(200, yield* (yield* Users).get(userId).limits(config.limits, yield* now));
});

const timingSafeEqual = (a: string, b: string) => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
};

const setUserLimits = Effect.fn("Api.setUserLimits")(function* (request: Request, userId: string) {
  const { adminToken } = yield* CloudConfig;
  const token = bearer(request);
  if (adminToken === null || token === undefined || !timingSafeEqual(token, adminToken)) {
    return yield* failWith("not_found", "Not found.");
  }
  const override = yield* readLimitsOverride(request);
  yield* (yield* Users).get(userId).setLimitsOverride(override);
  return noContent();
});

// Routing

type Handler = (
  request: Request,
  ...params: ReadonlyArray<string>
) => Effect.Effect<Response, CloudError, Services>;
type Services = Users | Shares | PeopleAuth | Objects | CloudConfig;

const routes: ReadonlyArray<readonly [method: string, pattern: RegExp, handler: Handler]> = [
  ["GET", /^\/v1\/limits$/u, limits],
  [
    "POST",
    /^\/v1\/computers\/nonce$/u,
    (request) =>
      Effect.gen(function* () {
        const userId = yield* requireUser(request);
        return json(200, { nonce: yield* (yield* Users).get(userId).createNonce(yield* now) });
      }),
  ],
  ["POST", /^\/v1\/computers$/u, enroll],
  [
    "GET",
    /^\/v1\/computers$/u,
    (request) =>
      Effect.gen(function* () {
        const userId = yield* requireUser(request);
        return json(200, { computers: yield* (yield* Users).get(userId).listComputers() });
      }),
  ],
  [
    "DELETE",
    /^\/v1\/computers\/([^/]+)$/u,
    (request, env) =>
      Effect.gen(function* () {
        const userId = yield* requireUserOrComputer(request, env!);
        yield* (yield* Users).get(userId).removeComputer(env!);
        return noContent();
      }),
  ],
  [
    "DELETE",
    /^\/v1\/computers\/([^/]+)\/threads$/u,
    (request, env) =>
      Effect.gen(function* () {
        const userId = yield* requireUserOrComputer(request, env!);
        yield* deleteObjects(yield* (yield* Users).get(userId).deleteComputerCopies(env!));
        return noContent();
      }),
  ],
  [
    "GET",
    /^\/v1\/computers\/([^/]+)\/moved$/u,
    (request, env) =>
      Effect.gen(function* () {
        const computer = yield* requireComputer(request);
        if (computer.env !== env) return yield* failWith("forbidden", "Not this computer.");
        const since = parseSince(new URL(request.url).searchParams.get("since"));
        return json(200, { threads: yield* computer.user.movedSince(env, since) });
      }),
  ],
  [
    "GET",
    /^\/v1\/threads$/u,
    (request) =>
      Effect.gen(function* () {
        const userId = yield* requireUser(request);
        return json(200, { threads: yield* (yield* Users).get(userId).listThreads() });
      }),
  ],
  ["PUT", /^\/v1\/threads\/([^/]+)\/([^/]+)$/u, putThread],
  ["GET", /^\/v1\/threads\/([^/]+)\/([^/]+)$/u, getThread],
  [
    "DELETE",
    /^\/v1\/threads\/([^/]+)\/([^/]+)$/u,
    (request, env, thread) =>
      Effect.gen(function* () {
        const userId = yield* requireUserOrComputer(request, env!);
        yield* deleteObjects(yield* (yield* Users).get(userId).deleteThread(env!, thread!));
        return noContent();
      }),
  ],
  ["POST", /^\/v1\/threads\/([^/]+)\/([^/]+)\/lease$/u, lease],
  ["HEAD", /^\/v1\/blobs\/([a-f0-9]{64})$/u, headBlob],
  ["PUT", /^\/v1\/blobs\/([a-f0-9]{64})$/u, putBlob],
  ["GET", /^\/v1\/blobs\/([a-f0-9]{64})$/u, getBlob],
  ["POST", /^\/v1\/shares$/u, createShare],
  ["GET", /^\/v1\/shares$/u, listShares],
  ["PATCH", /^\/v1\/shares\/([^/]+)$/u, patchShare],
  ["DELETE", /^\/v1\/shares\/([^/]+)$/u, revokeShare],
  ["PUT", /^\/v1\/shares\/([^/]+)\/v\/([^/]+)\/([^/]+)$/u, putShareObject],
  ["POST", /^\/v1\/shares\/([^/]+)\/v\/([^/]+)\/publish$/u, publishShare],
  ["GET", /^\/v1\/public\/shares\/([^/]+)$/u, publicShare],
  ["GET", /^\/v1\/public\/shares\/([^/]+)\/v\/([^/]+)\/([^/]+)$/u, publicShareObject],
  ["POST", /^\/v1\/public\/shares\/([^/]+)\/report$/u, reportShare],
  ["PUT", /^\/v1\/admin\/users\/([^/]+)\/limits$/u, setUserLimits],
];

const ALLOWED_METHODS = "GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = `authorization, content-type, ${THREAD_META_HEADER}`;
const LOCALHOST_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u;

const corsHeaders = (request: Request, config: CloudConfig["Service"]): Record<string, string> => {
  const origin = request.headers.get("origin");
  if (origin === null) return {};
  const allowed =
    origin === config.pageOrigin ||
    config.appOrigins.includes(origin) ||
    (config.allowLocalhostOrigins && LOCALHOST_ORIGIN.test(origin));
  return allowed
    ? {
        "access-control-allow-origin": origin,
        "access-control-expose-headers": `${LEASE_GENERATION_HEADER}, content-length`,
        vary: "Origin",
      }
    : { vary: "Origin" };
};

const withHeaders = (response: Response, headers: Record<string, string>) => {
  if (Object.keys(headers).length === 0) return response;
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
};

const apiRequest = Effect.fn("Api.apiRequest")(function* (request: Request, path: string) {
  const config = yield* CloudConfig;
  const cors = corsHeaders(request, config);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": ALLOWED_METHODS,
        "access-control-allow-headers": ALLOWED_HEADERS,
        "access-control-max-age": "86400",
      },
    });
  }
  let pathMatched = false;
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (match === null) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    const params = match.slice(1).map((value) => decodeURIComponent(value));
    const response = yield* handler(request, ...params).pipe(
      Effect.catchTags({
        CloudError: (error) => Effect.succeed(json(errorStatus(error), errorBody(error))),
      }),
    );
    return withHeaders(response, cors);
  }
  return withHeaders(
    pathMatched
      ? json(405, { error: "invalid_request", message: "Method not allowed." })
      : json(404, { error: "not_found", message: "Not found." }),
    cors,
  );
});

const hostOf = (origin: string) => new URL(origin).host;

/** One Worker serves the API, the share page and the content frame, each on its own host. */
export const handle = Effect.fn("Api.handle")(
  function* (request: Request) {
    const config = yield* CloudConfig;
    const url = new URL(request.url);
    if (url.pathname === CONTENT_FRAME_PATH && url.host === hostOf(config.contentOrigin)) {
      return contentFrame(config);
    }
    if (url.pathname.startsWith("/s/") && url.host === hostOf(config.pageOrigin)) {
      return yield* sharePage(url.pathname);
    }
    if (url.pathname.startsWith("/v1/") && url.host === hostOf(config.apiOrigin)) {
      return yield* apiRequest(request, url.pathname);
    }
    return new Response("Not found", { status: 404 });
  },
  Effect.catchCause((cause) =>
    Effect.logError("Scient cloud request failed", cause).pipe(
      Effect.as(json(500, { error: "internal", message: "Something went wrong." })),
    ),
  ),
);
