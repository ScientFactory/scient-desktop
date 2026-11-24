// @effect-diagnostics nodeBuiltinImport:off
import { initializeScientProject } from "@scientfactory/project-init";
import { importScientSource } from "@scientfactory/scient-sources/store";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { VcsExecutableUnavailableError, VcsProcessSpawnError } from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import {
  AuthStandardClientScopes,
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  MessageId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertInclude } from "@effect/vitest/utils";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { HttpBody, HttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import { resolveAvailableEditorsForConfig, resolveFileManagerRevealKindForConfig } from "./ws.ts";
import {
  NodeHttpServerTest,
  NodeHttpServerTestWithWsDeflate,
  appendSessionCookieToWsUrl,
  assertBrowserApiCorsPreflightHeaders,
  assertBrowserApiCorsResponseHeaders,
  bootstrapBrowserSession,
  buildAppUnderTest,
  crossOriginClientOrigin,
  defaultDesktopBootstrapToken,
  defaultModelSelection,
  exchangeAccessToken,
  extractSessionTokenFromSetCookie,
  fetchEffect,
  getAuthenticatedBearerSessionToken,
  getAuthenticatedSessionCookieHeader,
  getHttpServerUrl,
  getPairedClientCredential,
  getWsServerUrl,
  jsonRequestBody,
  makeCloudEnvironmentHealthRequest,
  nativeAdmissionInstance,
  parseSessionCookieFromWsUrl,
  readAuthAccessSnapshot,
  responseJsonEffect,
  testEnvironmentDescriptor,
  withWsRpcClient,
} from "./server.testkit.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "server router seam: access",
  (it) => {
    it.effect("rejects cloud health requests without the exact status scope", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://relay.example.test/",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const now = yield* DateTime.now;
        const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
        const response = yield* fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(
            makeCloudEnvironmentHealthRequest({
              privateKey: cloudKeyPair.privateKey,
              environmentId: testEnvironmentDescriptor.environmentId,
              jti: "cloud-health-jti-duplicate-scope",
              nonce: "cloud-health-nonce-duplicate-scope",
              issuedAt: DateTime.formatIso(now),
              expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
              scope: ["environment:status", "environment:status"],
            }),
          ),
        });

        assert.equal(response.status, 401);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "rejects absent, old, newer and invalid WebSocket protocols before authentication or RPC",
      () =>
        Effect.gen(function* () {
          const app = yield* buildAppUnderTest();
          // Observe the exact memoized live auth service; the spy delegates rather
          // than replacing the production authentication decision.
          const authenticate = vi.spyOn(app.auth, "authenticateWebSocketUpgrade");
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              authenticate.mockRestore();
            }),
          );
          for (const [label, protocol] of [
            ["absent", null],
            ["old", String(ORCHESTRATION_PROTOCOL_VERSION - 1)],
            ["newer", String(ORCHESTRATION_PROTOCOL_VERSION + 1)],
            ["invalid", "not-a-protocol"],
          ] as const) {
            const url = new URL(yield* getHttpServerUrl("/ws"));
            if (protocol !== null)
              url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, protocol);
            const response = yield* fetchEffect(url.toString(), {
              headers: {
                authorization: "Bearer synthetic-invalid-protocol-credential",
                [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
              },
            });
            const body = yield* response.json;
            assert.equal(response.status, 426, label);
            assert.deepEqual(
              body,
              {
                code: "orchestration_protocol_incompatible",
                message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
                orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              },
              label,
            );
            assert.equal(authenticate.mock.calls.length, 0, label);
            assert.equal(yield* app.v2.eventSink.latestSequence(), 0, label);
          }
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("preserves authentication and real RPC for the current WebSocket protocol", () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest();
        const authenticate = vi.spyOn(app.auth, "authenticateWebSocketUpgrade");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            authenticate.mockRestore();
          }),
        );
        const url = new URL(yield* getHttpServerUrl("/ws"));
        url.searchParams.set(
          ORCHESTRATION_PROTOCOL_QUERY_PARAM,
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        );
        const response = yield* fetchEffect(url.toString());
        const body = yield* responseJsonEffect<{
          readonly _tag: string;
          readonly code: string;
          readonly reason: string;
          readonly traceId: string;
        }>(response);
        assert.equal(response.status, 401);
        assert.equal(body._tag, "EnvironmentAuthInvalidError");
        assert.equal(body.code, "auth_invalid");
        assert.equal(body.reason, "missing_credential");
        assert.isString(body.traceId);
        assert.equal(authenticate.mock.calls.length, 1);

        const config = yield* Effect.scoped(
          withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            client[WS_METHODS.serverGetConfig]({}),
          ),
        );
        assert.equal(config.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(config.auth.policy, "desktop-managed-local");
        assert.equal(authenticate.mock.calls.length, 2);
        assert.equal(yield* app.v2.eventSink.latestSequence(), 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("negotiates permessage-deflate with clients that offer it", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { cookie, url } = parseSessionCookieFromWsUrl(
          yield* getWsServerUrl("/ws", { credential: yield* getPairedClientCredential }),
        );
        const openSocket = (perMessageDeflate: boolean) =>
          Effect.acquireRelease(
            Effect.callback<NodeWS.WebSocket, Error>((resume) => {
              const socket = new NodeWS.WebSocket(url, {
                perMessageDeflate,
                ...(cookie ? { headers: { cookie } } : {}),
              });
              socket.on("open", () => resume(Effect.succeed(socket)));
              socket.on("error", (error) => resume(Effect.fail(error)));
            }),
            (socket) => Effect.sync(() => socket.close()),
          );

        const compressed = yield* openSocket(true);
        // The ws client records the negotiated extension only when the server's
        // 101 response accepted the offer.
        assert.include(compressed.extensions, "permessage-deflate");

        const plain = yield* openSocket(false);
        assert.notInclude(plain.extensions, "permessage-deflate");
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServerTestWithWsDeflate)),
    );

    it.effect("does not allow management-only access tokens to operate the environment", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { response: exchangeResponse, body: tokenBody } = yield* exchangeAccessToken(
          defaultDesktopBootstrapToken,
          { scope: "access:write" },
        );
        assert.equal(exchangeResponse.status, 200);
        assert.equal(tokenBody.scope, "access:write");
        assert.isDefined(tokenBody.access_token);

        const overbroadPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          },
          body: yield* HttpBody.json({}),
        });
        const overbroadPairingBody = (yield* overbroadPairingResponse.json) as {
          readonly requiredScope: string;
        };
        const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          },
          body: yield* HttpBody.json({ scopes: ["access:write"] }),
        });
        const wsTicketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
          headers: {
            authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          },
        });
        const wsTicketBody = (yield* wsTicketResponse.json) as { readonly ticket: string };
        assert.equal(overbroadPairingResponse.status, 403);
        assert.equal(overbroadPairingBody.requiredScope, "orchestration:read");
        assert.equal(pairingResponse.status, 200);
        assert.equal(wsTicketResponse.status, 200);
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;
        const rpcError = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        );
        assert.equal(rpcError._tag, "EnvironmentAuthorizationError");
        if (rpcError._tag === "EnvironmentAuthorizationError") {
          assert.equal(rpcError.requiredScope, "orchestration:read");
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("includes CORS headers on remote auth success responses", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const origin = crossOriginClientOrigin;
        const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken(
          defaultDesktopBootstrapToken,
          {
            headers: { origin },
          },
        );

        assert.equal(tokenResponse.status, 200);
        assertBrowserApiCorsResponseHeaders(tokenResponse.headers);
        assert.equal(tokenBody.token_type, "Bearer");
        assert.equal(typeof tokenBody.access_token, "string");

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const sessionResponse = yield* fetchEffect(sessionUrl, {
          headers: {
            authorization: `Bearer ${tokenBody.access_token ?? ""}`,
            origin,
          },
        });
        const sessionBody = yield* responseJsonEffect<{
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
        }>(sessionResponse);

        assert.equal(sessionResponse.status, 200);
        assertBrowserApiCorsResponseHeaders(sessionResponse.headers);
        assert.equal(sessionBody.authenticated, true);
        assert.equal(sessionBody.sessionMethod, "bearer-access-token");

        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenBody.access_token ?? ""}`,
            origin,
          },
        });
        const wsTicketBody = yield* responseJsonEffect<{
          readonly ticket: string;
        }>(wsTicketResponse);

        assert.equal(wsTicketResponse.status, 200);
        assertBrowserApiCorsResponseHeaders(wsTicketResponse.headers);
        assert.equal(typeof wsTicketBody.ticket, "string");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "responds to remote auth websocket-ticket preflight requests with authorization CORS headers",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest();

          const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
          const response = yield* fetchEffect(wsTicketUrl, {
            method: "OPTIONS",
            headers: {
              origin: crossOriginClientOrigin,
              "access-control-request-method": "POST",
              "access-control-request-headers": "authorization",
            },
          });

          assert.equal(response.status, 204);
          assertBrowserApiCorsPreflightHeaders(response.headers);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("allows credentialed cloud link proof preflights from the configured dev UI", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: { devUrl: new URL(crossOriginClientOrigin) },
        });

        const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
        const response = yield* fetchEffect(linkProofUrl, {
          method: "OPTIONS",
          headers: {
            origin: crossOriginClientOrigin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers, {
          origin: crossOriginClientOrigin,
          credentials: true,
        });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("allows configured development origins through ServerConfig", () =>
      Effect.gen(function* () {
        const tailnetOrigin = "https://host.example.ts.net";
        yield* buildAppUnderTest({
          config: {
            devUrl: new URL(crossOriginClientOrigin),
            devAllowedOrigins: [tailnetOrigin],
          },
        });

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const response = yield* fetchEffect(sessionUrl, {
          method: "OPTIONS",
          headers: {
            origin: tailnetOrigin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "content-type",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers, {
          origin: tailnetOrigin,
          credentials: true,
        });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("allows credentialed preflights from both desktop origins in development", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: { devUrl: new URL(crossOriginClientOrigin) },
        });

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        for (const desktopOrigin of ["scient://app", "scient-next-dev://app"]) {
          const response = yield* fetchEffect(sessionUrl, {
            method: "OPTIONS",
            headers: {
              origin: desktopOrigin,
              "access-control-request-method": "GET",
              "access-control-request-headers": "content-type",
            },
          });

          assert.equal(response.status, 204, desktopOrigin);
          assertBrowserApiCorsPreflightHeaders(response.headers, {
            origin: desktopOrigin,
            credentials: true,
          });
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("includes CORS headers on remote websocket-ticket auth failures", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const response = yield* fetchEffect(wsTicketUrl, {
          method: "POST",
          headers: {
            origin: crossOriginClientOrigin,
          },
        });
        const body = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly code?: string;
          readonly reason?: string;
          readonly traceId?: string;
        }>(response);

        assert.equal(response.status, 401);
        assertBrowserApiCorsResponseHeaders(response.headers);
        assert.equal(body._tag, "EnvironmentAuthInvalidError");
        assert.equal(body.code, "auth_invalid");
        assert.equal(body.reason, "missing_credential");
        assert.equal(typeof body.traceId, "string");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("issues authenticated one-time pairing credentials for additional clients", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const response = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
          body: yield* HttpBody.json({}),
        });
        const body = (yield* response.json) as {
          readonly credential: string;
          readonly expiresAt: string;
        };

        assert.equal(response.status, 200);
        assert.equal(typeof body.credential, "string");
        assert.isTrue(body.credential.length > 0);
        assert.equal(typeof body.expiresAt, "string");

        const bootstrapResult = yield* bootstrapBrowserSession(body.credential);
        assert.equal(bootstrapResult.response.status, 200);

        const reusedResult = yield* bootstrapBrowserSession(body.credential);
        assert.equal(reusedResult.response.status, 401);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("issues pairing credentials for bearer sessions with access management scope", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const bearerToken = yield* getAuthenticatedBearerSessionToken();
        const response = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
          body: yield* HttpBody.json({ label: "Hosted web" }),
        });
        const body = (yield* response.json) as {
          readonly credential: string;
          readonly label?: string;
        };

        assert.equal(response.status, 200);
        assert.isTrue(body.credential.length > 0);
        assert.equal(body.label, "Hosted web");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects pairing credentials with an empty scope grant", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const response = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
          body: yield* HttpBody.json({ scopes: [] }),
        });
        const body = (yield* response.json) as {
          readonly code: string;
          readonly reason: string;
        };

        assert.equal(response.status, 400);
        assert.equal(body.code, "invalid_request");
        assert.equal(body.reason, "invalid_scope");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects unauthenticated pairing credential requests", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const response = yield* HttpClient.post("/api/auth/pairing-token", {
          body: yield* HttpBody.json({}),
        });
        assert.equal(response.status, 401);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "shows access-read sessions pairing grants without letting them issue or reuse credentials",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest();
          const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
            scope: "access:read",
          });
          assert.equal(reader.response.status, 200);
          assert.equal(reader.body.scope, "access:read");
          const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
            headers: { cookie: yield* getAuthenticatedSessionCookieHeader() },
            body: yield* HttpBody.json({ label: "Synthetic phone" }),
          });
          const created = (yield* createdResponse.json) as { id: string; credential: string };
          assert.equal(createdResponse.status, 200);
          const { pairingLinks: links } = yield* readAuthAccessSnapshot({
            bearer: reader.body.access_token ?? "",
          });
          const listed = links.find((link) => link.id === created.id);
          assert.isDefined(listed);
          assert.deepInclude(listed, {
            label: "Synthetic phone",
            // Frozen legacy scope metadata and the full granular grant are distinct.
            scopes: [
              "orchestration:read",
              "orchestration:operate",
              "terminal:operate",
              "relay:read",
              "access:read",
              "access:write",
              "relay:write",
            ],
            permissions: [...AuthStandardClientScopes],
          });

          const unauthorizedCreate = yield* HttpClient.post("/api/auth/pairing-token", {
            headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
            body: yield* HttpBody.json({}),
          });
          assert.equal(unauthorizedCreate.status, 403);
          const idExchange = yield* exchangeAccessToken(created.id, { scope: "terminal:operate" });
          assert.equal(idExchange.response.status, 401);
          const authorized = yield* exchangeAccessToken(created.credential, {
            scope: AuthStandardClientScopes.join(" "),
          });
          assert.equal(authorized.response.status, 200);
          assert.equal(authorized.body.scope, AuthStandardClientScopes.join(" "));
          const reused = yield* exchangeAccessToken(created.credential, {
            scope: "terminal:operate",
          });
          assert.equal(reused.response.status, 401);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("returns only pairing metadata in access-read WebSocket snapshots and updates", () =>
      Effect.gen(function* () {
        const changesSubscribed = yield* Deferred.make<void>();
        yield* buildAppUnderTest({
          onPairingChangesSubscribed: Deferred.succeed(changesSubscribed, undefined).pipe(
            Effect.asVoid,
          ),
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const createLink = Effect.gen(function* () {
          const response = yield* HttpClient.post("/api/auth/pairing-token", {
            headers: { cookie: ownerCookie },
            body: yield* HttpBody.json({}),
          });
          assert.equal(response.status, 200);
          return (yield* response.json) as { id: string; credential: string };
        });
        const initialLink = yield* createLink;
        const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "access:read",
        });
        assert.equal(reader.body.scope, "access:read");
        const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
          headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
        });
        assert.equal(ticketResponse.status, 200);
        const { ticket } = (yield* ticketResponse.json) as { ticket: string };
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(ticket)}`;
        const frames: string[] = [];
        yield* withWsRpcClient(
          wsUrl,
          (client) =>
            Effect.gen(function* () {
              const snapshotReceived = yield* Deferred.make<void>();
              const eventsFiber = yield* client.subscribeAuthAccess({}).pipe(
                Stream.tap((event) =>
                  event.type === "snapshot"
                    ? Deferred.succeed(snapshotReceived, undefined)
                    : Effect.void,
                ),
                Stream.takeUntil((event) => event.type === "pairingLinkUpserted"),
                Stream.runCollect,
                Effect.forkChild,
              );
              yield* Deferred.await(snapshotReceived);
              yield* Deferred.await(changesSubscribed);
              const liveLink = yield* createLink;
              const events = yield* Fiber.join(eventsFiber);
              const snapshot = events.find((event) => event.type === "snapshot");
              const update = events.find((event) => event.type === "pairingLinkUpserted");
              assert.isDefined(snapshot);
              assert.isDefined(update);
              assert.isTrue(
                snapshot?.payload.pairingLinks.some((link) => link.id === initialLink.id),
              );
              assert.equal(update?.payload.id, liveLink.id);
              // Inspect the wire frames so client schema decoding cannot hide a leak.
              assert.notInclude(frames.join(""), '"credential"');
              assert.notInclude(frames.join(""), initialLink.credential);
              assert.notInclude(frames.join(""), liveLink.credential);
              const paired = yield* exchangeAccessToken(liveLink.credential, {
                scope: AuthStandardClientScopes.join(" "),
              });
              assert.equal(paired.response.status, 200);
            }),
          (frame) => frames.push(frame),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServerTest)),
    );

    it.effect("lists and revokes pairing links for access management sessions", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: {
            host: "0.0.0.0",
          },
        });

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({}),
        });
        const createdBody = (yield* createdResponse.json) as {
          readonly id: string;
          readonly credential: string;
        };

        const { pairingLinks: listedLinks } = yield* readAuthAccessSnapshot({
          cookie: ownerCookie,
        });

        const revokeResponse = yield* HttpClient.post("/api/auth/pairing-links/revoke", {
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: HttpBody.text(jsonRequestBody({ id: createdBody.id }), "application/json"),
        });
        const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential);

        assert.equal(createdResponse.status, 200);
        assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id));
        assert.equal(revokeResponse.status, 200);
        assert.equal(revokedBootstrap.response.status, 401);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects pairing credential requests without access management scope", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: {
            host: "0.0.0.0",
          },
        });

        // The default grant includes access management; a narrower link must not.
        const ownerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
          body: yield* HttpBody.json({
            scopes: AuthStandardClientScopes.filter((scope) => scope !== "access:write"),
          }),
        });
        const ownerBody = (yield* ownerResponse.json) as {
          readonly credential: string;
        };
        assert.equal(ownerResponse.status, 200);

        const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
          ownerBody.credential,
        );
        const pairedResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: pairedSessionCookie,
          },
          body: yield* HttpBody.json({}),
        });
        const pairedBody = (yield* pairedResponse.json) as {
          readonly _tag: string;
          readonly code: string;
          readonly requiredScope: string;
          readonly traceId: string;
        };

        assert.equal(pairedResponse.status, 403);
        assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
        assert.equal(pairedBody.code, "insufficient_scope");
        assert.equal(pairedBody.requiredScope, "access:write");
        assert.equal(typeof pairedBody.traceId, "string");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "lists paired clients and revokes other sessions while keeping the administrator",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest({
            config: {
              host: "0.0.0.0",
            },
          });

          const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
          const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
          const ownerPairingResponse = yield* fetchEffect(pairingTokenUrl, {
            method: "POST",
            headers: {
              cookie: ownerCookie,
              "content-type": "application/json",
            },
            body: jsonRequestBody({
              label: "Julius iPhone",
            }),
          });
          const ownerPairingBody = yield* responseJsonEffect<{
            readonly credential: string;
            readonly label?: string;
          }>(ownerPairingResponse);
          assert.equal(ownerPairingResponse.status, 200);
          const pairedSessionBootstrap = yield* bootstrapBrowserSession(
            ownerPairingBody.credential,
            {
              headers: {
                "user-agent":
                  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
              },
            },
          );
          const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(";")[0];
          assert.isDefined(pairedSessionCookie);

          const pairedSessionCookieHeader = pairedSessionCookie ?? "";
          const { clientSessions: clientsBefore } = yield* readAuthAccessSnapshot({
            cookie: ownerCookie,
          });
          const pairedClientBefore = clientsBefore.find((entry) => !entry.current);
          const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId;

          const revokeOthersResponse = yield* HttpClient.post("/api/auth/clients/revoke-others", {
            headers: {
              cookie: ownerCookie,
            },
          });
          const revokeOthersBody = (yield* revokeOthersResponse.json) as {
            readonly revokedCount: number;
          };

          const { clientSessions: clientsAfter } = yield* readAuthAccessSnapshot({
            cookie: ownerCookie,
          });

          const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
            headers: {
              cookie: pairedSessionCookieHeader,
            },
            body: yield* HttpBody.json({}),
          });
          const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
            readonly _tag: string;
            readonly code: string;
            readonly reason: string;
            readonly traceId: string;
          };

          assert.equal(ownerPairingBody.label, "Julius iPhone");
          assert.lengthOf(clientsBefore, 2);
          assert.isDefined(pairedSessionId);
          assert.isDefined(pairedClientBefore);
          assert.deepInclude(pairedClientBefore?.client, {
            label: "Julius iPhone",
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
            ipAddress: "127.0.0.1",
          });
          assert.equal(revokeOthersResponse.status, 200);
          assert.equal(revokeOthersBody.revokedCount, 1);
          assert.lengthOf(clientsAfter, 1);
          assert.equal(clientsAfter[0]?.current, true);
          assert.equal(pairedClientPairingResponse.status, 401);
          assert.equal(pairedClientPairingBody._tag, "EnvironmentAuthInvalidError");
          assert.equal(pairedClientPairingBody.code, "auth_invalid");
          assert.equal(pairedClientPairingBody.reason, "invalid_credential");
          assert.equal(typeof pairedClientPairingBody.traceId, "string");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("separates access inventory reads from credential management writes", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: {
            host: "0.0.0.0",
          },
        });

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const issueScopedSession = Effect.fnUntraced(function* (
          scope: "access:read" | "access:write",
        ) {
          const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
            headers: {
              cookie: ownerCookie,
            },
            body: yield* HttpBody.json({ scopes: [scope] }),
          });
          assert.equal(pairingResponse.status, 200);
          const pairingBody = (yield* pairingResponse.json) as {
            readonly credential: string;
          };
          return yield* getAuthenticatedSessionCookieHeader(pairingBody.credential);
        });

        const readCookie = yield* issueScopedSession("access:read");
        const readInventory = yield* readAuthAccessSnapshot({ cookie: readCookie });
        const readWriteResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: readCookie,
          },
          body: yield* HttpBody.json({}),
        });
        const readWriteBody = (yield* readWriteResponse.json) as {
          readonly requiredScope: string;
        };

        const writeCookie = yield* issueScopedSession("access:write");
        const writeListError = yield* Effect.flip(readAuthAccessSnapshot({ cookie: writeCookie }));

        assert.isAbove(readInventory.clientSessions.length, 0);
        assert.equal(readWriteResponse.status, 403);
        assert.equal(readWriteBody.requiredScope, "access:write");
        assert.equal(writeListError._tag, "EnvironmentAuthorizationError");
        if (writeListError._tag === "EnvironmentAuthorizationError") {
          assert.equal(writeListError.requiredScope, "access:read");
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // SCIENT-FORK:START — Library mutations recheck the operate grant at the server.
    it.effect("rejects adding sources by identifier from a read-only session", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "orchestration:read",
        });
        assert.equal(reader.response.status, 200);
        const response = yield* HttpClient.post("/api/scient/sources/identifiers/add", {
          headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
          body: yield* HttpBody.json({ root: "/synthetic/project", entries: ["10.1000/abc.123"] }),
        });
        assert.deepInclude(yield* response.json, {
          code: "insufficient_scope",
          requiredScope: "orchestration:operate",
        });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("answers a library-mode Sources route through the server's own layers", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({ scientSourcesBackend: "library" });
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-move-status-" });
        yield* fileSystem.makeDirectory(`${root}/.scient/sources/records`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/.scient/sources/records/v1.json`, "{}\n");
        const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "orchestration:read",
        });
        const response = yield* HttpClient.post("/api/scient/sources/move/status", {
          headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
          body: yield* HttpBody.json({ root }),
        });
        // A project server answers nothing-to-move; the library reads the server's state folder.
        assert.deepEqual(yield* response.json, { state: "waiting" });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("marks a library server's overview and answers a repeated move back", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({ scientSourcesBackend: "library" });
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-move-back-" });
        yield* Effect.promise(async () => {
          await initializeScientProject({ root });
          await importScientSource({
            root,
            operationId: NodeCrypto.randomUUID(),
            candidate: {
              sourceKey: "move-back",
              type: "article",
              customType: null,
              title: "A study that comes back",
              creators: [],
              issuedRaw: null,
              issuedYear: 2026,
              identifiers: [],
              abstract: null,
              containerTitle: null,
              publisher: null,
              volume: null,
              issue: null,
              pages: null,
              language: null,
              url: null,
              tags: [],
              externalReferences: [],
              fieldProvenance: [],
              pdfAvailable: false,
              pdfFileName: null,
              pdfAttachmentCount: 0,
            },
          });
        });
        const owner = { cookie: yield* getAuthenticatedSessionCookieHeader() };
        const post = (path: string, body: object) =>
          Effect.gen(function* () {
            const response = yield* HttpClient.post(path, {
              headers: owner,
              body: yield* HttpBody.json(body),
            });
            return (yield* response.json) as Record<string, unknown>;
          });

        // Not moved yet: the project's own store, which has no scopes, on a library server.
        const before = yield* post("/api/scient/sources/overview", { root });
        assert.equal(before.libraryBackend, true);
        assert.notProperty(before, "scopes");
        // The change moves the project in first, then moves it back.
        const movedBack = yield* post("/api/scient/sources/organize", {
          root,
          change: { action: "move-back" },
        });
        assert.equal(movedBack.outcome, "moved-back");
        assert.deepEqual(
          yield* post("/api/scient/sources/organize", { root, change: { action: "move-back" } }),
          { outcome: "not-moved" },
        );
        const after = yield* post("/api/scient/sources/overview", { root });
        assert.equal(after.libraryBackend, true);
        assert.notProperty(after, "scopes");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("serves the personal note only to a session that may change the Library", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({ scientSourcesBackend: "library" });
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-personal-note-" });
        const sourceId = yield* Effect.promise(async () => {
          await initializeScientProject({ root });
          const imported = await importScientSource({
            root,
            operationId: NodeCrypto.randomUUID(),
            candidate: {
              sourceKey: "personal-note",
              type: "article",
              customType: null,
              title: "A moved study",
              creators: [],
              issuedRaw: null,
              issuedYear: 2026,
              identifiers: [],
              abstract: null,
              containerTitle: null,
              publisher: null,
              volume: null,
              issue: null,
              pages: null,
              language: null,
              url: null,
              tags: [],
              externalReferences: [],
              fieldProvenance: [],
              pdfAvailable: false,
              pdfFileName: null,
              pdfAttachmentCount: 0,
            },
          });
          return imported.record!.sourceId;
        });
        const owner = { cookie: yield* getAuthenticatedSessionCookieHeader() };
        const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "orchestration:read",
        });
        const readOnly = { authorization: `Bearer ${reader.body.access_token ?? ""}` };
        const post = (path: string, headers: Record<string, string>, body: object) =>
          Effect.gen(function* () {
            const response = yield* HttpClient.post(path, {
              headers,
              body: yield* HttpBody.json(body),
            });
            return (yield* response.json) as Record<string, unknown>;
          });

        // The first change moves the project; the source arrives unread and unstarred.
        const set = yield* post("/api/scient/sources/personal-note/update", owner, {
          root,
          sourceId,
          expectedRevision: 1,
          note: "MY-OWN-NOTE",
        });
        assert.equal(set.outcome, "updated");
        const asOwner = yield* post("/api/scient/sources/detail", owner, { root, sourceId });
        assert.deepInclude(asOwner, {
          personalNote: "MY-OWN-NOTE",
          readingStatus: "unread",
          starred: false,
        });
        const asReader = yield* post("/api/scient/sources/detail", readOnly, { root, sourceId });
        assert.equal(asReader.title, "A moved study");
        assert.notInclude(JSON.stringify(asReader), "MY-OWN-NOTE");
        assert.deepInclude(
          yield* post("/api/scient/sources/personal-note/update", readOnly, {
            root,
            sourceId,
            expectedRevision: 2,
            note: null,
          }),
          { code: "insufficient_scope", requiredScope: "orchestration:operate" },
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );
    // SCIENT-FORK:END

    it.effect("revokes an individual paired client session", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: {
            host: "0.0.0.0",
          },
        });

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({}),
        });
        const pairingBody = (yield* pairingResponse.json) as {
          readonly credential: string;
        };
        const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
          pairingBody.credential,
        );

        const { clientSessions: clients } = yield* readAuthAccessSnapshot({ cookie: ownerCookie });
        const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId;
        assert.isDefined(pairedSessionId);

        const revokeResponse = yield* HttpClient.post("/api/auth/clients/revoke", {
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: HttpBody.text(jsonRequestBody({ sessionId: pairedSessionId }), "application/json"),
        });
        const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: pairedSessionCookie,
          },
          body: yield* HttpBody.json({}),
        });

        assert.equal(revokeResponse.status, 200);
        assert.equal(pairedClientPairingResponse.status, 401);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("allows reusing the desktop bootstrap credential", () =>
      Effect.gen(function* () {
        // The desktop-bootstrap grant is delivered over trusted IPC at
        // backend launch and needs to stay claimable after a renderer
        // refresh, so it's intentionally reusable (unlike user-facing
        // one-time pairing credentials).
        yield* buildAppUnderTest();

        const first = yield* bootstrapBrowserSession();
        const second = yield* bootstrapBrowserSession();

        assert.equal(first.response.status, 200);
        assert.equal(second.response.status, 200);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("accepts websocket rpc handshake with a bootstrapped browser session cookie", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession();

        assert.equal(bootstrapResponse.status, 200);
        assert.isDefined(cookie);

        const wsUrl = appendSessionCookieToWsUrl(
          yield* getWsServerUrl("/ws", { authenticated: false }),
          cookie?.split(";")[0] ?? "",
        );
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(response.auth.policy, "desktop-managed-local");
        assert.equal(response.shellResumeCompletionMarker, true);
        assert.isUndefined(response.shellRevealInFileManager);
        assert.isUndefined(response.shellRevealInFileManagerKind);
        assert.equal(response.threadResumeCompletionMarker, true);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // SCIENT-FORK:START — Upstream T3 added threads without a project
    // and projects created from a name. Scratch is approved but still
    // withheld in Git data directories; create-from-name remains gated off.
    it.effect("withholds threads without a project inside a Git data directory", () =>
      Effect.gen(function* () {
        const app = yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
          },
        });

        yield* Effect.scoped(
          withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            Effect.gen(function* () {
              const config = yield* client[WS_METHODS.serverGetConfig]({});

              assert.isUndefined(config.scratchWorkspaceRoot);

              const ensure = yield* Effect.flip(client[WS_METHODS.projectsEnsureScratch]({}));
              assert.include(String(ensure.message), "is inside the Git repository");
            }),
          ),
        );
        assert.equal(yield* app.v2.eventSink.latestSequence(), 0);
        assert.deepEqual((yield* app.v2.threads.getShellSnapshot()).threads, []);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(["spawn", "unavailable"] as const)(
      "Scratch RPC and first launch share the development root without Git (%s)",
      (kind) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const checkout = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-rpc-scratch-profile-",
          });
          const external = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-rpc-scratch-external-",
          });
          yield* fs.makeDirectory(path.join(checkout, ".git"));
          const baseDir = path.join(checkout, ".scient-next");
          yield* fs.makeDirectory(baseDir);
          const scratchRoot = path.join(external, "scratch");
          const missing =
            kind === "spawn"
              ? new VcsProcessSpawnError({
                  operation: "test",
                  command: "git",
                  cwd: baseDir,
                  cause: PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    syscall: "spawn git",
                  }),
                })
              : new VcsExecutableUnavailableError({
                  operation: "test",
                  kind: "git",
                  command: "git",
                  cwd: baseDir,
                });
          const app = yield* buildAppUnderTest({
            config: {
              baseDir,
              devUrl: new URL("http://127.0.0.1:5173"),
              developmentScratchRoot: scratchRoot,
            },
            layers: {
              vcsDriverRegistry: { detect: () => Effect.fail(missing) },
              providerInstanceRegistry: {
                getInstance: () => Effect.succeed(nativeAdmissionInstance),
              },
            },
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          const projectId = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const config = yield* client[WS_METHODS.serverGetConfig]({});
                assert.equal(config.scratchWorkspaceRoot, scratchRoot);
                return (yield* client[WS_METHODS.projectsEnsureScratch]({})).projectId;
              }),
            ),
          );
          const { projectId: again } = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) => client[WS_METHODS.projectsEnsureScratch]({})),
          );
          assert.equal(again, projectId);
          const folders: string[] = [];
          for (const suffix of ["one", "two"]) {
            const threadId = ThreadId.make(`scratch-rpc-${kind}-${suffix}`);
            const input = {
              commandId: CommandId.make(`scratch-launch-${kind}-${suffix}`),
              threadId,
              projectId,
              title: "Synthetic scratch",
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              workspaceStrategy: { type: "root" as const },
              initialMessage: {
                messageId: MessageId.make(`scratch-message-${kind}-${suffix}`),
                text: "Synthetic first message",
                attachments: [],
              },
            };
            const launched = yield* Effect.scoped(
              withWsRpcClient(wsUrl, (client) =>
                client[ORCHESTRATION_V2_WS_METHODS.launchThread](input),
              ),
            );
            const worktreePath = launched.projection.thread.worktreePath;
            assert.isNotNull(worktreePath);
            assert.equal(path.dirname(worktreePath!), scratchRoot);
            assert.isTrue(yield* fs.exists(worktreePath!));
            folders.push(worktreePath!);
            const repeated = yield* Effect.scoped(
              withWsRpcClient(wsUrl, (client) =>
                client[ORCHESTRATION_V2_WS_METHODS.launchThread](input),
              ),
            );
            assert.equal(repeated.projection.thread.worktreePath, worktreePath);
            assert.isTrue(repeated.resumed);
            assert.equal(
              (yield* app.v2.threads.getThreadProjection(threadId)).messages[0]?.text,
              input.initialMessage.text,
            );
          }
          assert.notEqual(folders[0], folders[1]);
          assert.isFalse(yield* fs.exists(path.join(baseDir, "scratch")));
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("withholds projects created from a name while the Scient gate is off", () =>
      Effect.gen(function* () {
        const gitCalls: Array<string> = [];
        const app = yield* buildAppUnderTest({
          layers: {
            gitVcsDriver: {
              readConfigValue: () => Effect.succeed(null),
              execute: (input) =>
                Effect.sync(() => {
                  gitCalls.push(input.args.join(" "));
                  return {
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: "",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  };
                }),
            },
          },
        });

        yield* Effect.scoped(
          withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            Effect.gen(function* () {
              const config = yield* client[WS_METHODS.serverGetConfig]({});

              assert.isUndefined(config.newProjectsRoot);

              const created = yield* Effect.flip(
                client[WS_METHODS.projectsCreateNew]({ name: "Pinball Stats" }),
              );
              assert.include(String(created.message), "not available");
            }),
          ),
        );
        assert.equal(yield* app.v2.eventSink.latestSequence(), 0);
        assert.deepEqual((yield* app.v2.threads.getShellSnapshot()).threads, []);
        assert.deepEqual(gitCalls, []);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );
    // SCIENT-FORK:END

    it.effect("advertises the usable file manager and its reveal label", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            externalLauncher: {
              resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
              resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
            },
          },
        });

        const { cookie } = yield* bootstrapBrowserSession();
        const wsUrl = appendSessionCookieToWsUrl(
          yield* getWsServerUrl("/ws", { authenticated: false }),
          cookie?.split(";")[0] ?? "",
        );
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.deepEqual(response.availableEditors, ["file-manager"]);
        assert.equal(response.shellRevealInFileManager, true);
        assert.equal(response.shellRevealInFileManagerKind, "file-explorer");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("does not block server config when editor discovery never resolves", () =>
      Effect.gen(function* () {
        const discoveryInterrupted = yield* Deferred.make<void>();
        const responseFiber = yield* resolveAvailableEditorsForConfig(
          Effect.never.pipe(
            Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
          ),
        ).pipe(Effect.forkChild);

        yield* TestClock.adjust(Duration.seconds(5));

        const availableEditors = yield* Fiber.join(responseFiber);
        yield* Deferred.await(discoveryInterrupted);
        assert.deepEqual(availableEditors, []);
      }),
    );

    it.effect(
      "does not block server config when file manager reveal discovery never resolves",
      () =>
        Effect.gen(function* () {
          const discoveryInterrupted = yield* Deferred.make<void>();
          const responseFiber = yield* resolveFileManagerRevealKindForConfig(
            Effect.never.pipe(
              Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
            ),
          ).pipe(Effect.forkChild);

          yield* TestClock.adjust(Duration.seconds(5));

          const revealKind = yield* Fiber.join(responseFiber);
          yield* Deferred.await(discoveryInterrupted);
          assert.isUndefined(revealKind);
        }),
    );

    it.effect(
      "rejects websocket rpc handshake when a session token is only provided via query string",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest();

          const { cookie } = yield* bootstrapBrowserSession();
          assert.isDefined(cookie);
          const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
          const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&token=${encodeURIComponent(sessionToken)}`;

          const error = yield* Effect.flip(
            Effect.scoped(
              withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
            ),
          );

          assert.equal(error._tag, "RpcClientError");
          assertInclude(String(error), "SocketOpenError");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );
  },
);
