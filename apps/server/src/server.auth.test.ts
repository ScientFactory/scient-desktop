// @effect-diagnostics nodeBuiltinImport:off
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import {
  AuthAccessTokenType,
  AuthStandardClientScopes,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { DPOP_MAX_CLOCK_SKEW_SECONDS } from "@t3tools/shared/dpop";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  NodeHttpServerTest,
  assertBrowserApiCorsResponseHeaders,
  bootstrapBrowserSession,
  buildAppUnderTest,
  crossOriginClientOrigin,
  decodeCompactJwtPayload,
  encodeTestJson,
  exchangeAccessToken,
  extractSessionTokenFromSetCookie,
  fetchEffect,
  getAuthenticatedSessionCookieHeader,
  getHttpServerUrl,
  getWsServerUrl,
  jsonRequestBody,
  makeCloudEnvironmentHealthRequest,
  makeCloudMintCredentialRequest,
  makeDpopProof,
  readAuthAccessSnapshot,
  responseJsonEffect,
  seedV2StreamThread,
  setProcessEnvironment,
  testEnvironmentDescriptor,
  withWsRpcClient,
} from "./server.testkit.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "server router seam: auth",
  (it) => {
    it.effect("parks HTTP ingress until command readiness", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-gate-" });
        yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "ready");
        const entered = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();

        yield* buildAppUnderTest({
          config: { staticDir },
          layers: {
            serverRuntimeStartup: {
              awaitCommandReady: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(ready)),
              ),
            },
          },
        });
        const request = yield* HttpClient.get("/").pipe(
          Effect.tap(() => Deferred.succeed(completed, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        assert.isFalse(yield* Deferred.isDone(completed));

        yield* Deferred.succeed(ready, undefined);
        assert.equal((yield* Fiber.join(request)).status, 200);
        assert.isTrue(yield* Deferred.isDone(completed));
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("caches hashed static assets without freezing mutable files or SPA fallbacks", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-static-hashes-",
        });
        yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
        yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
        yield* fileSystem.writeFileString(
          path.join(staticDir, ".vite", "manifest.json"),
          `{
          "index.html": { "file": "assets/index-AbCd0123.js", "isEntry": true },
          "large.js": { "file": "assets/large-aBcD9876.js" }
        }`,
        );
        yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "<html>app</html>");
        yield* fileSystem.writeFileString(
          path.join(staticDir, "assets", "index-AbCd0123.js"),
          "export const app = true;",
        );
        yield* fileSystem.writeFileString(path.join(staticDir, "assets", "config.json"), "{}");
        const largeAsset = "export const value = 123;\n".repeat(8192);
        yield* fileSystem.writeFileString(
          path.join(staticDir, "assets", "large-aBcD9876.js"),
          largeAsset,
        );
        yield* buildAppUnderTest({ config: { staticDir } });

        const asset = yield* HttpClient.get("/assets/index-AbCd0123.js");
        assert.equal(asset.status, 200);
        assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
        assert.equal(yield* asset.text, "export const app = true;");

        const head = yield* HttpClient.head("/assets/index-AbCd0123.js", {
          headers: { "accept-encoding": "identity" },
        });
        assert.equal(head.status, 200);
        assert.equal(head.headers.etag, asset.headers.etag);
        assert.equal(head.headers["content-length"], String("export const app = true;".length));
        assert.equal(yield* head.text, "");

        const compressed = yield* HttpClient.get("/assets/large-aBcD9876.js", {
          headers: { "accept-encoding": "gzip" },
        });
        assert.equal(compressed.headers["content-encoding"], "gzip");
        assert.equal(compressed.headers.vary, "Accept-Encoding");
        assert.equal(yield* compressed.text, largeAsset);
        const compressedHead = yield* HttpClient.head("/assets/large-aBcD9876.js", {
          headers: { "accept-encoding": "gzip" },
        });
        assert.equal(compressedHead.status, 200);
        assert.equal(compressedHead.headers["content-encoding"], "gzip");
        assert.equal(compressedHead.headers.vary, "Accept-Encoding");
        assert.equal(compressedHead.headers.etag, compressed.headers.etag);
        assert.equal(
          compressedHead.headers["content-length"],
          compressed.headers["content-length"],
        );
        assert.equal(yield* compressedHead.text, "");
        const unchanged = yield* HttpClient.get("/assets/large-aBcD9876.js", {
          headers: { "accept-encoding": "identity", "if-none-match": compressed.headers.etag! },
        });
        assert.equal(unchanged.status, 304);
        assert.equal(unchanged.headers.vary, "Accept-Encoding");
        assert.equal(yield* unchanged.text, "");

        for (const resource of [
          "/assets/config.json",
          "/threads/example",
          "/assets/old-ZyXw9876.js",
        ]) {
          const response = yield* HttpClient.get(resource);
          assert.equal(response.status, 200);
          assert.equal(response.headers["cache-control"], "no-cache");
          assert.equal(
            yield* response.text,
            resource.endsWith("config.json") ? "{}" : "<html>app</html>",
          );
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(
      [
        { label: "missing", contents: null },
        { label: "nonmatching", contents: '{"other.js":{"file":"assets/other-AbCd0123.js"}}' },
        // regression: 27e6cc27fe perf(server): cache and stream static web assets (#9669)
        { label: "malformed", contents: "{not-json" },
      ].map((manifest) => ({
        caseTitle: `revalidates hash-like static filenames with a ${manifest.label} manifest`,
        manifest,
      })),
    )("$caseTitle", ({ manifest }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-static-mutable-",
        });
        yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
        if (manifest.contents !== null) {
          yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
          yield* fileSystem.writeFileString(
            path.join(staticDir, ".vite", "manifest.json"),
            manifest.contents,
          );
        }
        const filePath = path.join(staticDir, "assets", "config-20260904.js");
        yield* fileSystem.writeFileString(filePath, "first config");
        yield* buildAppUnderTest({ config: { staticDir } });

        const initial = yield* HttpClient.get("/assets/config-20260904.js");
        assert.equal(initial.headers["cache-control"], "no-cache");
        assert.equal(yield* initial.text, "first config");

        yield* fileSystem.writeFileString(filePath, "replacement config");
        const changed = yield* HttpClient.get("/assets/config-20260904.js", {
          headers: { "if-none-match": initial.headers.etag! },
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.headers["cache-control"], "no-cache");
        assert.notEqual(changed.headers.etag, initial.headers.etag);
        assert.equal(yield* changed.text, "replacement config");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("redirects to dev URL when configured", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: { devUrl: new URL("http://127.0.0.1:5173") },
        });

        const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
        const response = yield* fetchEffect(url, { redirect: "manual" });

        assert.equal(response.status, 302);
        assert.equal(response.headers.location, "http://127.0.0.1:5173/foo/bar?token=test-token");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("serves the public environment descriptor without requiring auth", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const url = yield* getHttpServerUrl("/.well-known/t3/environment");
        const response = yield* fetchEffect(url);
        const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

        assert.equal(response.status, 200);
        assert.deepEqual(body, testEnvironmentDescriptor);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("serves snapshots for MCP handoff thread IDs above the router default", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(
          "thread:mcp:abfba0d2-b591-4b7e-aad1-e943d89811fa:handoff%3A0ae5edf4-2ea3-4ee3-ba7c-48de3ac92896%3A2026-08-24T17%3A08%3A52.138Z:0",
        );
        const app = yield* buildAppUnderTest();
        yield* seedV2StreamThread(app, threadId);

        const response = yield* fetchEffect(
          yield* getHttpServerUrl(`/api/orchestration/threads/${encodeURIComponent(threadId)}`),
          {
            headers: {
              cookie: yield* getAuthenticatedSessionCookieHeader(),
              [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
            },
          },
        );
        const snapshot = yield* responseJsonEffect<{
          readonly projection: { readonly thread: { readonly id: ThreadId } };
        }>(response);

        assert.equal(response.status, 200, encodeTestJson(snapshot));
        assert.equal(snapshot.projection.thread.id, threadId);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("compresses large JSON responses through the composed routes", () =>
      Effect.gen(function* () {
        const descriptor = {
          ...testEnvironmentDescriptor,
          label: "Test environment".repeat(100),
        };
        yield* buildAppUnderTest({
          layers: {
            serverEnvironment: {
              getDescriptor: Effect.succeed(descriptor),
            },
          },
        });

        const url = yield* getHttpServerUrl("/.well-known/t3/environment");
        const response = yield* fetchEffect(url, {
          headers: {
            "accept-encoding": "gzip",
          },
        });
        const body = yield* responseJsonEffect<typeof descriptor>(response);

        assert.equal(response.status, 200);
        assert.equal(response.headers["content-encoding"], "gzip");
        assert.equal(response.headers.vary, "Accept-Encoding");
        assert.deepEqual(body, descriptor);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("includes CORS headers on public environment descriptor responses", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const url = yield* getHttpServerUrl("/.well-known/t3/environment");
        const response = yield* fetchEffect(url, {
          headers: {
            origin: crossOriginClientOrigin,
          },
        });
        const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

        assert.equal(response.status, 200);
        assertBrowserApiCorsResponseHeaders(response.headers);
        assert.deepEqual(body, testEnvironmentDescriptor);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("reports unauthenticated session state without requiring auth", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const url = yield* getHttpServerUrl("/api/auth/session");
        const response = yield* fetchEffect(url);
        const body = yield* responseJsonEffect<{
          readonly authenticated: boolean;
          readonly auth: {
            readonly policy: string;
            readonly bootstrapMethods: ReadonlyArray<string>;
            readonly sessionMethods: ReadonlyArray<string>;
            readonly sessionCookieName: string;
          };
        }>(response);

        assert.equal(response.status, 200);
        assert.equal(body.authenticated, false);
        assert.equal(body.auth.policy, "desktop-managed-local");
        assert.deepEqual(body.auth.bootstrapMethods, ["desktop-bootstrap"]);
        assert.deepEqual(body.auth.sessionMethods, [
          "browser-session-cookie",
          "bearer-access-token",
          "dpop-access-token",
        ]);
        // Desktop, so port-scoped: instances scan for a free port and share
        // 127.0.0.1, and cookies are not scoped by port.
        assert.isTrue(body.auth.sessionCookieName.startsWith("t3_session_"));
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "bootstraps a browser session and authenticates the session endpoint via cookie",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest();

          const {
            response: bootstrapResponse,
            body: bootstrapBody,
            cookie: setCookie,
          } = yield* bootstrapBrowserSession();

          assert.equal(bootstrapResponse.status, 200);
          assert.equal(bootstrapBody.authenticated, true);
          assert.equal(bootstrapBody.sessionMethod, "browser-session-cookie");
          assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken);
          assert.isDefined(setCookie);

          const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
          const sessionResponse = yield* fetchEffect(sessionUrl, {
            headers: {
              cookie: setCookie?.split(";")[0] ?? "",
            },
          });
          const sessionBody = yield* responseJsonEffect<{
            readonly authenticated: boolean;
            readonly sessionMethod?: string;
          }>(sessionResponse);

          assert.equal(sessionResponse.status, 200);
          assert.equal(sessionBody.authenticated, true);
          assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("migrates a valid legacy remote-web session cookie", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({ config: { mode: "web", host: "192.168.1.50" } });

        const { cookie } = yield* bootstrapBrowserSession();
        const currentCookie = cookie?.split(";")[0] ?? "";
        const legacyCookie = currentCookie.replace(/^t3_session_[^=]+=/, "t3_session=");
        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const response = yield* fetchEffect(sessionUrl, {
          headers: { cookie: legacyCookie },
        });
        const body = yield* responseJsonEffect<{ readonly authenticated: boolean }>(response);

        assert.equal(body.authenticated, true);
        assert.equal(response.headers["set-cookie"], cookie);
        assert.equal(response.headers["cache-control"], "no-store");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(["cookie", "bearer"])(
      "does not migrate a stale legacy cookie when %s auth succeeds",
      (source) =>
        Effect.gen(function* () {
          yield* buildAppUnderTest({ config: { mode: "web", host: "192.168.1.50" } });

          const { cookie } = yield* bootstrapBrowserSession();
          const sessionCookie = cookie?.split(";")[0] ?? "";
          const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
          const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
          const response = yield* fetchEffect(sessionUrl, {
            headers:
              source === "cookie"
                ? { cookie: `${sessionCookie}; t3_session=stale` }
                : { authorization: `Bearer ${sessionToken}`, cookie: "t3_session=stale" },
          });
          const body = yield* responseJsonEffect<{ readonly authenticated: boolean }>(response);

          assert.equal(body.authenticated, true);
          assert.isUndefined(response.headers["set-cookie"]);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("exchanges a bootstrap grant for a scoped bearer access token", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken();

        assert.equal(tokenResponse.status, 200);
        assert.equal(tokenBody.issued_token_type, AuthAccessTokenType);
        assert.equal(tokenBody.token_type, "Bearer");
        assert.equal(
          tokenBody.scope,
          "orchestration:read orchestration:operate terminal:operate relay:read access:read access:write relay:write",
        );
        assert.equal(typeof tokenBody.access_token, "string");

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const sessionResponse = yield* fetchEffect(sessionUrl, {
          headers: {
            authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          },
        });
        const sessionBody = yield* responseJsonEffect<{
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
          readonly scopes?: ReadonlyArray<string>;
        }>(sessionResponse);

        assert.equal(sessionResponse.status, 200);
        assert.equal(sessionBody.authenticated, true);
        assert.equal(sessionBody.sessionMethod, "bearer-access-token");
        assert.deepEqual(sessionBody.scopes, [
          "orchestration:read",
          "orchestration:operate",
          "terminal:operate",
          "relay:read",
          "access:read",
          "access:write",
          "relay:write",
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("replaces the local desktop credential on repeated bootstrap exchanges", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const first = yield* exchangeAccessToken();
        const second = yield* exchangeAccessToken();
        const third = yield* exchangeAccessToken();
        assert.equal(first.response.status, 200);
        assert.equal(second.response.status, 200);
        assert.equal(third.response.status, 200);

        const { clientSessions: clients } = yield* readAuthAccessSnapshot({
          bearer: third.body.access_token ?? "",
        });
        assert.equal(clients.length, 1);
        assert.equal(clients[0]?.current, true);
        assert.equal(clients[0]?.subject, "desktop-bootstrap");

        for (const previous of [first, second]) {
          const response = yield* HttpClient.get("/api/auth/session", {
            headers: { authorization: `Bearer ${previous.body.access_token}` },
          });
          const state = (yield* response.json) as { readonly authenticated: boolean };
          assert.equal(state.authenticated, false);
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "persists token exchange client display metadata for authorized-client listings",
      () =>
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

          const { response } = yield* exchangeAccessToken(pairingBody.credential, {
            headers: {
              "user-agent": "undici",
            },
            scope: "orchestration:read orchestration:operate terminal:operate",
            clientMetadata: {
              label: "Scient Mobile",
              deviceType: "mobile",
              os: "iOS",
            },
          });

          const { clientSessions: clients } = yield* readAuthAccessSnapshot({
            cookie: ownerCookie,
          });
          const mobileClient = clients.find((client) => !client.current);

          assert.equal(pairingResponse.status, 200);
          assert.equal(response.status, 200);
          assert.deepInclude(mobileClient?.client, {
            label: "Scient Mobile",
            deviceType: "mobile",
            os: "iOS",
            ipAddress: "127.0.0.1",
            userAgent: "undici",
          });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "exchanges a bootstrap credential for a DPoP-bound access token without bearer downgrade",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest();

          const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
          const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
            headers: { cookie: ownerCookie },
            body: yield* HttpBody.json({}),
          });
          const credential = (yield* credentialResponse.json) as { readonly credential: string };
          const tokenUrl = yield* getHttpServerUrl("/oauth/token");
          const now = yield* DateTime.now;
          const tokenProof = makeDpopProof({
            method: "POST",
            url: tokenUrl,
            iat: Math.floor(now.epochMilliseconds / 1_000),
            jti: "token-exchange-proof",
          });
          const tokenResponse = yield* fetchEffect(tokenUrl, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              dpop: tokenProof.proof,
            },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token: credential.credential,
              subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
              requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              scope: "orchestration:read orchestration:operate terminal:operate",
            }).toString(),
          });
          const token = yield* responseJsonEffect<{
            readonly access_token: string;
            readonly token_type: string;
          }>(tokenResponse);

          assert.equal(tokenResponse.status, 200);
          assert.equal(tokenResponse.headers["cache-control"], "no-store");
          assert.equal(token.token_type, "DPoP");

          const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
          const bearerResponse = yield* fetchEffect(sessionUrl, {
            headers: { authorization: `Bearer ${token.access_token}` },
          });
          const bearerState = yield* responseJsonEffect<{ readonly authenticated: boolean }>(
            bearerResponse,
          );
          assert.equal(bearerState.authenticated, false);

          const sessionProof = makeDpopProof({
            method: "GET",
            url: sessionUrl,
            iat: Math.floor(now.epochMilliseconds / 1_000),
            jti: "session-proof",
            accessToken: token.access_token,
            privateKey: tokenProof.privateKey,
            publicJwk: tokenProof.publicJwk,
          });
          const dpopResponse = yield* fetchEffect(sessionUrl, {
            headers: {
              authorization: `DPoP ${token.access_token}`,
              dpop: sessionProof.proof,
            },
          });
          const dpopState = yield* responseJsonEffect<{
            readonly authenticated: boolean;
            readonly sessionMethod?: string;
          }>(dpopResponse);
          assert.equal(dpopState.authenticated, true);
          assert.equal(dpopState.sessionMethod, "dpop-access-token");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("reports clock skew for a future-dated DPoP token exchange proof", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        });
        const credential = (yield* credentialResponse.json) as { readonly credential: string };
        const tokenUrl = yield* getHttpServerUrl("/oauth/token");
        const now = yield* DateTime.now;
        const dpop = makeDpopProof({
          method: "POST",
          url: tokenUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000) + DPOP_MAX_CLOCK_SKEW_SECONDS + 1,
        });

        const exchange = yield* exchangeAccessToken(credential.credential, {
          headers: { dpop: dpop.proof },
          scope: "orchestration:read orchestration:operate terminal:operate",
        });

        assert.equal(exchange.response.status, 401);
        assert.equal(exchange.body._tag, "EnvironmentAuthInvalidError");
        assert.equal(exchange.body.code, "auth_invalid");
        assert.equal(exchange.body.reason, "invalid_credential");
        assert.equal(exchange.body.dpopFailureReason, "time_window");
        assert.equal(typeof exchange.body.traceId, "string");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("ignores forwarded host headers when validating token exchange DPoP URLs", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({}),
        });
        const credential = (yield* credentialResponse.json) as {
          readonly credential: string;
        };
        const tokenUrl = yield* getHttpServerUrl("/oauth/token");
        const now = yield* DateTime.now;
        const dpop = makeDpopProof({
          method: "POST",
          url: tokenUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
        });

        const bootstrap = yield* exchangeAccessToken(credential.credential, {
          headers: {
            dpop: dpop.proof,
            "x-forwarded-host": "environment.example.test",
          },
          scope: "orchestration:read orchestration:operate terminal:operate",
        });

        assert.equal(bootstrap.response.status, 200);
        assert.equal(bootstrap.body.token_type, "DPoP");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects token exchange DPoP proofs bound to spoofed forwarded hosts", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({}),
        });
        const credential = (yield* credentialResponse.json) as {
          readonly credential: string;
        };
        const tokenUrl = yield* getHttpServerUrl("/oauth/token");
        const spoofedUrl = new URL(tokenUrl);
        spoofedUrl.hostname = "environment.example.test";
        const now = yield* DateTime.now;
        const dpop = makeDpopProof({
          method: "POST",
          url: spoofedUrl.href,
          iat: Math.floor(now.epochMilliseconds / 1_000),
        });

        const bootstrap = yield* exchangeAccessToken(credential.credential, {
          headers: {
            dpop: dpop.proof,
            "x-forwarded-host": spoofedUrl.host,
          },
          scope: "orchestration:read orchestration:operate terminal:operate",
        });

        assert.equal(bootstrap.response.status, 401);
        assert.equal(bootstrap.body._tag, "EnvironmentAuthInvalidError");
        assert.equal(bootstrap.body.code, "auth_invalid");
        assert.equal(bootstrap.body.reason, "invalid_credential");
        assert.equal(bootstrap.body.dpopFailureReason, "request_mismatch");
        assert.equal(typeof bootstrap.body.traceId, "string");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects cloud link proofs for unsupported endpoint providers", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
        const serverPort = Number(new URL(linkProofUrl).port);
        const linkProofResponse = yield* fetchEffect(linkProofUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            challenge: "relay-link-challenge",
            relayIssuer: "https://relay.example.test",
            endpoint: {
              httpBaseUrl: linkProofUrl.replace("/api/connect/link-proof", ""),
              wsBaseUrl: linkProofUrl
                .replace("http://", "ws://")
                .replace("/api/connect/link-proof", "/ws"),
              // "manual" and "cloudflare_tunnel" are supported; "t3_relay" is not.
              providerKind: "t3_relay",
            },
            origin: {
              localHttpHost: "127.0.0.1",
              localHttpPort: serverPort,
            },
          }),
        });
        const body = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly message?: string;
        }>(linkProofResponse);

        assert.equal(linkProofResponse.status, 400);
        assert.equal(body._tag, "EnvironmentHttpBadRequestError");
        assert.equal(body.message, "Invalid managed endpoint origin.");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("allows standard clients to read managed relay configuration state", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        });
        const credential = (yield* credentialResponse.json) as { readonly credential: string };
        const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
        const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
        const response = yield* fetchEffect(linkStateUrl, {
          headers: { cookie: pairedCookie },
        });
        const body = yield* responseJsonEffect<{
          readonly linked?: boolean;
          readonly publishAgentActivity?: boolean;
        }>(response);

        assert.equal(response.status, 200);
        assert.equal(body.linked, false);
        assert.equal(body.publishAgentActivity, false);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "reports relay client status and streams installation progress over environment RPC",
      () =>
        Effect.gen(function* () {
          const installedRelayClient = {
            status: "available" as const,
            executablePath: "/tmp/t3/tools/cloudflared",
            source: "managed" as const,
            version: RelayClient.CLOUDFLARED_VERSION,
          };
          yield* buildAppUnderTest({
            layers: {
              relayClient: {
                resolve: Effect.succeed({
                  status: "missing",
                  version: RelayClient.CLOUDFLARED_VERSION,
                }),
                install: Effect.succeed(installedRelayClient),
                installWithProgress: (report) =>
                  report({ type: "progress", stage: "checking" }).pipe(
                    Effect.andThen(report({ type: "progress", stage: "downloading" })),
                    Effect.as(installedRelayClient),
                  ),
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          const status = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) => client[WS_METHODS.cloudGetRelayClientStatus]({})),
          );
          const installEvents = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.cloudInstallRelayClient]({}).pipe(Stream.runCollect),
            ),
          );

          assert.equal(status.status, "missing");
          assert.deepEqual(Array.from(installEvents), [
            { type: "progress", stage: "checking" },
            { type: "progress", stage: "downloading" },
            { type: "complete", status: installedRelayClient },
          ]);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("requires relay write scope to update agent activity publication", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const preferencesUrl = yield* getHttpServerUrl("/api/connect/preferences");
        const ownerResponse = yield* fetchEffect(preferencesUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({ publishAgentActivity: true }),
        });
        const ownerBody = yield* responseJsonEffect<{
          readonly publishAgentActivity?: boolean;
        }>(ownerResponse);
        assert.equal(ownerResponse.status, 200);
        assert.equal(ownerBody.publishAgentActivity, true);

        // The default grant includes relay management; a narrower link must not.
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({
            scopes: AuthStandardClientScopes.filter((scope) => scope !== "relay:write"),
          }),
        });
        const credential = (yield* credentialResponse.json) as { readonly credential: string };
        const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
        const pairedResponse = yield* fetchEffect(preferencesUrl, {
          method: "POST",
          headers: {
            cookie: pairedCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({ publishAgentActivity: false }),
        });
        const pairedBody = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly requiredScope?: string;
        }>(pairedResponse);
        assert.equal(pairedResponse.status, 403);
        assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
        assert.equal(pairedBody.requiredScope, "relay:write");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects relay config with an invalid cloud mint public key", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: "not-a-public-key",
            endpointRuntime: null,
          }),
        });
        const body = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly message?: string;
        }>(relayConfigResponse);

        assert.equal(relayConfigResponse.status, 400);
        assert.equal(body._tag, "EnvironmentHttpBadRequestError");
        assert.equal(body.message, "Cloud mint public key must be a valid Ed25519 public key.");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects relay config with insecure relay metadata or empty credentials", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const postRelayConfig = (body: {
          readonly relayUrl: string;
          readonly relayIssuer?: string;
          readonly cloudUserId: string;
          readonly environmentCredential: string;
        }) =>
          fetchEffect(relayConfigUrl, {
            method: "POST",
            headers: {
              cookie: ownerCookie,
              "content-type": "application/json",
            },
            body: jsonRequestBody({
              ...body,
              cloudMintPublicKey: cloudKeyPair.publicKey,
              endpointRuntime: null,
            }),
          });

        const insecureRelayUrl = yield* postRelayConfig({
          relayUrl: "http://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
        });
        const insecureRelayIssuer = yield* postRelayConfig({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          relayIssuer: "http://relay.example.test",
          environmentCredential: "t3env_test_credential",
        });
        const nonOriginRelayUrl = yield* postRelayConfig({
          relayUrl: "https://relay.example.test/path",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
        });
        const emptyCredential = yield* postRelayConfig({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "   ",
        });
        const insecureRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
          insecureRelayUrl,
        );
        const insecureRelayIssuerBody = yield* responseJsonEffect<{ readonly message?: string }>(
          insecureRelayIssuer,
        );
        const nonOriginRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
          nonOriginRelayUrl,
        );
        const emptyCredentialBody = yield* responseJsonEffect<{ readonly message?: string }>(
          emptyCredential,
        );

        assert.equal(insecureRelayUrl.status, 400);
        assert.equal(
          insecureRelayUrlBody.message,
          "Relay URL must be a secure absolute HTTPS URL.",
        );
        assert.equal(insecureRelayIssuer.status, 400);
        assert.equal(
          insecureRelayIssuerBody.message,
          "Relay issuer must be a secure absolute HTTPS URL.",
        );
        assert.equal(nonOriginRelayUrl.status, 400);
        assert.equal(
          nonOriginRelayUrlBody.message,
          "Relay URL must be a secure absolute HTTPS URL.",
        );
        assert.equal(emptyCredential.status, 400);
        assert.equal(emptyCredentialBody.message, "Relay environment credential is required.");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects relay config replacement from a different cloud account", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const postRelayConfig = (cloudUserId: string, environmentCredential: string) =>
          fetchEffect(relayConfigUrl, {
            method: "POST",
            headers: {
              cookie: ownerCookie,
              "content-type": "application/json",
            },
            body: jsonRequestBody({
              relayUrl: "https://relay.example.test",
              cloudUserId,
              environmentCredential,
              cloudMintPublicKey: cloudKeyPair.publicKey,
              endpointRuntime: null,
            }),
          });

        const firstResponse = yield* postRelayConfig("user_123", "t3env_first_credential");
        const replacementResponse = yield* postRelayConfig("user_456", "t3env_second_credential");
        const replacementBody = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly message?: string;
        }>(replacementResponse);

        assert.equal(firstResponse.status, 200);
        assert.equal(replacementResponse.status, 409);
        assert.equal(replacementBody._tag, "EnvironmentHttpConflictError");
        assert.equal(
          replacementBody.message,
          "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects a non-Cloudflare managed endpoint runtime without persisting the link", () =>
      Effect.gen(function* () {
        const appliedRuntimeConfigs: Array<unknown> = [];
        yield* buildAppUnderTest({
          layers: {
            cloudManagedEndpointRuntime: {
              applyConfig: (config) =>
                Effect.sync(() => {
                  appliedRuntimeConfigs.push(config);
                  return config === null
                    ? ({ status: "disabled" } as const)
                    : ({ status: "unsupported", providerKind: config.providerKind } as const);
                }),
            },
          },
        });

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
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: {
              providerKind: "manual",
              connectorToken: "manual-token",
            },
          }),
        });
        const relayConfigBody = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly endpointRuntimeStatus?: { readonly status?: string };
        }>(relayConfigResponse);
        const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
        const linkStateResponse = yield* fetchEffect(linkStateUrl, {
          headers: { cookie: ownerCookie },
        });
        const linkStateBody = yield* responseJsonEffect<{ readonly linked?: boolean }>(
          linkStateResponse,
        );

        assert.equal(relayConfigResponse.status, 503);
        assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
        assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "unsupported");
        // The connector is never touched for a rejected runtime.
        assert.deepEqual(appliedRuntimeConfigs, []);
        assert.equal(linkStateResponse.status, 200);
        assert.equal(linkStateBody.linked, false);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("reports local cloud link state from persisted relay config", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");

        const initialResponse = yield* fetchEffect(linkStateUrl, {
          headers: {
            cookie: ownerCookie,
          },
        });
        const initialBody = yield* responseJsonEffect<{
          readonly linked?: boolean;
          readonly cloudUserId?: string | null;
        }>(initialResponse);
        assert.equal(initialResponse.status, 200);
        assert.equal(initialBody.linked, false);
        assert.equal(initialBody.cloudUserId, null);

        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://transport.example.test",
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const linkedResponse = yield* fetchEffect(linkStateUrl, {
          headers: {
            cookie: ownerCookie,
          },
        });
        const linkedBody = yield* responseJsonEffect<{
          readonly linked?: boolean;
          readonly cloudUserId?: string | null;
          readonly relayUrl?: string | null;
          readonly relayIssuer?: string | null;
        }>(linkedResponse);

        assert.equal(linkedResponse.status, 200);
        assert.equal(linkedBody.linked, true);
        assert.equal(linkedBody.cloudUserId, "user_123");
        assert.equal(linkedBody.relayUrl, "https://transport.example.test");
        assert.equal(linkedBody.relayIssuer, "https://relay.example.test");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("does not expose internal cloud reconciliation over HTTP", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const reconcileUrl = yield* getHttpServerUrl("/api/connect/reconcile");
        const response = yield* fetchEffect(reconcileUrl, {
          method: "POST",
        });

        assert.equal(response.status, 404);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("unlinks local cloud state and disables the managed endpoint runtime", () =>
      Effect.gen(function* () {
        const appliedRuntimeConfigs: Array<unknown> = [];
        const requestedRecoveryConfigs: Array<unknown> = [];
        yield* buildAppUnderTest({
          layers: {
            cloudManagedEndpointRuntime: {
              applyConfig: (config) => {
                appliedRuntimeConfigs.push(config);
                if (!config) {
                  return Effect.succeed({ status: "disabled" });
                }
                return Effect.succeed({
                  status: "running",
                  providerKind: "cloudflare_tunnel",
                  pid: 123,
                  ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
                  ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
                });
              },
              requestRecovery: (config) =>
                Effect.sync(() => {
                  requestedRecoveryConfigs.push(config);
                }),
            },
            httpClient: HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ status: "ready" })),
              ),
            ),
          },
        });

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const unlinkUrl = yield* getHttpServerUrl("/api/connect/unlink");
        const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");

        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://transport.example.test",
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: {
              providerKind: "cloudflare_tunnel",
              connectorToken: "connector-token",
              tunnelId: "tunnel-id",
              tunnelName: "tunnel-name",
            },
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const unlinkResponse = yield* fetchEffect(unlinkUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
          },
        });
        const unlinkBody = yield* responseJsonEffect<{
          readonly ok?: boolean;
          readonly endpointRuntimeStatus?: { readonly status?: string };
        }>(unlinkResponse);
        assert.equal(unlinkResponse.status, 200);
        assert.equal(unlinkBody.ok, true);
        assert.equal(unlinkBody.endpointRuntimeStatus?.status, "disabled");

        const linkStateResponse = yield* fetchEffect(linkStateUrl, {
          headers: {
            cookie: ownerCookie,
          },
        });
        const linkStateBody = yield* responseJsonEffect<{
          readonly linked?: boolean;
          readonly cloudUserId?: string | null;
          readonly relayUrl?: string | null;
          readonly relayIssuer?: string | null;
        }>(linkStateResponse);
        assert.equal(linkStateResponse.status, 200);
        assert.equal(linkStateBody.linked, false);
        assert.equal(linkStateBody.cloudUserId, null);
        assert.equal(linkStateBody.relayUrl, null);
        assert.equal(linkStateBody.relayIssuer, null);
        assert.deepEqual(appliedRuntimeConfigs, [
          null,
          {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
          },
          null,
        ]);
        assert.deepEqual(requestedRecoveryConfigs, []);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects replayed cloud mint requests atomically", () =>
      // This is a cloud protocol regression test; opt the test process into
      // the otherwise-disabled D4 cloud route explicitly.
      Effect.acquireUseRelease(
        Effect.sync(() =>
          setProcessEnvironment({
            SCIENT_NEXT_CLOUD_ENABLED: "true",
            T3CODE_RELAY_URL: "https://relay.example.test",
            T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_example",
            T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_test",
          }),
        ),
        () =>
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
                relayUrl: "https://relay.example.test",
                cloudUserId: "user_123",
                environmentCredential: "t3env_test_credential",
                cloudMintPublicKey: cloudKeyPair.publicKey,
                endpointRuntime: null,
              }),
            });
            assert.equal(relayConfigResponse.status, 200);

            const now = yield* DateTime.now;
            const request = makeCloudMintCredentialRequest({
              privateKey: cloudKeyPair.privateKey,
              environmentId: testEnvironmentDescriptor.environmentId,
              clientProofKeyThumbprint: "client-proof-key-thumbprint",
              nonce: "cloud-mint-nonce-1",
              issuedAt: DateTime.formatIso(now),
              expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            });
            const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
            const postMint = () =>
              fetchEffect(mintUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                },
                body: jsonRequestBody(request),
              });

            const firstResponse = yield* postMint();
            const replayResponse = yield* postMint();
            const replayBody = yield* responseJsonEffect<{
              readonly _tag?: string;
              readonly message?: string;
            }>(replayResponse);

            assert.equal(firstResponse.status, 200);
            assert.equal(replayResponse.status, 409);
            assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
            assert.equal(replayBody.message, "Cloud mint request was already consumed.");
          }),
        (restore) => Effect.sync(restore),
      ).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("serves the documented T3 Connect mint credential endpoint", () =>
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
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const now = yield* DateTime.now;
        const request = makeCloudMintCredentialRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
          jti: "cloud-mint-jti-documented-endpoint",
          nonce: "cloud-mint-nonce-documented-endpoint",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        });
        const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
        const response = yield* fetchEffect(mintUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

        assert.equal(response.status, 200);
        const body = yield* responseJsonEffect<{
          readonly credential?: string;
          readonly proof?: string;
        }>(response);
        assert.equal(typeof body.credential, "string");
        assert.equal(typeof body.proof, "string");
        assert.equal(
          decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
          "cloud-mint-nonce-documented-endpoint",
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("serves signed T3 Connect environment health checks", () =>
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
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const now = yield* DateTime.now;
        const request = makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          jti: "cloud-health-jti-documented-endpoint",
          nonce: "cloud-health-nonce-documented-endpoint",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        });
        const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
        const response = yield* fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

        assert.equal(response.status, 200);
        const body = yield* responseJsonEffect<{
          readonly status?: string;
          readonly descriptor?: { readonly environmentId?: string };
          readonly proof?: string;
        }>(response);
        assert.equal(body.status, "online");
        assert.equal(body.descriptor?.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(typeof body.proof, "string");
        assert.equal(
          decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
          "cloud-health-nonce-documented-endpoint",
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects replayed cloud health requests atomically", () =>
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
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const now = yield* DateTime.now;
        const request = makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          jti: "cloud-health-jti-replay",
          nonce: "cloud-health-nonce-replay",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        });
        const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
        const postHealth = () =>
          fetchEffect(healthUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: jsonRequestBody(request),
          });

        const firstResponse = yield* postHealth();
        const replayResponse = yield* postHealth();
        const replayBody = yield* responseJsonEffect<{
          readonly _tag?: string;
          readonly message?: string;
        }>(replayResponse);

        assert.equal(firstResponse.status, 200);
        assert.equal(replayResponse.status, 409);
        assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
        assert.equal(replayBody.message, "Cloud health request was already consumed.");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "validates cloud proofs against the configured relay issuer, not the transport URL",
      () =>
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
              relayUrl: "https://transport.example.test",
              cloudUserId: "user_123",
              relayIssuer: "https://relay.example.test",
              environmentCredential: "t3env_test_credential",
              cloudMintPublicKey: cloudKeyPair.publicKey,
              endpointRuntime: null,
            }),
          });
          assert.equal(relayConfigResponse.status, 200);

          const now = yield* DateTime.now;
          const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
          const postMint = (request: ReturnType<typeof makeCloudMintCredentialRequest>) =>
            fetchEffect(mintUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: jsonRequestBody(request),
            });

          const acceptedResponse = yield* postMint(
            makeCloudMintCredentialRequest({
              privateKey: cloudKeyPair.privateKey,
              environmentId: testEnvironmentDescriptor.environmentId,
              clientProofKeyThumbprint: "client-proof-key-thumbprint",
              issuer: "https://relay.example.test",
              jti: "cloud-mint-jti-explicit-relay-issuer",
              nonce: "cloud-mint-nonce-explicit-relay-issuer",
              issuedAt: DateTime.formatIso(now),
              expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            }),
          );
          const rejectedResponse = yield* postMint(
            makeCloudMintCredentialRequest({
              privateKey: cloudKeyPair.privateKey,
              environmentId: testEnvironmentDescriptor.environmentId,
              clientProofKeyThumbprint: "client-proof-key-thumbprint",
              issuer: "https://transport.example.test",
              jti: "cloud-mint-jti-transport-url",
              nonce: "cloud-mint-nonce-transport-url",
              issuedAt: DateTime.formatIso(now),
              expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            }),
          );

          assert.equal(acceptedResponse.status, 200);
          assert.equal(rejectedResponse.status, 401);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("keeps a managed connector stopped when relay registration fails", () =>
      Effect.gen(function* () {
        const appliedRuntimeConfigs: Array<unknown> = [];
        const relayRequests: Array<HttpClientRequest.HttpClientRequest> = [];
        yield* buildAppUnderTest({
          layers: {
            cloudManagedEndpointRuntime: {
              applyConfig: (config) =>
                Effect.sync(() => {
                  appliedRuntimeConfigs.push(config);
                  return config === null
                    ? ({ status: "disabled" } as const)
                    : ({ status: "running", providerKind: "cloudflare_tunnel", pid: 123 } as const);
                }),
            },
            httpClient: HttpClient.make((request) =>
              Effect.sync(() => {
                relayRequests.push(request);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ message: "relay unavailable" }, { status: 503 }),
                );
              }),
            ),
          },
        });

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
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: {
              providerKind: "cloudflare_tunnel",
              connectorToken: "connector-token",
              tunnelId: "tunnel-1",
            },
          }),
        });
        const relayConfigBody = yield* responseJsonEffect<{ readonly _tag?: string }>(
          relayConfigResponse,
        );

        assert.equal(relayConfigResponse.status, 500);
        assert.equal(relayConfigBody._tag, "EnvironmentHttpInternalServerError");
        assert.equal(relayRequests.length, 3);
        assert.deepEqual(appliedRuntimeConfigs, [null]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "queues recovery without starting a connector when relay registration requires it",
      () =>
        Effect.gen(function* () {
          const appliedRuntimeConfigs: Array<unknown> = [];
          const requestedRecoveryConfigs: Array<unknown> = [];
          const relayRequests: Array<HttpClientRequest.HttpClientRequest> = [];
          yield* buildAppUnderTest({
            layers: {
              cloudManagedEndpointRuntime: {
                applyConfig: (config) =>
                  Effect.sync(() => {
                    appliedRuntimeConfigs.push(config);
                    return config === null
                      ? ({ status: "disabled" } as const)
                      : ({
                          status: "running",
                          providerKind: "cloudflare_tunnel",
                          pid: 123,
                        } as const);
                  }),
                requestRecovery: (config) =>
                  Effect.sync(() => {
                    requestedRecoveryConfigs.push(config);
                  }),
              },
              httpClient: HttpClient.make((request) =>
                Effect.sync(() => {
                  relayRequests.push(request);
                  return HttpClientResponse.fromWeb(
                    request,
                    Response.json({ status: "recovery_required" }),
                  );
                }),
              ),
            },
          });

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
              relayUrl: "https://relay.example.test",
              cloudUserId: "user_123",
              environmentCredential: "t3env_test_credential",
              cloudMintPublicKey: cloudKeyPair.publicKey,
              endpointRuntime: {
                providerKind: "cloudflare_tunnel",
                connectorToken: "connector-token",
                tunnelId: "tunnel-1",
              },
            }),
          });
          const relayConfigBody = yield* responseJsonEffect<{
            readonly _tag?: string;
            readonly endpointRuntimeStatus?: { readonly status?: string };
          }>(relayConfigResponse);

          assert.equal(relayConfigResponse.status, 503);
          assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
          assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "disabled");
          assert.equal(relayRequests.length, 1);
          assert.deepEqual(appliedRuntimeConfigs, [null]);
          assert.deepEqual(requestedRecoveryConfigs, [
            {
              providerKind: "cloudflare_tunnel",
              connectorToken: "connector-token",
              tunnelId: "tunnel-1",
            },
          ]);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("fails relay config when the managed endpoint connector cannot start", () =>
      Effect.gen(function* () {
        const appliedRuntimeConfigs: Array<unknown> = [];
        yield* buildAppUnderTest({
          layers: {
            cloudManagedEndpointRuntime: {
              applyConfig: (config) =>
                Effect.sync(() => {
                  appliedRuntimeConfigs.push(config);
                  return config === null
                    ? ({ status: "disabled" } as const)
                    : ({
                        status: "failed",
                        providerKind: "cloudflare_tunnel",
                        failure: "not-installed",
                        reason: "cloudflared missing",
                        tunnelId: "tunnel-1",
                      } as const);
                }),
            },
            httpClient: HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ status: "ready" })),
              ),
            ),
          },
        });

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
            relayUrl: "https://relay.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: {
              providerKind: "cloudflare_tunnel",
              connectorToken: "connector-token",
              tunnelId: "tunnel-1",
            },
          }),
        });

        assert.equal(relayConfigResponse.status, 503);
        const relayConfigBody = yield* responseJsonEffect<{
          _tag?: string;
          message?: string;
          endpointRuntimeStatus?: { status?: string; reason?: string };
        }>(relayConfigResponse);
        assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
        assert.equal(relayConfigBody.message, "Managed endpoint runtime could not be started.");
        assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "failed");
        assert.equal(relayConfigBody.endpointRuntimeStatus?.reason, "cloudflared missing");
        assert.deepEqual(appliedRuntimeConfigs, [
          null,
          {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-1",
          },
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "rejects cloud mint requests with the wrong issuer, audience, subject or connect scope",
      () =>
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
          const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
          const post = (
            claim: string,
            overrides: Partial<Parameters<typeof makeCloudMintCredentialRequest>[0]>,
          ) =>
            fetchEffect(mintUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: jsonRequestBody(
                makeCloudMintCredentialRequest({
                  privateKey: cloudKeyPair.privateKey,
                  environmentId: testEnvironmentDescriptor.environmentId,
                  clientProofKeyThumbprint: "client-proof-key-thumbprint",
                  jti: `cloud-mint-jti-${claim}`,
                  nonce: `cloud-mint-nonce-${claim}`,
                  issuedAt: DateTime.formatIso(now),
                  expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
                  ...overrides,
                }),
              ),
            });

          for (const [claim, overrides] of [
            ["wrong-issuer", { issuer: "https://attacker.example.test" }],
            ["wrong-audience", { audience: "t3-env:other-environment" }],
            ["wrong-subject", { subject: "user_other" }],
            ["duplicate-scope", { scope: ["environment:connect", "environment:connect"] }],
          ] as const) {
            assert.equal((yield* post(claim, overrides)).status, 401, claim);
          }
          // The same fixture accepts a valid proof, so the refusals are not a blanket 401.
          assert.equal((yield* post("valid", {})).status, 200);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "rejects cloud health requests with the wrong issuer, audience, subject or status scope",
      () =>
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
          const post = (
            claim: string,
            overrides: Partial<Parameters<typeof makeCloudEnvironmentHealthRequest>[0]>,
          ) =>
            fetchEffect(healthUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: jsonRequestBody(
                makeCloudEnvironmentHealthRequest({
                  privateKey: cloudKeyPair.privateKey,
                  environmentId: testEnvironmentDescriptor.environmentId,
                  jti: `cloud-health-jti-${claim}`,
                  nonce: `cloud-health-nonce-${claim}`,
                  issuedAt: DateTime.formatIso(now),
                  expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
                  ...overrides,
                }),
              ),
            });

          for (const [claim, overrides] of [
            ["wrong-issuer", { issuer: "https://attacker.example.test" }],
            ["wrong-audience", { audience: "t3-env:other-environment" }],
            ["wrong-subject", { subject: "user_other" }],
            ["duplicate-scope", { scope: ["environment:status", "environment:status"] }],
          ] as const) {
            assert.equal((yield* post(claim, overrides)).status, 401, claim);
          }
          // The same fixture accepts a valid proof, so the refusals are not a blanket 401.
          assert.equal((yield* post("valid", {})).status, 200);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );
  },
);
