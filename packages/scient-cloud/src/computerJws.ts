import { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as JoseError from "effect/jose/JoseError";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { Ed25519PublicJwk } from "./api.ts";

/**
 * Signed computer requests. The desktop server signs claims built here with its environment
 * key (`EnvironmentSigningKey.sign({ typ, payload })`); the Worker verifies them against the
 * public key stored at enrollment. Replay (`jti`) and nonce single use are the caller's job.
 */

export const COMPUTER_REQUEST_TYP = "scient-cloud+jwt";
export const COMPUTER_ENROLLMENT_TYP = "scient-cloud-enroll+jwt";
const COMPUTER_AUTHORIZATION_SCHEME = "ScientComputer";
const COMPUTER_JWS_MAX_LIFETIME_SECONDS = 300;
const CLOCK_TOLERANCE = "60 seconds";

/** WebCrypto signing for Workers, browsers and Node; the server already has its own. */
export const computerJwsCryptoLayer = Signature.layerWebCrypto.pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
);

const computerIssuer = (environmentId: string) => `scient-env:${environmentId}`;

const normalizeCloudOrigin = (origin: string) => origin.trim().replace(/\/+$/u, "");

export function computerAuthorizationHeader(token: string): string {
  return `${COMPUTER_AUTHORIZATION_SCHEME} ${token}`;
}

export function readComputerAuthorization(header: string | null | undefined): string | undefined {
  const prefix = `${COMPUTER_AUTHORIZATION_SCHEME} `;
  if (header === null || header === undefined || !header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length).trim();
  return token === "" ? undefined : token;
}

const Jti = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128));

const BaseClaims = {
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  jti: Jti,
};

export const ComputerRequestClaims = Schema.Struct({
  ...BaseClaims,
  /** HTTP method, uppercase. */
  htm: Schema.String,
  /** Path and query of the request URL. */
  htu: Schema.String,
  /** base64url SHA-256 of the exact request body (empty body included). */
  bsha: Schema.String,
});
export type ComputerRequestClaims = typeof ComputerRequestClaims.Type;

export const EnrollmentProofClaims = Schema.Struct({
  ...BaseClaims,
  environmentId: EnvironmentId,
  nonce: Schema.String,
});
export type EnrollmentProofClaims = typeof EnrollmentProofClaims.Type;

export const ComputerJwsFailure = Schema.Literals([
  "malformed",
  "invalid_key",
  "bad_signature",
  "wrong_type",
  "wrong_issuer",
  "wrong_subject",
  "wrong_audience",
  "expired",
  "not_yet_valid",
  "lifetime_too_long",
  "method_mismatch",
  "target_mismatch",
  "body_mismatch",
  "nonce_mismatch",
]);
export type ComputerJwsFailure = typeof ComputerJwsFailure.Type;

export class ComputerJwsError extends Schema.TaggedError<ComputerJwsError>()("ComputerJwsError", {
  reason: ComputerJwsFailure,
}) {
  override get message(): string {
    return `Computer request token rejected: ${this.reason}.`;
  }
}

const fail = (reason: ComputerJwsFailure) => Effect.fail(new ComputerJwsError({ reason }));

export const bodySha256 = Effect.fn("ScientCloud.bodySha256")(function* (body: Uint8Array) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", Uint8Array.from(body)),
  );
  return Base64Url.encode(new Uint8Array(digest));
});

/** "/v1/threads/a/b?x=1" for a request URL: what `htu` carries. */
export const requestTarget = (url: URL) => `${url.pathname}${url.search}`;

const baseClaims = Effect.fn("ScientCloud.baseClaims")(function* (input: {
  readonly environmentId: string;
  readonly userId: string;
  readonly audience: string;
}) {
  const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return {
    iss: computerIssuer(input.environmentId),
    sub: input.userId,
    aud: normalizeCloudOrigin(input.audience),
    iat,
    exp: iat + COMPUTER_JWS_MAX_LIFETIME_SECONDS,
    jti: Base64Url.encode(crypto.getRandomValues(new Uint8Array(16))),
  };
});

export const makeComputerRequestClaims = Effect.fn("ScientCloud.makeComputerRequestClaims")(
  function* (input: {
    readonly environmentId: string;
    readonly userId: string;
    readonly audience: string;
    readonly method: string;
    readonly target: string;
    readonly body: Uint8Array;
  }) {
    return {
      ...(yield* baseClaims(input)),
      htm: input.method.toUpperCase(),
      htu: input.target,
      bsha: yield* bodySha256(input.body),
    } satisfies ComputerRequestClaims;
  },
);

export const makeEnrollmentProofClaims = Effect.fn("ScientCloud.makeEnrollmentProofClaims")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly userId: string;
    readonly audience: string;
    readonly nonce: string;
  }) {
    return {
      ...(yield* baseClaims(input)),
      environmentId: input.environmentId,
      nonce: input.nonce,
    } satisfies EnrollmentProofClaims;
  },
);

const signWith = <S extends typeof ComputerRequestClaims | typeof EnrollmentProofClaims>(
  schema: S,
  typ: string,
) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema));
  return Effect.fn("ScientCloud.signComputerJws")(function* (
    privateKey: Jwk.PrivateKey,
    claims: S["Type"],
  ) {
    const payload = yield* encode(claims).pipe(
      Effect.mapError(() => new ComputerJwsError({ reason: "malformed" })),
    );
    const token = yield* Jws.sign(new TextEncoder().encode(payload), privateKey, { typ }).pipe(
      Effect.mapError(() => new ComputerJwsError({ reason: "invalid_key" })),
    );
    return Redacted.value(token);
  });
};

/** Signs like `EnvironmentSigningKey.sign`, for callers holding a parsed key. */
export const signComputerRequest = signWith(ComputerRequestClaims, COMPUTER_REQUEST_TYP);
export const signEnrollmentProof = signWith(EnrollmentProofClaims, COMPUTER_ENROLLMENT_TYP);

/** Unverified `iss`/`sub`, only to find the stored key. Never authorize on it. */
export const readComputerTokenIdentity = Effect.fn("ScientCloud.readComputerTokenIdentity")(
  function* (token: string) {
    const { claims } = yield* Jwt.decodeUnverified(token).pipe(
      Effect.mapError(() => new ComputerJwsError({ reason: "malformed" })),
    );
    const { iss, sub } = claims;
    const prefix = computerIssuer("");
    if (typeof iss !== "string" || !iss.startsWith(prefix) || typeof sub !== "string") {
      return yield* fail("malformed");
    }
    return { environmentId: iss.slice(prefix.length), userId: sub };
  },
);

function failureOf(error: Jwt.JwtError): ComputerJwsFailure {
  if (!JoseError.isJoseError(error)) return "malformed";
  const reason = error.reason;
  switch (reason._tag) {
    case "SignatureVerificationFailed":
    case "AlgorithmNotAllowed":
      return "bad_signature";
    case "InvalidKey":
      return "invalid_key";
    case "ClaimValidationFailed":
      if (reason.reason === "missing" || reason.reason === "invalid") return "malformed";
      switch (reason.claim) {
        case "typ":
          return "wrong_type";
        case "iss":
          return "wrong_issuer";
        case "sub":
          return "wrong_subject";
        case "aud":
          return "wrong_audience";
        default:
          return reason.reason === "expired" || reason.reason === "tooOld"
            ? "expired"
            : "not_yet_valid";
      }
    default:
      return "malformed";
  }
}

const verifyWith = Effect.fn("ScientCloud.verifyComputerJws")(function* <
  S extends typeof ComputerRequestClaims | typeof EnrollmentProofClaims,
>(
  schema: S,
  typ: string,
  input: {
    readonly token: string;
    readonly publicKey: Ed25519PublicJwk | Jwk.PublicKey;
    readonly environmentId: string;
    readonly userId: string;
    readonly audience: string;
  },
) {
  const key =
    "_tag" in input.publicKey
      ? input.publicKey
      : yield* Jwk.importPublic(input.publicKey, "EdDSA").pipe(
          Effect.mapError(() => new ComputerJwsError({ reason: "invalid_key" })),
        );
  if (key.algorithm !== "EdDSA") return yield* fail("invalid_key");
  const verified = yield* Jwt.verify(schema, input.token, key, {
    typ,
    issuer: computerIssuer(input.environmentId),
    subject: input.userId,
    audience: normalizeCloudOrigin(input.audience),
    clockTolerance: CLOCK_TOLERANCE,
    maxTokenAge: `${COMPUTER_JWS_MAX_LIFETIME_SECONDS} seconds`,
    requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti"],
  }).pipe(Effect.mapError((error) => new ComputerJwsError({ reason: failureOf(error) })));
  const claims: S["Type"] = verified.claims;
  if (claims.exp - claims.iat > COMPUTER_JWS_MAX_LIFETIME_SECONDS) {
    return yield* fail("lifetime_too_long");
  }
  return claims;
});

export const verifyComputerRequest = Effect.fn("ScientCloud.verifyComputerRequest")(
  function* (input: {
    readonly token: string;
    readonly publicKey: Ed25519PublicJwk | Jwk.PublicKey;
    readonly environmentId: string;
    readonly userId: string;
    readonly audience: string;
    readonly method: string;
    readonly target: string;
    /** From `bodySha256`, or computed while streaming the body. */
    readonly bodySha256: string;
  }) {
    const claims = yield* verifyWith(ComputerRequestClaims, COMPUTER_REQUEST_TYP, input);
    if (claims.htm !== input.method.toUpperCase()) return yield* fail("method_mismatch");
    if (claims.htu !== input.target) return yield* fail("target_mismatch");
    if (claims.bsha !== input.bodySha256) return yield* fail("body_mismatch");
    return claims;
  },
);

export const verifyEnrollmentProof = Effect.fn("ScientCloud.verifyEnrollmentProof")(
  function* (input: {
    readonly token: string;
    readonly publicKey: Ed25519PublicJwk;
    readonly environmentId: EnvironmentId;
    readonly userId: string;
    readonly audience: string;
    readonly nonce: string;
  }) {
    const claims = yield* verifyWith(EnrollmentProofClaims, COMPUTER_ENROLLMENT_TYP, input);
    if (claims.environmentId !== input.environmentId) return yield* fail("wrong_issuer");
    if (claims.nonce !== input.nonce) return yield* fail("nonce_mismatch");
    return claims;
  },
);
