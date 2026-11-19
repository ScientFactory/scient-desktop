import { describe, expect, it } from "@effect/vitest";
import { THREAD_META_HEADER, decodeThreadMetaHeader } from "@scientfactory/scient-cloud/api";
import {
  bodySha256,
  computerJwsCryptoLayer,
  readComputerAuthorization,
  verifyComputerRequest,
  verifyEnrollmentProof,
} from "@scientfactory/scient-cloud/computer-jws";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { EnvironmentSigningKey } from "../../cloud/environmentKeys.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { CloudApi, layerWithHttpClient } from "./CloudApi.ts";

const ENVIRONMENT = EnvironmentId.make("env-a");
const CLOUD = "https://cloud.scientfactory.com";

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

// The server's key pair in the shapes environmentKeys.ts stores (PKCS#8 and SPKI PEM).
const pemKeys = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const pkcs8 = yield* Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
  );
  const spki = yield* Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
  );
  return { privatePem: Redacted.value(pkcs8), publicPem: spki };
});

const harness = (respond: (seen: Seen) => Response) =>
  Effect.gen(function* () {
    const keys = yield* pemKeys;
    const seen: Seen[] = [];
    const http = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body =
          request.body instanceof HttpBody.Uint8Array ? request.body.body : new Uint8Array();
        const entry = { method: request.method, url, headers: { ...request.headers }, body };
        seen.push(entry);
        return HttpClientResponse.fromWeb(request, respond(entry));
      }),
    );
    const signing = EnvironmentSigningKey.of({
      publicKey: keys.publicPem,
      sign: (input) =>
        signRelayJwt({ ...input, privateKey: keys.privatePem }).pipe(
          Effect.provide(computerJwsCryptoLayer),
        ),
    });
    const environment = ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(ENVIRONMENT),
      getDescriptor: Effect.die("unused"),
    });
    const api = yield* CloudApi.pipe(
      Effect.provide(
        layerWithHttpClient.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Layer.provide(Layer.succeed(EnvironmentSigningKey, signing)),
          Layer.provide(Layer.succeed(ServerEnvironment, environment)),
        ),
      ),
    );
    return { api, seen, publicKey: yield* api.publicJwk };
  }).pipe(Effect.provide(computerJwsCryptoLayer));

describe("CloudApi", () => {
  it.effect("signs requests the cloud's verifier accepts, bound to method, path and body", () =>
    Effect.gen(function* () {
      const { api, seen, publicKey } = yield* harness(
        () => new Response(JSON.stringify({ status: "stored" }), { status: 200 }),
      );
      const gzip = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
      const result = yield* api.putThread({
        userId: "user_1",
        threadId: ThreadId.make("thread/1"),
        meta: {
          title: "Spectra",
          projectKey: "github.com/acme/lab",
          projectLabel: "lab",
          updatedAt: "2026-11-10T10:00:00.000Z",
          archived: false,
          contentDigest: `sha256:${"a".repeat(64)}`,
          generation: 0,
        },
        gzip,
      });
      expect(result.status).toBe("stored");
      const request = seen[0]!;
      expect(request.method).toBe("PUT");
      expect(request.url.pathname).toBe("/v1/threads/env-a/thread%2F1");
      const meta = yield* decodeThreadMetaHeader(request.headers[THREAD_META_HEADER]!);
      expect(meta.title).toBe("Spectra");
      const token = readComputerAuthorization(request.headers["authorization"])!;
      const verify = (overrides: { method?: string; target?: string; body?: Uint8Array }) =>
        Effect.gen(function* () {
          return yield* verifyComputerRequest({
            token,
            publicKey,
            environmentId: ENVIRONMENT,
            userId: "user_1",
            audience: CLOUD,
            method: overrides.method ?? "PUT",
            target: overrides.target ?? `${request.url.pathname}${request.url.search}`,
            bodySha256: yield* bodySha256(overrides.body ?? request.body),
          });
        });
      const claims = yield* verify({});
      expect(claims.iss).toBe("scient-env:env-a");
      expect((yield* Effect.flip(verify({ method: "DELETE" }))).reason).toBe("method_mismatch");
      expect((yield* Effect.flip(verify({ body: new Uint8Array([9]) }))).reason).toBe(
        "body_mismatch",
      );
    }).pipe(Effect.provide(computerJwsCryptoLayer)),
  );

  it.effect("names the conversation that uses a file on blob uploads, inside the signature", () =>
    Effect.gen(function* () {
      const { api, seen, publicKey } = yield* harness(() => new Response(null, { status: 404 }));
      const thread = ThreadId.make("thread-1");
      expect(yield* api.hasBlob("user_1", "a".repeat(64), thread)).toBe(false);
      const request = seen[0]!;
      expect(request.method).toBe("HEAD");
      expect(`${request.url.pathname}${request.url.search}`).toBe(
        `/v1/blobs/${"a".repeat(64)}?env=env-a&thread=thread-1`,
      );
      yield* verifyComputerRequest({
        token: readComputerAuthorization(request.headers["authorization"])!,
        publicKey,
        environmentId: ENVIRONMENT,
        userId: "user_1",
        audience: CLOUD,
        method: "HEAD",
        target: `${request.url.pathname}${request.url.search}`,
        bodySha256: yield* bodySha256(new Uint8Array()),
      });
    }).pipe(Effect.provide(computerJwsCryptoLayer)),
  );

  it.effect("makes an enrollment proof for the nonce with the computer's public key", () =>
    Effect.gen(function* () {
      const { api, publicKey } = yield* harness(() => new Response("{}"));
      const proof = yield* api.enrollmentProof({ userId: "user_1", nonce: "nonce-1" });
      const claims = yield* verifyEnrollmentProof({
        token: proof,
        publicKey,
        environmentId: ENVIRONMENT,
        userId: "user_1",
        audience: CLOUD,
        nonce: "nonce-1",
      });
      expect(claims.environmentId).toBe(ENVIRONMENT);
      expect(publicKey).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    }).pipe(Effect.provide(computerJwsCryptoLayer)),
  );

  it.effect("maps the cloud's error body, including the computer a thread moved to", () =>
    Effect.gen(function* () {
      const { api } = yield* harness(
        () =>
          new Response(
            JSON.stringify({ error: "lease_lost", message: "moved", movedTo: "env-b" }),
            { status: 409 },
          ),
      );
      const error = yield* Effect.flip(api.deleteThread("user_1", ThreadId.make("t")));
      expect(error.code).toBe("lease_lost");
      expect(error.movedTo).toBe("env-b");
    }),
  );
});
