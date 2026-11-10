// @effect-diagnostics nodeBuiltinImport:off -- Cloud snapshots are gzip bodies; Node's zlib owns that format here.
import * as NodeZlib from "node:zlib";

import {
  CloudErrorBody,
  CloudErrorCode,
  CloudLimits,
  type Ed25519PublicJwk,
  MovedThreadsResponse,
  THREAD_META_HEADER,
  type ThreadMeta,
  ThreadPutResponse,
  cloudPaths,
  encodeThreadMetaHeader,
} from "@scientfactory/scient-cloud/api";
import {
  COMPUTER_ENROLLMENT_TYP,
  COMPUTER_REQUEST_TYP,
  computerAuthorizationHeader,
  makeComputerRequestClaims,
  makeEnrollmentProofClaims,
} from "@scientfactory/scient-cloud/computer-jws";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { EnvironmentSigningKey } from "../../cloud/environmentKeys.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";

export const CloudApiErrorCode = Schema.Union([
  CloudErrorCode,
  Schema.Literals(["network", "unexpected"]),
]);
export type CloudApiErrorCode = typeof CloudApiErrorCode.Type;

/** A failed cloud call. `network` and `unexpected` are local; the rest are the Worker's codes. */
export class CloudApiError extends Schema.TaggedError<CloudApiError>()("CloudApiError", {
  code: CloudApiErrorCode,
  status: Schema.NullOr(Schema.Number),
  message: Schema.String,
  movedTo: Schema.NullOr(Schema.String),
  retryAfterMs: Schema.NullOr(Schema.Number),
}) {}

const failure = (
  code: CloudApiErrorCode,
  message: string,
  extra: { status?: number; movedTo?: string; retryAfterMs?: number } = {},
) =>
  new CloudApiError({
    code,
    message,
    status: extra.status ?? null,
    movedTo: extra.movedTo ?? null,
    retryAfterMs: extra.retryAfterMs ?? null,
  });

/** Calls to Scient Cloud signed as this computer for the enrolled person (`userId`). */
export interface CloudApiShape {
  readonly cloudUrl: string;
  readonly environmentId: Effect.Effect<EnvironmentId>;
  readonly label: Effect.Effect<string>;
  readonly publicJwk: Effect.Effect<Ed25519PublicJwk, CloudApiError>;
  readonly enrollmentProof: (input: {
    readonly userId: string;
    readonly nonce: string;
  }) => Effect.Effect<string, CloudApiError>;
  readonly limits: (userId: string) => Effect.Effect<CloudLimits, CloudApiError>;
  readonly putThread: (input: {
    readonly userId: string;
    readonly threadId: ThreadId;
    readonly meta: ThreadMeta;
    readonly gzip: Uint8Array;
  }) => Effect.Effect<ThreadPutResponse, CloudApiError>;
  readonly deleteThread: (userId: string, threadId: ThreadId) => Effect.Effect<void, CloudApiError>;
  readonly hasBlob: (userId: string, sha256: string) => Effect.Effect<boolean, CloudApiError>;
  readonly putBlob: (
    userId: string,
    sha256: string,
    bytes: Uint8Array,
  ) => Effect.Effect<void, CloudApiError>;
  readonly moved: (
    userId: string,
    since: string | undefined,
  ) => Effect.Effect<MovedThreadsResponse, CloudApiError>;
  /** The thread's `CloudConversation` JSON bytes (already decompressed). */
  readonly getThread: (
    userId: string,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Effect.Effect<Uint8Array, CloudApiError>;
  readonly getBlob: (userId: string, sha256: string) => Effect.Effect<Uint8Array, CloudApiError>;
}

export class CloudApi extends Context.Service<CloudApi, CloudApiShape>()(
  "t3/scient/cloud/CloudApi",
) {}

/** The cloud this build talks to: `SCIENT_CLOUD_URL` when set (local runs), else the identity's. */
const resolveCloudUrl = Effect.gen(function* () {
  const override = yield* Config.String("SCIENT_CLOUD_URL").pipe(Config.option);
  const raw = Option.getOrElse(override, () => SCIENT_DESKTOP_IDENTITY.cloudApiUrl).trim();
  return new URL(raw).origin;
});

const isGzip = (bytes: Uint8Array) => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

const gunzipIfNeeded = (bytes: Uint8Array) =>
  isGzip(bytes)
    ? Effect.try({
        try: () =>
          new Uint8Array(NodeZlib.gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 })),
        catch: () => failure("unexpected", "The cloud copy could not be decompressed."),
      })
    : Effect.succeed(bytes);

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(CloudErrorBody));

const retryAfterMs = (value: string | undefined, now: number) => {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

const EMPTY = new Uint8Array();

const make = Effect.gen(function* () {
  const cloudUrl = yield* resolveCloudUrl;
  const signingKey = yield* EnvironmentSigningKey;
  const environment = yield* ServerEnvironment;
  const http = yield* HttpClient.HttpClient;
  const environmentId = environment.getEnvironmentId;

  const send = Effect.fn("CloudApi.send")(function* (input: {
    readonly userId: string;
    readonly method: "GET" | "HEAD" | "PUT" | "DELETE" | "POST";
    readonly path: string;
    readonly body?: Uint8Array;
    readonly contentType?: string;
    readonly headers?: Record<string, string>;
  }) {
    const body = input.body ?? EMPTY;
    const claims = yield* makeComputerRequestClaims({
      environmentId: yield* environmentId,
      userId: input.userId,
      audience: cloudUrl,
      method: input.method,
      target: input.path,
      body,
    });
    const token = yield* signingKey
      .sign({ typ: COMPUTER_REQUEST_TYP, payload: claims })
      .pipe(
        Effect.mapError(() => failure("unexpected", "This computer could not sign the request.")),
      );
    let request = HttpClientRequest.make(input.method)(`${cloudUrl}${input.path}`).pipe(
      HttpClientRequest.setHeaders({
        ...input.headers,
        authorization: computerAuthorizationHeader(token),
      }),
    );
    if (input.body !== undefined) {
      request = HttpClientRequest.bodyUint8Array(
        request,
        body,
        input.contentType ?? "application/octet-stream",
      );
    }
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError(() => failure("network", "Scient Cloud could not be reached.")));
    const bytes =
      input.method === "HEAD"
        ? EMPTY
        : new Uint8Array(
            yield* response.arrayBuffer.pipe(
              Effect.mapError(() => failure("network", "The cloud response was interrupted.")),
            ),
          );
    if (response.status >= 200 && response.status < 300) return { status: response.status, bytes };
    const retryAfter = retryAfterMs(
      response.headers["retry-after"],
      yield* Clock.currentTimeMillis,
    );
    const parsed = decodeErrorBody(new TextDecoder().decode(bytes));
    const extra = {
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    };
    if (Option.isSome(parsed)) {
      return yield* failure(parsed.value.error, parsed.value.message, {
        ...extra,
        ...(parsed.value.movedTo === undefined ? {} : { movedTo: parsed.value.movedTo }),
      });
    }
    if (response.status === 404) return yield* failure("not_found", "Not found.", extra);
    return yield* failure(
      response.status >= 500 || response.status === 429 ? "network" : "unexpected",
      `Scient Cloud answered ${response.status}.`,
      extra,
    );
  });

  const json = <S extends Schema.Top>(schema: S, bytes: Uint8Array) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(() => failure("unexpected", "Scient Cloud sent an unexpected answer.")),
    );

  const publicJwk = Jwk.importSpki(signingKey.publicKey, "EdDSA").pipe(
    Effect.flatMap(({ jwk }) =>
      "x" in jwk && typeof jwk.x === "string"
        ? Effect.succeed({ kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x })
        : Effect.fail(failure("unexpected", "This computer's key is not an Ed25519 key.")),
    ),
    Effect.mapError(() => failure("unexpected", "This computer's key could not be read.")),
  );

  return CloudApi.of({
    cloudUrl,
    environmentId,
    label: environment.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label)),
    publicJwk,
    enrollmentProof: Effect.fn("CloudApi.enrollmentProof")(function* ({ userId, nonce }) {
      const claims = yield* makeEnrollmentProofClaims({
        environmentId: yield* environmentId,
        userId,
        audience: cloudUrl,
        nonce,
      });
      return yield* signingKey
        .sign({ typ: COMPUTER_ENROLLMENT_TYP, payload: claims })
        .pipe(
          Effect.mapError(() => failure("unexpected", "This computer could not sign the proof.")),
        );
    }),
    limits: Effect.fn("CloudApi.limits")(function* (userId) {
      const { bytes } = yield* send({ userId, method: "GET", path: cloudPaths.limits() });
      return yield* json(CloudLimits, bytes);
    }),
    putThread: Effect.fn("CloudApi.putThread")(function* ({ userId, threadId, meta, gzip }) {
      const { bytes } = yield* send({
        userId,
        method: "PUT",
        path: cloudPaths.thread(yield* environmentId, threadId),
        body: gzip,
        contentType: "application/gzip",
        headers: { [THREAD_META_HEADER]: encodeThreadMetaHeader(meta) },
      });
      return yield* json(ThreadPutResponse, bytes);
    }),
    deleteThread: Effect.fn("CloudApi.deleteThread")(function* (userId, threadId) {
      yield* send({
        userId,
        method: "DELETE",
        path: cloudPaths.thread(yield* environmentId, threadId),
      }).pipe(
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.void,
        ),
      );
    }),
    hasBlob: Effect.fn("CloudApi.hasBlob")(function* (userId, sha256) {
      return yield* send({ userId, method: "HEAD", path: cloudPaths.blob(sha256) }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.succeed(false),
        ),
      );
    }),
    putBlob: Effect.fn("CloudApi.putBlob")(function* (userId, sha256, bytes) {
      yield* send({ userId, method: "PUT", path: cloudPaths.blob(sha256), body: bytes });
    }),
    moved: Effect.fn("CloudApi.moved")(function* (userId, since) {
      const { bytes } = yield* send({
        userId,
        method: "GET",
        path: cloudPaths.computerMoved(yield* environmentId, since),
      });
      return yield* json(MovedThreadsResponse, bytes);
    }),
    getThread: Effect.fn("CloudApi.getThread")(function* (userId, env, threadId) {
      const { bytes } = yield* send({
        userId,
        method: "GET",
        path: cloudPaths.thread(env, threadId),
      });
      return yield* gunzipIfNeeded(bytes);
    }),
    getBlob: Effect.fn("CloudApi.getBlob")(function* (userId, sha256) {
      const { bytes } = yield* send({ userId, method: "GET", path: cloudPaths.blob(sha256) });
      return bytes;
    }),
  });
});

/** Over a caller's HttpClient; tests pass a fake one. */
export const layerWithHttpClient = Layer.effect(CloudApi, make);

export const layer = layerWithHttpClient.pipe(Layer.provide(FetchHttpClient.layer));
