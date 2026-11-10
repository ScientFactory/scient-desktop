import { Ed25519PublicJwk, cloudPaths } from "@scientfactory/scient-cloud/api";
import {
  computerAuthorizationHeader,
  makeComputerRequestClaims,
  makeEnrollmentProofClaims,
  signComputerRequest,
  signEnrollmentProof,
} from "@scientfactory/scient-cloud/computer-jws";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Schema from "effect/Schema";

import { handle } from "./Api.ts";

export const ORIGIN = "http://localhost:8787";

export interface Computer {
  readonly environmentId: EnvironmentId;
  readonly userId: string;
  readonly privateKey: Jwk.PrivateKey;
  readonly publicKey: Ed25519PublicJwk;
}

export interface CallOptions {
  /** Test sign-in token (see `Local.layer` `people`). */
  readonly person?: string;
  readonly computer?: Computer;
  readonly body?: Uint8Array | string | object;
  readonly headers?: Record<string, string>;
  /** Signs the computer token for this target instead (to test binding). */
  readonly signedTarget?: string;
}

const encodeBody = (body: CallOptions["body"]) =>
  body === undefined
    ? new Uint8Array(0)
    : body instanceof Uint8Array
      ? body
      : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));

export const signedHeaders = Effect.fn("Testing.signedHeaders")(function* (
  computer: Computer,
  method: string,
  target: string,
  body: Uint8Array,
) {
  const claims = yield* makeComputerRequestClaims({
    environmentId: computer.environmentId,
    userId: computer.userId,
    audience: ORIGIN,
    method,
    target,
    body,
  });
  return {
    authorization: computerAuthorizationHeader(
      yield* signComputerRequest(computer.privateKey, claims),
    ),
  };
});

export const call = Effect.fn("Testing.call")(function* (
  method: string,
  path: string,
  options: CallOptions = {},
) {
  const body = encodeBody(options.body);
  const headers: Record<string, string> = { ...options.headers };
  if (options.person !== undefined) headers.authorization = `Bearer ${options.person}`;
  if (options.computer !== undefined) {
    Object.assign(
      headers,
      yield* signedHeaders(options.computer, method, options.signedTarget ?? path, body),
    );
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(hasBody ? { body: Uint8Array.from(body) } : {}),
  });
  return yield* handle(request);
});

export const readJson = (response: Response) =>
  Effect.promise(() => response.json() as Promise<Record<string, unknown>>);

export const readBytes = (response: Response) =>
  Effect.promise(async () => new Uint8Array(await response.arrayBuffer()));

const decodePublicJwk = Schema.decodeUnknownEffect(Ed25519PublicJwk);

export const newComputer = Effect.fn("Testing.newComputer")(function* (
  environmentId: string,
  userId: string,
) {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const privateKey = yield* Jwk.importPrivate(pair.privateKey, "EdDSA");
  const { kty, crv, x } = pair.publicKey as unknown as Record<string, unknown>;
  const publicKey = yield* decodePublicJwk({ kty, crv, x });
  return {
    environmentId: EnvironmentId.make(environmentId),
    userId,
    privateKey,
    publicKey,
  } satisfies Computer;
});

/** Enrolls `computer` for the person signed in with `person`. */
export const enroll = Effect.fn("Testing.enroll")(function* (person: string, computer: Computer) {
  const nonceResponse = yield* call("POST", cloudPaths.computerNonce(), { person });
  const { nonce } = (yield* readJson(nonceResponse)) as { nonce: string };
  const claims = yield* makeEnrollmentProofClaims({
    environmentId: computer.environmentId,
    userId: computer.userId,
    audience: ORIGIN,
    nonce,
  });
  const proof = yield* signEnrollmentProof(computer.privateKey, claims);
  return yield* call("POST", cloudPaths.computers(), {
    person,
    body: {
      environmentId: computer.environmentId,
      label: `Computer ${computer.environmentId}`,
      publicKey: computer.publicKey,
      proof,
    },
  });
});
