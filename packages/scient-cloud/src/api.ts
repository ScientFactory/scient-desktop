import {
  ConversationSnapshotV1,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  Sha256Digest,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const SCIENT_CLOUD_ORIGIN = "https://cloud.scientfactory.com";
const SCIENT_SHARE_ORIGIN = "https://scientfactory.com";
export const SCIENT_SHARE_CONTENT_ORIGIN = "https://share.scientusercontent.com";

export const THREAD_META_HEADER = "x-scient-thread-meta";
/** The lease response body is the thread's gzip snapshot, so its generation travels here. */
export const LEASE_GENERATION_HEADER = "x-scient-lease-generation";
/** Header values over a few KiB risk proxy limits; meta beyond this is refused. */
export const THREAD_META_HEADER_MAX_BYTES = 8 * 1024;

const Text = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

/** Lowercase hex SHA-256, as blob paths and share object names carry it. */
export const BlobSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type BlobSha256 = typeof BlobSha256.Type;

/** 16 random bytes, base64url. Unrelated to any share key. */
export const ShareId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/));
export type ShareId = typeof ShareId.Type;

export const CloudErrorCode = Schema.Literals([
  "lease_lost",
  "quota_exceeded",
  "too_large",
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "replayed",
]);
export type CloudErrorCode = typeof CloudErrorCode.Type;

export const CLOUD_ERROR_STATUS = {
  lease_lost: 409,
  quota_exceeded: 413,
  too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  replayed: 401,
} as const satisfies Record<CloudErrorCode, number>;

export const CloudErrorBody = Schema.Struct({
  error: CloudErrorCode,
  message: Schema.String,
  /** Set with `lease_lost`: the computer that continued the conversation. */
  movedTo: Schema.optionalKey(EnvironmentId),
});
export type CloudErrorBody = typeof CloudErrorBody.Type;

// Computers

export const Ed25519PublicJwk = Schema.Struct({
  kty: Schema.Literal("OKP"),
  crv: Schema.Literal("Ed25519"),
  x: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
export type Ed25519PublicJwk = typeof Ed25519PublicJwk.Type;

export const ComputerNonceResponse = Schema.Struct({ nonce: Schema.String });
export type ComputerNonceResponse = typeof ComputerNonceResponse.Type;

export const EnrollComputerRequest = Schema.Struct({
  environmentId: EnvironmentId,
  label: Text(200),
  publicKey: Ed25519PublicJwk,
  /** Enrollment proof JWS signed by `publicKey`'s private half (see `computerJws.ts`). */
  proof: Schema.String,
});
export type EnrollComputerRequest = typeof EnrollComputerRequest.Type;

export const ComputerRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: Text(200),
  enrolledAt: IsoDateTime,
  lastSeenAt: Schema.NullOr(IsoDateTime),
});
export type ComputerRecord = typeof ComputerRecord.Type;

export const ComputerListResponse = Schema.Struct({ computers: Schema.Array(ComputerRecord) });
export type ComputerListResponse = typeof ComputerListResponse.Type;

export const CloudLimits = Schema.Struct({
  freeBytes: NonNegativeInt,
  maxSnapshotBytes: NonNegativeInt,
  maxBlobBytes: NonNegativeInt,
  maxThreads: NonNegativeInt,
  /** Present when the caller is a signed-in user or computer. */
  usedBytes: Schema.optionalKey(NonNegativeInt),
});
export type CloudLimits = typeof CloudLimits.Type;

// Sync

export const ThreadRef = Schema.Struct({ env: EnvironmentId, thread: ThreadId });
export type ThreadRef = typeof ThreadRef.Type;

export const ThreadMeta = Schema.Struct({
  title: Text(500),
  /** The project's grouping key across computers (`repositoryGroupingKeyOf`). */
  projectKey: Text(1000),
  projectLabel: Text(200),
  relativePath: Schema.optionalKey(Text(1000)),
  repoWebUrl: Schema.optionalKey(Text(1000)),
  branch: Schema.optionalKey(Text(500)),
  headCommit: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{7,64}$/))),
  updatedAt: IsoDateTime,
  archived: Schema.Boolean,
  contentDigest: Sha256Digest,
  generation: NonNegativeInt,
  continuedFrom: Schema.optionalKey(ThreadRef),
});
export type ThreadMeta = typeof ThreadMeta.Type;

const ThreadMetaJson = Schema.fromJsonString(ThreadMeta);
const encodeThreadMetaJson = Schema.encodeSync(ThreadMetaJson);
const decodeThreadMetaJson = Schema.decodeUnknownEffect(ThreadMetaJson);

export class ThreadMetaHeaderError extends Schema.TaggedError<ThreadMetaHeaderError>()(
  "ThreadMetaHeaderError",
  { reason: Schema.Literals(["too_large", "malformed"]) },
) {}

export function encodeThreadMetaHeader(meta: ThreadMeta): string {
  return Base64Url.encode(encodeThreadMetaJson(meta));
}

export const decodeThreadMetaHeader = Effect.fn("ScientCloud.decodeThreadMetaHeader")(function* (
  value: string,
) {
  if (value.length > THREAD_META_HEADER_MAX_BYTES) {
    return yield* new ThreadMetaHeaderError({ reason: "too_large" });
  }
  const json = Base64Url.decodeString(value);
  if (Result.isFailure(json)) {
    return yield* new ThreadMetaHeaderError({ reason: "malformed" });
  }
  return yield* decodeThreadMetaJson(json.success).pipe(
    Effect.mapError(() => new ThreadMetaHeaderError({ reason: "malformed" })),
  );
});

export const ThreadPutResponse = Schema.Struct({
  status: Schema.Literals(["stored", "unchanged"]),
});
export type ThreadPutResponse = typeof ThreadPutResponse.Type;

/** Share and reader extras the snapshot format does not carry. */
export const SnapshotSidecar = Schema.Struct({
  /** Bytes of the snapshot's available attachments, by `ConversationAttachment.localId`. */
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        localId: TrimmedNonEmptyString,
        sha256: BlobSha256,
        bytes: NonNegativeInt,
      }),
    ),
  ),
  answers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        messageId: MessageId,
        provider: Schema.NullOr(TrimmedNonEmptyString),
        model: Schema.NullOr(TrimmedNonEmptyString),
      }),
    ),
  ),
  repository: Schema.optionalKey(
    Schema.Struct({ webUrl: TrimmedNonEmptyString, commit: TrimmedNonEmptyString }),
  ),
  /** Rendered HTML outputs stored as blobs (`/v1/blobs/:sha256` or share `blob-<sha256>`). */
  renders: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        messageId: Schema.NullOr(MessageId),
        name: TrimmedNonEmptyString,
        sha256: BlobSha256,
        bytes: NonNegativeInt,
      }),
    ),
  ),
});
export type SnapshotSidecar = typeof SnapshotSidecar.Type;

/** The JSON document a thread upload gzips, and a share's `snapshot` object holds. */
export const CloudConversation = Schema.Struct({
  snapshot: ConversationSnapshotV1,
  sidecar: Schema.optionalKey(SnapshotSidecar),
});
export type CloudConversation = typeof CloudConversation.Type;

export const ThreadIndexRow = Schema.Struct({
  ...ThreadMeta.fields,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  ownerEnvironmentId: EnvironmentId,
  movedTo: Schema.NullOr(EnvironmentId),
  bytes: NonNegativeInt,
});
export type ThreadIndexRow = typeof ThreadIndexRow.Type;

export const ThreadIndexResponse = Schema.Struct({ threads: Schema.Array(ThreadIndexRow) });
export type ThreadIndexResponse = typeof ThreadIndexResponse.Type;

export const MovedThreadsResponse = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      movedTo: EnvironmentId,
      generation: NonNegativeInt,
      movedAt: IsoDateTime,
    }),
  ),
});
export type MovedThreadsResponse = typeof MovedThreadsResponse.Type;

export const LeaseRequest = Schema.Struct({ to: EnvironmentId });
export type LeaseRequest = typeof LeaseRequest.Type;

// Shares

export const ShareAccess = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("link") }),
  Schema.Struct({
    mode: Schema.Literal("people"),
    emails: Schema.Array(Text(320)).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({ mode: Schema.Literal("me") }),
]);
export type ShareAccess = typeof ShareAccess.Type;

/** Preview-card text for unencrypted shares; encrypted shares have none. */
export const ShareCard = Schema.Struct({
  title: Text(300),
  description: Schema.optionalKey(Text(1000)),
});
export type ShareCard = typeof ShareCard.Type;

/** `snapshot` (gzip `CloudConversation`), `meta` (`ShareMeta` JSON), or `blob-<sha256>`. */
export const ShareObjectName = Schema.String.check(
  Schema.isPattern(/^(?:snapshot|meta|blob-[a-f0-9]{64})$/),
);
export type ShareObjectName = typeof ShareObjectName.Type;

export const ShareMeta = Schema.Struct({ title: Text(500), sharedAt: IsoDateTime });
export type ShareMeta = typeof ShareMeta.Type;

export const CreateShareRequest = Schema.Struct({
  source: ThreadRef,
  encrypted: Schema.Boolean,
  access: ShareAccess,
  expiresAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  indexable: Schema.Boolean,
  card: Schema.optionalKey(ShareCard),
}).check(
  // A card is readable by the service, so an encrypted share must not carry one.
  Schema.makeFilter((request) => !(request.encrypted && request.card !== undefined)),
);
export type CreateShareRequest = typeof CreateShareRequest.Type;

export const CreateShareResponse = Schema.Struct({ id: ShareId });
export type CreateShareResponse = typeof CreateShareResponse.Type;

export const PatchShareRequest = Schema.Struct({
  access: Schema.optionalKey(ShareAccess),
  expiresAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  indexable: Schema.optionalKey(Schema.Boolean),
});
export type PatchShareRequest = typeof PatchShareRequest.Type;

export const ShareVersion = Schema.Struct({ version: PositiveInt, publishedAt: IsoDateTime });
export type ShareVersion = typeof ShareVersion.Type;

export const ShareRecord = Schema.Struct({
  id: ShareId,
  source: ThreadRef,
  encrypted: Schema.Boolean,
  access: ShareAccess,
  expiresAt: Schema.NullOr(IsoDateTime),
  indexable: Schema.Boolean,
  card: Schema.optionalKey(ShareCard),
  createdAt: IsoDateTime,
  currentVersion: Schema.NullOr(PositiveInt),
  versions: Schema.Array(ShareVersion),
});
export type ShareRecord = typeof ShareRecord.Type;

export const ShareListResponse = Schema.Struct({ shares: Schema.Array(ShareRecord) });
export type ShareListResponse = typeof ShareListResponse.Type;

export const PublicShareInfo = Schema.Struct({
  encrypted: Schema.Boolean,
  currentVersion: PositiveInt,
  versions: Schema.Array(ShareVersion),
  /** Objects of the current version, with stored (ciphertext when encrypted) sizes. */
  objects: Schema.Array(Schema.Struct({ name: ShareObjectName, bytes: NonNegativeInt })),
});
export type PublicShareInfo = typeof PublicShareInfo.Type;

export const ShareReportRequest = Schema.Struct({ reason: Text(2000) });
export type ShareReportRequest = typeof ShareReportRequest.Type;

// Paths. Every segment is URL-encoded, so callers may pass decoded values.

const seg = encodeURIComponent;

export const cloudPaths = {
  computerNonce: () => "/v1/computers/nonce",
  computers: () => "/v1/computers",
  /** DELETE stops syncing: the computer can no longer upload; its copies stay readable. */
  computer: (env: string) => `/v1/computers/${seg(env)}`,
  /** DELETE removes every copy the computer made (person or that computer). */
  computerThreads: (env: string) => `/v1/computers/${seg(env)}/threads`,
  computerMoved: (env: string, since?: string) =>
    `/v1/computers/${seg(env)}/moved${since === undefined ? "" : `?since=${seg(since)}`}`,
  limits: () => "/v1/limits",
  threads: () => "/v1/threads",
  /** GET accepts the person or any of their enrolled computers (take-over import reads it). */
  thread: (env: string, thread: string) => `/v1/threads/${seg(env)}/${seg(thread)}`,
  threadLease: (env: string, thread: string) => `/v1/threads/${seg(env)}/${seg(thread)}/lease`,
  /**
   * GET accepts the person or any of their enrolled computers, for referenced blobs only.
   * Computers name the conversation that uses the file on `HEAD` and `PUT`; a file is readable
   * only while a stored conversation of the same user refers to it.
   */
  blob: (sha256: string, usedBy?: ThreadRef) =>
    `/v1/blobs/${seg(sha256)}${
      usedBy === undefined ? "" : `?env=${seg(usedBy.env)}&thread=${seg(usedBy.thread)}`
    }`,
  shares: () => "/v1/shares",
  share: (id: string) => `/v1/shares/${seg(id)}`,
  shareObject: (id: string, version: number, object: string) =>
    `/v1/shares/${seg(id)}/v/${version}/${seg(object)}`,
  sharePublish: (id: string, version: number) => `/v1/shares/${seg(id)}/v/${version}/publish`,
  publicShare: (id: string) => `/v1/public/shares/${seg(id)}`,
  publicShareObject: (id: string, version: number, object: string) =>
    `/v1/public/shares/${seg(id)}/v/${version}/${seg(object)}`,
  publicShareReport: (id: string) => `/v1/public/shares/${seg(id)}/report`,
  sharePage: (id: string) => `/s/${seg(id)}`,
} as const;

/** The public link. `fragmentKey` (from `encodeShareKey`) stays in the fragment, never sent. */
export function shareLink(id: string, fragmentKey?: string, origin = SCIENT_SHARE_ORIGIN): string {
  const page = `${origin.replace(/\/+$/u, "")}${cloudPaths.sharePage(id)}`;
  return fragmentKey === undefined ? page : `${page}#${fragmentKey}`;
}
