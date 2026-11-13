import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  EnvironmentId,
  ForwardCompatibleNullable,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { Sha256Digest } from "./scientConversationExport.ts";

/**
 * The desktop server's side of Scient Cloud: enrolling this computer with the
 * signed-in person's cloud account, the conversation copy, share building and
 * take-over import. The renderer talks to the cloud itself with the Clerk
 * session; this server only ever signs as the computer.
 */

const ShortText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const ScientCloudThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScientCloudThreadRef = typeof ScientCloudThreadRef.Type;

// Enrollment

export const ScientCloudEnrollmentProofRequest = Schema.Struct({
  /** From `POST /v1/computers/nonce`, made with the person's session. */
  nonce: ShortText(512),
  /** The Clerk user id of the signed-in person enrolling this computer. */
  userId: ShortText(256),
});
export type ScientCloudEnrollmentProofRequest = typeof ScientCloudEnrollmentProofRequest.Type;

/** Exactly the `POST /v1/computers` body, plus the cloud the proof was made for. */
export const ScientCloudEnrollmentProof = Schema.Struct({
  cloudUrl: ShortText(512),
  environmentId: EnvironmentId,
  label: ShortText(200),
  publicKey: Schema.Struct({
    kty: Schema.Literal("OKP"),
    crv: Schema.Literal("Ed25519"),
    x: Schema.String,
  }),
  proof: Schema.String,
});
export type ScientCloudEnrollmentProof = typeof ScientCloudEnrollmentProof.Type;

/** Sent after `POST /v1/computers` succeeded; the server checks the enrollment with a signed call. */
export const ScientCloudEnrollmentCompleteRequest = Schema.Struct({ userId: ShortText(256) });
export type ScientCloudEnrollmentCompleteRequest = typeof ScientCloudEnrollmentCompleteRequest.Type;

export const ScientCloudSetEnabledRequest = Schema.Struct({ enabled: Schema.Boolean });
export type ScientCloudSetEnabledRequest = typeof ScientCloudSetEnabledRequest.Type;

/**
 * Stop copying and forget the enrollment. With `deleteCopies`, this computer
 * first deletes every copy it uploaded (copies other computers made stay).
 */
export const ScientCloudStopRequest = Schema.Struct({ deleteCopies: Schema.Boolean });
export type ScientCloudStopRequest = typeof ScientCloudStopRequest.Type;

// Status

export const ScientCloudSyncState = Schema.Literals([
  /** The setting is off. */
  "off",
  /** On, but this computer is not enrolled with a cloud account yet. */
  "not-enrolled",
  "idle",
  "copying",
  /** Stopped until something changes; `paused` says why. */
  "paused",
  /** The cloud could not be reached; retrying with backoff. */
  "retrying",
]);
export type ScientCloudSyncState = typeof ScientCloudSyncState.Type;

export const ScientCloudPauseReason = Schema.Literals([
  "storage-full",
  /** The cloud no longer accepts this computer (removed from the account). */
  "not-enrolled",
]);
export type ScientCloudPauseReason = typeof ScientCloudPauseReason.Type;

/** A thread another of the person's computers continued. New turns here are refused. */
export const ScientCloudMovedThread = Schema.Struct({
  threadId: ThreadId,
  movedTo: EnvironmentId,
  movedAt: IsoDateTime,
});
export type ScientCloudMovedThread = typeof ScientCloudMovedThread.Type;

/** A thread this computer continued from another computer's cloud copy. */
export const ScientCloudContinuedThread = Schema.Struct({
  threadId: ThreadId,
  from: ScientCloudThreadRef,
});
export type ScientCloudContinuedThread = typeof ScientCloudContinuedThread.Type;

export const ScientCloudStatus = Schema.Struct({
  cloudUrl: ShortText(512),
  environmentId: EnvironmentId,
  enabled: Schema.Boolean,
  enrolledUserId: Schema.NullOr(ShortText(256)),
  state: ForwardCompatibleNullable(ScientCloudSyncState),
  paused: Schema.NullOr(
    Schema.Struct({
      reason: ForwardCompatibleNullable(ScientCloudPauseReason),
      message: Schema.String,
    }),
  ),
  lastCopiedAt: Schema.NullOr(IsoDateTime),
  copiedThreads: NonNegativeInt,
  pendingThreads: NonNegativeInt,
  /** Compressed bytes of this computer's current copies. */
  copiedBytes: NonNegativeInt,
  /** Account-wide figures from `GET /v1/limits`, when last read. */
  usedBytes: Schema.NullOr(NonNegativeInt),
  freeBytes: Schema.NullOr(NonNegativeInt),
  movedThreads: Schema.Array(ScientCloudMovedThread),
  continuedThreads: Schema.Array(ScientCloudContinuedThread),
});
export type ScientCloudStatus = typeof ScientCloudStatus.Type;

// Share building

export const ScientCloudShareBuildRequest = Schema.Struct({
  threadId: ThreadId,
  reasoning: Schema.Boolean,
  workLog: Schema.Boolean,
  excludeMessageIds: Schema.Array(MessageId).check(Schema.isMaxLength(10_000)),
  /** Redaction ids from an earlier build of the same thread to leave as written. */
  keep: Schema.Array(ShortText(64)).check(Schema.isMaxLength(10_000)),
});
export type ScientCloudShareBuildRequest = typeof ScientCloudShareBuildRequest.Type;

export const ScientCloudRedactionKind = Schema.Literals([
  /** A value saved in Accounts or a provider API key, found by exact match. */
  "saved-secret",
  /** A token-shaped string (private key, JWT, API key prefix, bearer token, credential URL). */
  "secret-pattern",
  "email",
  "home-path",
  /** A text attachment that contained a secret; left out of the share. */
  "attachment",
]);
export type ScientCloudRedactionKind = typeof ScientCloudRedactionKind.Type;

export const ScientCloudRedactionField = Schema.Literals([
  "title",
  "message",
  "reasoning",
  "work-log",
  "plan",
  "question-answer",
  "attachment",
]);
export type ScientCloudRedactionField = typeof ScientCloudRedactionField.Type;

/** One redacted value and where it occurred. Never carries the value. */
export const ScientCloudRedaction = Schema.Struct({
  /** Stable for the same value across builds of one thread on this server run. */
  id: ShortText(64),
  kind: ForwardCompatibleNullable(ScientCloudRedactionKind),
  /** What was found, in words: "Saved password", "GitHub token", "Email address". */
  label: ShortText(200),
  /** The text that replaced it in the document. */
  replacement: Schema.String,
  count: NonNegativeInt,
  locations: Schema.Array(
    Schema.Struct({
      field: ForwardCompatibleNullable(ScientCloudRedactionField),
      /** The snapshot message, reasoning, work-log entry, plan or attachment id. */
      itemId: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ScientCloudRedaction = typeof ScientCloudRedaction.Type;

/** An attachment the share carries; the renderer fetches, encrypts and uploads it as `blob-<sha256>`. */
export const ScientCloudShareBlob = Schema.Struct({
  localId: ShortText(256),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: NonNegativeInt,
  name: ShortText(255),
  mimeType: ShortText(100),
  /** Signed, expiring asset path resolved against the environment's HTTP base URL. */
  relativeUrl: ShortText(4_096),
});
export type ScientCloudShareBlob = typeof ScientCloudShareBlob.Type;

export const ScientCloudShareBuild = Schema.Struct({
  /**
   * The exact JSON text of the redacted `CloudConversation` (`@scientfactory/scient-cloud/api`).
   * Preview parses it; publishing gzips and encrypts these bytes unchanged.
   */
  documentJson: Schema.String,
  contentDigest: Sha256Digest,
  redactions: Schema.Array(ScientCloudRedaction),
  kept: Schema.Array(ScientCloudRedaction),
  coverage: Schema.Struct({
    savedSecretsSearched: NonNegativeInt,
    /** Binary attachments are carried but not searched. */
    binaryAttachmentsNotSearched: NonNegativeInt,
  }),
  blobs: Schema.Array(ScientCloudShareBlob),
});
export type ScientCloudShareBuild = typeof ScientCloudShareBuild.Type;

// Take-over

export const ScientCloudTakeOverRequest = Schema.Struct({
  /** The cloud copy to continue here. The renderer has already taken the lease for this computer. */
  source: ScientCloudThreadRef,
  /** `x-scient-lease-generation` from the lease response. */
  generation: NonNegativeInt,
  /** From the cloud index row, used to find the matching local project. */
  projectKey: ShortText(1000),
  relativePath: Schema.optionalKey(ShortText(1000)),
  /** Set after the person picked a project from `choose-project`. */
  projectId: Schema.optionalKey(ProjectId),
  modelSelection: ModelSelection,
});
export type ScientCloudTakeOverRequest = typeof ScientCloudTakeOverRequest.Type;

export const ScientCloudTakeOverResult = Schema.Union([
  Schema.TaggedStruct("imported", { threadId: ThreadId, projectId: ProjectId }),
  /** No single project matched; ask the person, then retry with `projectId`. */
  Schema.TaggedStruct("choose-project", {
    candidates: Schema.Array(Schema.Struct({ projectId: ProjectId, title: Schema.String })),
  }),
]);
export type ScientCloudTakeOverResult = typeof ScientCloudTakeOverResult.Type;

export const ScientCloudErrorReason = Schema.Literals([
  "not-enrolled",
  "cloud-unavailable",
  /** The cloud refused the request; `message` says why. */
  "cloud-refused",
  "thread-not-found",
  "too-large",
  /** This computer's thread was continued elsewhere. */
  "moved",
]);
export type ScientCloudErrorReason = typeof ScientCloudErrorReason.Type;

export class ScientCloudError extends Schema.TaggedError<ScientCloudError>()(
  "ScientCloudError",
  { reason: ForwardCompatibleNullable(ScientCloudErrorReason), message: Schema.String },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ScientCloudError)(this, { status: 409 });
  }
}
