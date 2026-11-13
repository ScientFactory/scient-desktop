import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Jwk from "effect/jose/Jwk";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { Ed25519PublicJwk } from "./api.ts";
import {
  bodySha256,
  computerJwsCryptoLayer,
  makeComputerRequestClaims,
  makeEnrollmentProofClaims,
  readComputerTokenIdentity,
  signComputerRequest,
  signEnrollmentProof,
  verifyComputerRequest,
  verifyEnrollmentProof,
} from "./computerJws.ts";

const environmentId = EnvironmentId.make("env-a");
const audience = "https://cloud.example.test";
const body = new TextEncoder().encode("snapshot bytes");
const target = "/v1/threads/env-a/thread-1";
const decodePublicJwk = Schema.decodeUnknownEffect(Ed25519PublicJwk);

// Keys made and stored the way `environmentKeys.ts` does (PKCS#8 / SPKI PEM), so the server's
// existing key signs and the enrolled JWK verifies.
const serverKeys = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const pkcs8 = yield* Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
  );
  const spki = yield* Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
  );
  const privateKey = yield* Jwk.importPkcs8(Redacted.make(Redacted.value(pkcs8)), "EdDSA");
  const { jwk } = yield* Jwk.importSpki(spki, "EdDSA");
  const publicKey = yield* decodePublicJwk(jwk);
  return { privateKey, publicKey };
});

const signedRequest = Effect.gen(function* () {
  yield* TestClock.setTime(1_700_000_000_000);
  const keys = yield* serverKeys;
  const claims = yield* makeComputerRequestClaims({
    environmentId,
    userId: "user_1",
    audience: `${audience}/`,
    method: "put",
    target,
    body,
  });
  const token = yield* signComputerRequest(keys.privateKey, claims);
  const verify = (overrides: Partial<Parameters<typeof verifyComputerRequest>[0]> = {}) =>
    Effect.gen(function* () {
      return yield* verifyComputerRequest({
        token,
        publicKey: keys.publicKey,
        environmentId,
        userId: "user_1",
        audience,
        method: "PUT",
        target,
        bodySha256: yield* bodySha256(body),
        ...overrides,
      });
    });
  const reason = (effect: ReturnType<typeof verify>) =>
    Effect.flip(effect).pipe(Effect.map((error) => error.reason));
  return { keys, claims, token, verify, reason };
});

describe("computer request JWS", () => {
  it.effect("round-trips a server-key signature and reads the routing identity", () =>
    Effect.gen(function* () {
      const { claims, token, verify } = yield* signedRequest;
      expect(yield* verify()).toEqual(claims);
      expect(claims.exp - claims.iat).toBe(300);
      expect(yield* readComputerTokenIdentity(token)).toEqual({
        environmentId: "env-a",
        userId: "user_1",
      });
    }).pipe(Effect.provide(computerJwsCryptoLayer)),
  );

  it.effect("rejects a token bound to another request, audience, issuer or user", () =>
    Effect.gen(function* () {
      const { verify, reason } = yield* signedRequest;
      expect(yield* reason(verify({ method: "DELETE" }))).toBe("method_mismatch");
      expect(yield* reason(verify({ target: `${target}/lease` }))).toBe("target_mismatch");
      const otherBody = yield* bodySha256(new TextEncoder().encode("other bytes"));
      expect(yield* reason(verify({ bodySha256: otherBody }))).toBe("body_mismatch");
      expect(yield* reason(verify({ audience: "https://other.example.test" }))).toBe(
        "wrong_audience",
      );
      expect(yield* reason(verify({ environmentId: "env-b" }))).toBe("wrong_issuer");
      expect(yield* reason(verify({ userId: "user_2" }))).toBe("wrong_subject");
    }).pipe(Effect.provide(computerJwsCryptoLayer)),
  );

  it.effect("rejects expiry past the skew allowance, over-long lifetimes and tampering", () =>
    Effect.gen(function* () {
      const { keys, claims, token, verify, reason } = yield* signedRequest;

      const [head, payload, signature] = token.split(".");
      const forged = { ...claims, htu: "/v1/threads/env-a/thread-2" };
      expect(payload).toBe(Base64Url.encode(JSON.stringify(claims)));
      const tampered = `${head}.${Base64Url.encode(JSON.stringify(forged))}.${signature}`;
      expect(yield* reason(verify({ token: tampered }))).toBe("bad_signature");

      const other = yield* serverKeys;
      expect(yield* reason(verify({ publicKey: other.publicKey }))).toBe("bad_signature");

      const longLived = yield* signComputerRequest(keys.privateKey, {
        ...claims,
        exp: claims.iat + 3600,
      });
      expect(yield* reason(verify({ token: longLived }))).toBe("lifetime_too_long");

      // An enrollment proof is never accepted as a request token.
      const proof = yield* makeEnrollmentProofClaims({
        environmentId,
        userId: "user_1",
        audience,
        nonce: "nonce-1",
      }).pipe(Effect.flatMap((proofClaims) => signEnrollmentProof(keys.privateKey, proofClaims)));
      expect(yield* reason(verify({ token: proof }))).toBe("wrong_type");

      yield* TestClock.adjust("359 seconds");
      expect(yield* verify()).toEqual(claims);
      yield* TestClock.adjust("2 seconds");
      expect(yield* reason(verify())).toBe("expired");
    }).pipe(Effect.provide(computerJwsCryptoLayer)),
  );
});

describe("enrollment proof", () => {
  it.effect("verifies for the issued nonce only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      const keys = yield* serverKeys;
      const claims = yield* makeEnrollmentProofClaims({
        environmentId,
        userId: "user_1",
        audience,
        nonce: "nonce-1",
      });
      const token = yield* signEnrollmentProof(keys.privateKey, claims);
      const verify = (nonce: string) =>
        verifyEnrollmentProof({
          token,
          publicKey: keys.publicKey,
          environmentId,
          userId: "user_1",
          audience,
          nonce,
        });
      expect(yield* verify("nonce-1")).toEqual(claims);
      expect((yield* Effect.flip(verify("nonce-2"))).reason).toBe("nonce_mismatch");
    }).pipe(Effect.provide(computerJwsCryptoLayer)),
  );
});
