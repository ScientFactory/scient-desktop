/**
 * Development only: the dev identity home's server owns each connector sign-in it holds and lends
 * its access token to dev apps on this machine, so no grant (and its rotating refresh token) is
 * ever copied. Mounted only in the registered home; used only where its copy wrote a binding.
 */
// @effect-diagnostics nodeBuiltinImport:off -- Constant-time comparison and the home's default path.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off -- Loopback requests that never take an HTTP proxy.
import * as NodeHttp from "node:http";
// @effect-diagnostics nodeBuiltinImport:off -- Constant-time comparison and the home's default path.
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off -- Constant-time comparison and the home's default path.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  isLoopbackIpAddress,
  loopbackBindAddress,
  readRemoteAddressFromSource,
} from "../../../auth/utils.ts";
import * as ServerConfig from "../../../config.ts";
import { loopbackUrlHostForAddress } from "../../../startupAccess.ts";
import { ConnectorRuntime } from "../ExtensionsServices.ts";
import {
  isDevIdentityHome,
  readDevConnectorBinding,
  readLeaseEndpoint,
  removeLeaseEndpoint,
  writeLeaseEndpoint,
} from "./DevConnectorLeaseFiles.ts";

const LEASE_PATH = "/dev-identity/connector-lease";
const LEASE_TIMEOUT_MS = 10_000;
const MAX_LEASE_REQUEST_BYTES = 4_096;

export const DevConnectorLeaseRequest = Schema.Struct({
  connectorId: Schema.String.check(Schema.isMaxLength(128)),
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  /** SHA-256 of the token the service refused; the home refreshes only if it is still current. */
  staleTokenHash: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type DevConnectorLeaseRequest = typeof DevConnectorLeaseRequest.Type;

export const DevConnectorLease = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    accessToken: Schema.String,
    /** The sign-in the token belongs to; a new one at the home is another account. */
    grantId: Schema.String.check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({ status: Schema.Literals(["needs-sign-in", "unavailable"]) }),
]);
export type DevConnectorLease = typeof DevConnectorLease.Type;

const decodeLease = Schema.decodeUnknownOption(DevConnectorLease);
const decodeLeaseRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(DevConnectorLeaseRequest),
);

type BrokerLease = DevConnectorLease | { readonly status: "home-closed" };

/** A dev app's borrowed sign-ins, read once at startup; undefined everywhere else. */
export interface DevConnectorBroker {
  readonly binds: (connectorId: string, url: string) => boolean;
  readonly lease: (request: DevConnectorLeaseRequest) => Effect.Effect<BrokerLease>;
}

export const loadDevConnectorBroker = (stateDir: string): DevConnectorBroker | undefined => {
  const binding = readDevConnectorBinding(stateDir);
  if (binding === undefined) return undefined;
  return {
    binds: (connectorId, url) => binding.connectors[connectorId]?.url === url,
    lease: (request) =>
      Effect.promise((signal) => requestLease(binding.homeStateDir, request, signal)),
  };
};

const NONCE_HEADER = "x-scient-lease-nonce";
const PROOF_HEADER = "x-scient-lease-proof";
const MAX_LEASE_RESPONSE_BYTES = 64 * 1024;

/**
 * The endpoint token never crosses the wire: a request carries a MAC of its nonce, the answer a
 * MAC of nonce and body under another label, so a listener on a stale port learns neither key.
 */
const requestMac = (token: string, nonce: string) =>
  NodeCrypto.createHmac("sha256", token)
    .update(`scient-lease-request\n${nonce}`)
    .digest("base64url");
const leaseProof = (token: string, nonce: string, body: string) =>
  NodeCrypto.createHmac("sha256", token)
    .update(`scient-lease-response\n${nonce}\n${body}`)
    .digest("base64url");

/**
 * One lease request to the home's server, straight over loopback (never through a proxy); any
 * failure, or an answer without the home's proof, reads as the home being closed.
 */
function requestLease(
  homeStateDir: string,
  request: DevConnectorLeaseRequest,
  signal: AbortSignal,
): Promise<BrokerLease> {
  // Read per request: the home writes a new one, with a new token, each time it starts.
  const endpoint = readLeaseEndpoint(homeStateDir);
  if (endpoint === undefined) return Promise.resolve({ status: "home-closed" });
  const nonce = NodeCrypto.randomBytes(24).toString("base64url");
  const payload = JSON.stringify(request);
  return new Promise<BrokerLease>((resolve) => {
    const closed = () => resolve({ status: "home-closed" });
    const call = NodeHttp.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: LEASE_PATH,
        method: "POST",
        agent: false,
        timeout: LEASE_TIMEOUT_MS,
        signal: AbortSignal.any([signal, AbortSignal.timeout(LEASE_TIMEOUT_MS)]),
        headers: {
          authorization: `Bearer ${requestMac(endpoint.token, nonce)}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          [NONCE_HEADER]: nonce,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_LEASE_RESPONSE_BYTES) response.destroy();
          else chunks.push(chunk);
        });
        response.on("error", closed);
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const proof = response.headers[PROOF_HEADER];
          if (
            response.statusCode !== 200 ||
            typeof proof !== "string" ||
            !sameSecret(proof, leaseProof(endpoint.token, nonce, body))
          ) {
            return closed();
          }
          resolve(
            Option.getOrElse(
              Option.flatMap(decodeJsonOption(body), decodeLease),
              (): DevConnectorLease => ({ status: "unavailable" }),
            ),
          );
        });
      },
    );
    call.on("timeout", () => call.destroy());
    call.on("error", closed);
    call.end(payload);
  });
}

const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const leaseBody = (lease: DevConnectorLease) => JSON.stringify(lease);

const sameSecret = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

class LeaseRequestTooLarge {
  readonly _tag = "LeaseRequestTooLarge";
}

const readBoundedText = Effect.fn("DevConnectorLease.readBoundedText")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  yield* request.stream.pipe(
    Stream.runForEach((chunk) => {
      total += chunk.byteLength;
      if (total > MAX_LEASE_REQUEST_BYTES) return Effect.fail(new LeaseRequestTooLarge());
      chunks.push(chunk);
      return Effect.void;
    }),
  );
  return Buffer.concat(chunks).toString("utf8");
});

const refuse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: { "cache-control": "no-store" } });

/** The home's lease route and its owner-only endpoint file, when `stateDir` is that home. */
export const makeLayer = (homeStateDir: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      if (!isDevIdentityHome(config.stateDir, homeStateDir)) return Layer.empty;
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const peer = readRemoteAddressFromSource(request.source);
        const authorization = request.headers.authorization ?? "";
        const nonce = request.headers[NONCE_HEADER];
        if (
          peer === undefined ||
          !isLoopbackIpAddress(peer) ||
          nonce === undefined ||
          nonce.length < 16 ||
          nonce.length > 64 ||
          !authorization.startsWith("Bearer ") ||
          !sameSecret(authorization.slice("Bearer ".length), requestMac(token, nonce))
        ) {
          return refuse(403, "forbidden");
        }
        const text = yield* readBoundedText(request).pipe(Effect.option);
        const input = Option.flatMap(text, decodeLeaseRequest);
        if (Option.isNone(input)) return refuse(400, "bad_request");
        const runtime = yield* ConnectorRuntime;
        const lease =
          runtime.leaseForDevApp === undefined
            ? ({ status: "unavailable" } satisfies DevConnectorLease)
            : yield* runtime.leaseForDevApp(input.value);
        const body = leaseBody(lease);
        return HttpServerResponse.text(body, {
          contentType: "application/json",
          headers: { "cache-control": "no-store", [PROOF_HEADER]: leaseProof(token, nonce, body) },
        });
      });
      const publishEndpoint = Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.gen(function* () {
            // Where the server really listens, when it can say.
            const server = yield* Effect.serviceOption(HttpServer.HttpServer);
            const address = Option.isSome(server) ? server.value.address : undefined;
            const bound =
              address !== undefined && typeof address !== "string" && "port" in address
                ? address
                : undefined;
            const host =
              bound !== undefined
                ? loopbackUrlHostForAddress(bound).replace(/^\[(.*)\]$/u, "$1")
                : (loopbackBindAddress(config.host) ?? "127.0.0.1");
            writeLeaseEndpoint(config.stateDir, { host, port: bound?.port ?? config.port, token });
          }),
          () => Effect.sync(() => removeLeaseEndpoint(config.stateDir)),
        ),
      );
      return Layer.merge(HttpRouter.add("POST", LEASE_PATH, handler), publishEndpoint);
    }),
  );

/** The registered home: `~/.scient-next/dev-identity/scient-next-dev` (scripts/dev-identity.mjs). */
export const layer = makeLayer(
  NodePath.join(NodeOS.homedir(), ".scient-next", "dev-identity", "scient-next-dev"),
);
