// @effect-diagnostics nodeBuiltinImport:off
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { FILE_PREVIEW_SCROLL_SCRIPT } from "@t3tools/shared/htmlRender";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CommandId,
  ORCHESTRATION_PROTOCOL_HEADER,
  DEFAULT_SERVER_SETTINGS,
  type CustomModelsSettings,
  EnvironmentFilePath,
  EventId,
  TextGenerationError,
  ProjectId,
  type ProviderAuthState,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  type ServerProvider,
  type ServerLifecycleStreamEvent,
  ThreadId,
  UsageLimitSourceId,
  WS_METHODS,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as AcpErrors from "effect-acp/errors";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { HttpBody, HttpClient } from "effect/http";
import { vi } from "vite-plus/test";
import { type DroidAcpRuntime } from "./provider/acp/DroidAcpSupport.ts";
import { droidCustomModelId } from "./provider/droid/DroidCustomModels.ts";
import { makeDroidTextGeneration } from "./textGeneration/DroidTextGeneration.ts";
import { coalesceProviderStatusUpdates } from "./ws.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeNativeSessionAdapterV2 } from "./orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { type ProviderAuthController } from "./provider/ProviderAuthService.ts";
import { AntigravityInstallationError } from "./provider/AntigravityInstallation.ts";
import { type ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ASSET_ROUTE_PREFIX } from "./assets/AssetAccess.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import {
  NodeHttpServerTest,
  appendSessionCookieToWsUrl,
  assertBrowserApiCorsResponseHeaders,
  buildAppUnderTest,
  crossOriginClientOrigin,
  decodeDroidSettings,
  defaultDesktopBootstrapToken,
  defaultModelSelection,
  encodeTestJson,
  exchangeAccessToken,
  fetchEffect,
  getAuthenticatedBearerSessionToken,
  getAuthenticatedSessionCookieHeader,
  getHttpServerUrl,
  getWsServerUrl,
  jsonRequestBody,
  makeBrowserOtlpPayload,
  nativeAdmissionInstance,
  providerSetupAuthState,
  providerSetupDriver,
  providerSetupInstallState,
  providerSetupInstance,
  providerSetupInstanceId,
  readAuthAccessSnapshot,
  responseJsonEffect,
  seedV2StreamThread,
  splitHeaderTokens,
  testEnvironmentDescriptor,
  withWsRpcClient,
} from "./server.testkit.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "server router seam: rpc",
  (it) => {
    it.effect(
      "accepts websocket rpc handshake with a dedicated websocket ticket in the query string",
      () =>
        Effect.gen(function* () {
          yield* buildAppUnderTest();

          const bearerToken = yield* getAuthenticatedBearerSessionToken();
          const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
          const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearerToken}`,
            },
          });
          const wsTicketBody = yield* responseJsonEffect<{
            readonly ticket: string;
          }>(wsTicketResponse);
          const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;

          const response = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
          );

          assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
          assert.equal(response.auth.policy, "desktop-managed-local");
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each([
      {
        caseTitle: "rejects browser OTLP exports from an undeclared origin by default",
        trustedDevOrigin: false,
      },
      {
        caseTitle: "proxies browser OTLP trace exports through the server",
        trustedDevOrigin: true,
      },
    ])("$caseTitle", ({ trustedDevOrigin }) =>
      Effect.gen(function* () {
        const clientOrigin = "http://localhost:5733";
        const upstreamRequests: Array<{
          readonly body: string;
          readonly contentType: string | null;
        }> = [];
        const localTraceRecords: Array<unknown> = [];
        const payload = {
          resourceSpans: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: "t3code-web" },
                  },
                ],
              },
              scopeSpans: [
                {
                  scope: {
                    name: "effect",
                    version: "4.0.0-beta.43",
                  },
                  spans: [
                    {
                      traceId: "11111111111111111111111111111111",
                      spanId: "2222222222222222",
                      parentSpanId: "3333333333333333",
                      name: "RpcClient.server.getSettings",
                      kind: 3,
                      startTimeUnixNano: "1000000",
                      endTimeUnixNano: "2000000",
                      attributes: [
                        {
                          key: "rpc.method",
                          value: { stringValue: "server.getSettings" },
                        },
                      ],
                      events: [
                        {
                          name: "http.request",
                          timeUnixNano: "1500000",
                          attributes: [
                            {
                              key: "http.status_code",
                              value: { intValue: "200" },
                            },
                          ],
                        },
                      ],
                      links: [],
                      status: {
                        code: "STATUS_CODE_OK",
                      },
                      flags: 1,
                    },
                  ],
                },
              ],
            },
          ],
        };

        const collector = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const NodeHttp = await import("node:http");

            return await new Promise<{
              readonly close: () => Promise<void>;
              readonly url: string;
            }>((resolve, reject) => {
              const server = NodeHttp.createServer((request, response) => {
                const chunks: Buffer[] = [];
                request.on("data", (chunk) => {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                request.on("end", () => {
                  upstreamRequests.push({
                    body: Buffer.concat(chunks).toString("utf8"),
                    contentType: request.headers["content-type"] ?? null,
                  });
                  response.statusCode = 204;
                  response.end();
                });
              });

              server.on("error", reject);
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                  reject(new Error("Expected TCP collector address"));
                  return;
                }

                resolve({
                  url: `http://127.0.0.1:${address.port}/v1/traces`,
                  close: () =>
                    new Promise<void>((resolveClose, rejectClose) => {
                      server.close((error) => {
                        if (error) {
                          rejectClose(error);
                          return;
                        }
                        resolveClose();
                      });
                    }),
                });
              });
            });
          }),
          ({ close }) => Effect.promise(close),
        );

        yield* buildAppUnderTest({
          config: {
            otlpTracesUrl: collector.url,
            ...(trustedDevOrigin ? { devUrl: new URL(clientOrigin) } : {}),
          },
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const cookie = yield* getAuthenticatedSessionCookieHeader();
        const rejected = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie,
            "content-type": "application/json",
            origin: trustedDevOrigin ? "http://localhost:5734" : clientOrigin,
          },
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });
        assert.equal(rejected.status, 401);
        assert.propertyVal(yield* rejected.json, "reason", "invalid_credential");
        assert.deepEqual(localTraceRecords, []);
        assert.deepEqual(upstreamRequests, []);
        if (!trustedDevOrigin) return;

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie,
            "content-type": "application/json",
            origin: clientOrigin,
          },
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204, yield* response.text);
        assert.equal(response.headers["access-control-allow-origin"], clientOrigin);
        assert.equal(response.headers["access-control-allow-credentials"], "true");
        assert.deepEqual(localTraceRecords, [
          {
            type: "otlp-span",
            name: "RpcClient.server.getSettings",
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            parentSpanId: "3333333333333333",
            sampled: true,
            kind: "client",
            startTimeUnixNano: "1000000",
            endTimeUnixNano: "2000000",
            durationMs: 1,
            attributes: {
              "rpc.method": "server.getSettings",
            },
            resourceAttributes: {
              "service.name": "t3code-web",
            },
            scope: {
              name: "effect",
              version: "4.0.0-beta.43",
              attributes: {},
            },
            events: [
              {
                name: "http.request",
                timeUnixNano: "1500000",
                attributes: {
                  "http.status_code": "200",
                },
              },
            ],
            links: [],
            status: {
              code: "STATUS_CODE_OK",
            },
          },
        ]);
        assert.deepEqual(upstreamRequests, [
          {
            body: jsonRequestBody(payload),
            contentType: "application/json",
          },
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("forwards browser OTLP traces as protobuf when the protocol is http/protobuf", () =>
      Effect.gen(function* () {
        const upstreamRequests: Array<{
          readonly body: string;
          readonly contentType: string | null;
        }> = [];
        const localTraceRecords: Array<unknown> = [];
        // Produced by effect's own tracer, so enum fields are numeric and the
        // protobuf encoder accepts them. The hand-written payload in the JSON
        // test uses enum names, which only the JSON path tolerates.
        const payload = yield* makeBrowserOtlpPayload("client.protobuf.test");

        const collector = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const NodeHttp = await import("node:http");

            return await new Promise<{
              readonly close: () => Promise<void>;
              readonly url: string;
            }>((resolve, reject) => {
              const server = NodeHttp.createServer((request, response) => {
                const chunks: Buffer[] = [];
                request.on("data", (chunk) => {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                request.on("end", () => {
                  upstreamRequests.push({
                    body: Buffer.concat(chunks).toString("utf8"),
                    contentType: request.headers["content-type"] ?? null,
                  });
                  response.statusCode = 204;
                  response.end();
                });
              });

              server.on("error", reject);
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                  reject(new Error("Expected TCP collector address"));
                  return;
                }

                resolve({
                  url: `http://127.0.0.1:${address.port}/v1/traces`,
                  close: () =>
                    new Promise<void>((resolveClose, rejectClose) => {
                      server.close((error) => {
                        if (error) {
                          rejectClose(error);
                          return;
                        }
                        resolveClose();
                      });
                    }),
                });
              });
            });
          }),
          ({ close }) => Effect.promise(close),
        );

        yield* buildAppUnderTest({
          config: {
            otlpTracesUrl: collector.url,
            otlpTracesExport: { ...DEFAULT_SIGNAL_EXPORT, protocol: "http/protobuf" },
          },
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
          },
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204);
        // The local collector still decodes the browser's JSON before forwarding.
        assert.equal(localTraceRecords.length, 1);
        assert.equal(upstreamRequests.length, 1);
        const forwarded = upstreamRequests[0];
        assert.notEqual(forwarded, undefined);
        if (!forwarded) {
          return;
        }
        assert.equal(forwarded.contentType, "application/x-protobuf");
        // Protobuf strings are raw UTF-8, so the span and service names survive
        // the stub's utf8 decode even though the surrounding bytes don't.
        assert.notEqual(forwarded.body[0], "{");
        assert.include(forwarded.body, "client.protobuf.test");
        assert.include(forwarded.body, "t3code-web");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("responds to browser OTLP trace preflight requests with CORS headers", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const response = yield* HttpClient.options("/api/observability/v1/traces", {
          headers: {
            origin: "http://localhost:5733",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        });

        assert.equal(response.status, 204);
        assert.equal(response.headers["access-control-allow-origin"], "*");
        assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-methods"]), [
          "GET",
          "HEAD",
          "OPTIONS",
          "POST",
        ]);
        assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-headers"]), [
          "authorization",
          "b3",
          "content-type",
          "dpop",
          "range",
          "traceparent",
          ORCHESTRATION_PROTOCOL_HEADER,
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "stores browser OTLP trace exports locally when no upstream collector is configured",
      () =>
        Effect.gen(function* () {
          const localTraceRecords: Array<unknown> = [];
          const payload = yield* makeBrowserOtlpPayload("client.test");
          const resourceSpan = payload.resourceSpans[0];
          const scopeSpan = resourceSpan?.scopeSpans[0];
          const span = scopeSpan?.spans[0];

          assert.notEqual(resourceSpan, undefined);
          assert.notEqual(scopeSpan, undefined);
          assert.notEqual(span, undefined);
          if (!resourceSpan || !scopeSpan || !span) {
            return;
          }

          yield* buildAppUnderTest({
            layers: {
              browserTraceCollector: {
                record: (records) =>
                  Effect.sync(() => {
                    localTraceRecords.push(...records);
                  }),
              },
            },
          });

          const response = yield* HttpClient.post("/api/observability/v1/traces", {
            headers: {
              cookie: yield* getAuthenticatedSessionCookieHeader(),
              "content-type": "application/json",
            },
            body: HttpBody.text(JSON.stringify(payload), "application/json"),
          });

          assert.equal(response.status, 204);
          assert.equal(localTraceRecords.length, 1);
          const record = localTraceRecords[0] as {
            readonly type: string;
            readonly name: string;
            readonly traceId: string;
            readonly spanId: string;
            readonly kind: string;
            readonly attributes: Readonly<Record<string, unknown>>;
            readonly events: ReadonlyArray<unknown>;
            readonly links: ReadonlyArray<unknown>;
            readonly scope: {
              readonly name?: string;
              readonly attributes: Readonly<Record<string, unknown>>;
            };
            readonly resourceAttributes: Readonly<Record<string, unknown>>;
            readonly status?: {
              readonly code?: string;
            };
          };

          assert.equal(record.type, "otlp-span");
          assert.equal(record.name, span.name);
          assert.equal(record.traceId, span.traceId);
          assert.equal(record.spanId, span.spanId);
          assert.equal(record.kind, "internal");
          assert.deepEqual(record.attributes, {});
          assert.deepEqual(record.events, []);
          assert.deepEqual(record.links, []);
          assert.equal(record.scope.name, scopeSpan.scope.name);
          assert.deepEqual(record.scope.attributes, {});
          assert.equal(record.resourceAttributes["service.name"], "t3code-web");
          assert.equal(record.status?.code, String(span.status.code));
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("routes custom model mutations without returning the API key", () =>
      Effect.gen(function* () {
        let catalog: CustomModelsSettings = { revision: 0, connections: [] };
        yield* buildAppUnderTest({
          layers: {
            scientServerSettings: {
              saveCustomModel: (input) =>
                Effect.sync(() => {
                  assert.equal(Redacted.value(input.apiKey!), "synthetic-wire-key");
                  catalog = {
                    revision: input.revision + 1,
                    connections: [{ ...input.connection, credentialId: "opaque-ref" }],
                  };
                  return catalog;
                }),
              removeCustomModel: (input) =>
                Effect.sync(() => {
                  assert.equal(input.connectionId, "wire-connection");
                  assert.equal(input.revision, 1);
                  catalog = { revision: 2, connections: [] };
                  return catalog;
                }),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const saved = yield* client[WS_METHODS.serverSaveCustomModel]({
                revision: 0,
                apiKey: Redacted.make("synthetic-wire-key"),
                connection: {
                  id: "wire-connection",
                  name: "Wire test",
                  protocol: "openai-completions",
                  baseUrl: "http://127.0.0.1:8080/v1",
                  models: [],
                },
              });
              assert.deepEqual(saved, catalog);
              assert.notProperty(saved.connections[0], "apiKey");
              const removed = yield* client[WS_METHODS.serverRemoveCustomModel]({
                revision: 1,
                connectionId: "wire-connection",
              });
              assert.deepEqual(removed, { revision: 2, connections: [] });
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("requires operate scope for every custom model mutation and connection test", () =>
      Effect.gen(function* () {
        const id = ProviderInstanceId.make("droid");
        const catalog: CustomModelsSettings = {
          revision: 1,
          connections: [
            {
              id: "wire-connection",
              name: "Wire test",
              baseUrl: "https://example.test/v1",
              protocol: "openai-completions",
              credentialId: "opaque-ref",
              models: [
                {
                  id: "one",
                  modelId: "one",
                  name: "One",
                  configurationMode: "automatic",
                  contextWindow: 32000,
                  maxOutputTokens: 128,
                  images: false,
                  reasoning: false,
                  instanceIds: [id],
                },
              ],
            },
          ],
        };
        const calls = { reads: 0, saves: 0, removes: 0, resolves: 0, generations: 0 };
        const instance: ProviderInstance = {
          instanceId: id,
          driverKind: ProviderDriverKind.make("droid"),
          enabled: true,
          displayName: "Droid",
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("droid"),
            continuationKey: id,
          },
          get orchestrationAdapter(): never {
            throw new Error("Must not start a chat session");
          },
          get snapshot(): never {
            throw new Error("Must not probe a provider");
          },
          textGeneration: {
            generateThreadTitle: () =>
              Effect.sync(() => {
                calls.generations += 1;
                return { title: "Synthetic connection test" };
              }),
            generateBranchName: (): never => {
              throw new Error("Unexpected generation");
            },
            generateCommitMessage: (): never => {
              throw new Error("Unexpected generation");
            },
            generateReviewGuide: (): never => {
              throw new Error("Unexpected review guide generation");
            },
            generateTranscriptionPostProcessing: (): never => {
              throw new Error("Unexpected transcript cleanup");
            },
            generatePrContent: (): never => {
              throw new Error("Unexpected generation");
            },
          },
        };
        yield* buildAppUnderTest({
          layers: {
            serverSettings: {
              getSettings: Effect.sync(() => {
                calls.reads += 1;
                return { ...DEFAULT_SERVER_SETTINGS, customModels: catalog };
              }),
            },
            scientServerSettings: {
              saveCustomModel: () =>
                Effect.sync(() => {
                  calls.saves += 1;
                  return catalog;
                }),
              removeCustomModel: () =>
                Effect.sync(() => {
                  calls.removes += 1;
                  return catalog;
                }),
              resolveCustomModels: () =>
                Effect.sync(() => {
                  calls.resolves += 1;
                  return [{ ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") }];
                }),
            },
            providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
          },
        });
        const token = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "orchestration:read",
        });
        assert.equal(token.response.status, 200);
        const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
          headers: { authorization: `Bearer ${token.body.access_token ?? ""}` },
        });
        assert.equal(ticketResponse.status, 200);
        const { ticket } = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
        const readerUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(ticket)}`;
        const save = {
          revision: 1,
          connection: catalog.connections[0]!,
          apiKey: Redacted.make("synthetic-key"),
        };
        const remove = { revision: 1, connectionId: "wire-connection" };
        const test = {
          revision: 1,
          connectionId: "wire-connection",
          modelId: "one",
          instanceId: id,
        };
        yield* Effect.scoped(
          withWsRpcClient(readerUrl, (client) =>
            Effect.gen(function* () {
              const readable = yield* client[WS_METHODS.serverGetConfig]({});
              assert.equal(readable.settings.customModels.revision, 1);
              const before = { ...calls };
              const results = [
                yield* client[WS_METHODS.serverSaveCustomModel](save).pipe(Effect.result),
                yield* client[WS_METHODS.serverRemoveCustomModel](remove).pipe(Effect.result),
                yield* client[WS_METHODS.serverTestCustomModel](test).pipe(Effect.result),
                // A stale revision must still be denied before configuration reads.
                yield* client[WS_METHODS.serverTestCustomModel]({ ...test, revision: 2 }).pipe(
                  Effect.result,
                ),
              ];
              // The first three inputs are valid and attached: a setup error cannot conceal a missing guard.
              assert.deepEqual(calls, before);
              for (const result of results) {
                if (
                  result._tag !== "Failure" ||
                  result.failure._tag !== "EnvironmentAuthorizationError"
                )
                  assert.fail("Expected an operate-scope denial before any custom model effect");
                assert.equal(result.failure.requiredScope, "orchestration:operate");
              }
              assert.equal(
                (yield* client[WS_METHODS.serverGetConfig]({})).settings.customModels.revision,
                1,
              );
            }),
          ),
        );
        const operatorUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(operatorUrl, (client) =>
            Effect.gen(function* () {
              assert.deepEqual(yield* client[WS_METHODS.serverSaveCustomModel](save), catalog);
              assert.deepEqual(yield* client[WS_METHODS.serverRemoveCustomModel](remove), catalog);
              assert.deepEqual(yield* client[WS_METHODS.serverTestCustomModel](test), {
                revision: 1,
              });
              assert.equal(
                (yield* client[WS_METHODS.serverGetConfig]({})).settings.customModels.revision,
                1,
              );
            }),
          ),
        );
        assert.deepEqual(
          {
            saves: calls.saves,
            removes: calls.removes,
            resolves: calls.resolves,
            generations: calls.generations,
          },
          { saves: 1, removes: 1, resolves: 1, generations: 1 },
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects stale or unattached custom model tests through websocket rpc", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              for (const revision of [1, 0]) {
                const result = yield* client[WS_METHODS.serverTestCustomModel]({
                  revision,
                  connectionId: "missing",
                  modelId: "missing",
                  instanceId: ProviderInstanceId.make("pi"),
                }).pipe(Effect.result);
                if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
                  assert.fail("Expected a custom model setup error");
                assert.equal(
                  result.failure.message,
                  revision === 1
                    ? "Custom models changed. Test the updated configuration."
                    : "Connect this model to an enabled Pi, Droid, Oh My Pi, or Scient agent first.",
                );
              }
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each(
      [false, true].map((missingCapacity) => ({
        caseTitle: missingCapacity
          ? "delegates an explicit automatic-model test to Droid without requiring Scient limits"
          : "reports a missing custom model key before starting a paid test",
        missingCapacity,
      })),
    )("$caseTitle", ({ missingCapacity }) =>
      Effect.gen(function* () {
        const driver = missingCapacity ? "droid" : "pi";
        let generated = 0;
        const id = ProviderInstanceId.make(driver);
        const catalog: CustomModelsSettings = {
          revision: 1,
          connections: [
            {
              id: "broken",
              name: "Broken",
              baseUrl: "https://example.test/v1",
              protocol: "openai-completions",
              credentialId: "missing",
              models: [
                {
                  id: "one",
                  modelId: "one",
                  name: "One",
                  ...(missingCapacity ? { configurationMode: "automatic" as const } : {}),
                  contextWindow: 32000,
                  maxOutputTokens: 128,
                  images: false,
                  reasoning: false,
                  instanceIds: [id],
                },
              ],
            },
          ],
        };
        const message = "Re-enter the API key for Broken in Custom models.";
        const instance: ProviderInstance = {
          instanceId: id,
          driverKind: ProviderDriverKind.make(driver),
          enabled: true,
          displayName: "Pi",
          continuationIdentity: {
            driverKind: ProviderDriverKind.make(driver),
            continuationKey: id,
          },
          get orchestrationAdapter(): never {
            throw new Error("This fixture must not start a V2 chat session");
          },
          get snapshot(): never {
            throw new Error("Must not probe");
          },
          get textGeneration() {
            if (!missingCapacity) throw new Error("Must not make a paid request");
            return {
              generateThreadTitle: () =>
                Effect.sync(() => {
                  generated += 1;
                  return { title: "Synthetic test" };
                }),
              generateBranchName: (): never => {
                throw new Error("Unexpected generation");
              },
              generateCommitMessage: (): never => {
                throw new Error("Unexpected generation");
              },
              generateReviewGuide: (): never => {
                throw new Error("Unexpected review guide generation");
              },
              generateTranscriptionPostProcessing: (): never => {
                throw new Error("Unexpected transcript cleanup");
              },
              generatePrContent: (): never => {
                throw new Error("Unexpected generation");
              },
            };
          },
        };
        yield* buildAppUnderTest({
          layers: {
            serverSettings: {
              getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
            },
            scientServerSettings: {
              resolveCustomModels: () =>
                Effect.succeed([
                  missingCapacity
                    ? { ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") }
                    : { ...catalog.connections[0]!, credentialError: message },
                ]),
            },
            providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.serverTestCustomModel]({
              revision: 1,
              connectionId: "broken",
              modelId: "one",
              instanceId: id,
            }).pipe(Effect.result),
          ),
        );
        if (missingCapacity) {
          assert.equal(result._tag, "Success");
          assert.equal(generated, 1);
          return;
        }
        if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
          assert.fail("Expected a credential setup error");
        assert.equal(result.failure.message, message);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "returns actionable ACP model-test failures without disconnecting websocket rpc",
      () =>
        Effect.gen(function* () {
          const id = ProviderInstanceId.make("droid");
          const catalog: CustomModelsSettings = {
            revision: 1,
            connections: [
              {
                id: "openrouter",
                name: "OpenRouter",
                baseUrl: "https://openrouter.ai/api/v1",
                protocol: "openai-completions",
                credentialId: "saved-key",
                models: [
                  {
                    id: "restricted",
                    modelId: "meta/muse-spark-1.3",
                    name: "Muse Spark 1.3",
                    images: false,
                    reasoning: false,
                    instanceIds: [id],
                  },
                ],
              },
            ],
          };
          const providerFailure = new AcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: "Internal error: Agent error",
            data: "403 Complete 18+ age confirmation in OpenRouter settings.",
          });
          const instance: ProviderInstance = {
            instanceId: id,
            driverKind: ProviderDriverKind.make("droid"),
            enabled: true,
            displayName: "Droid",
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("droid"),
              continuationKey: id,
            },
            get orchestrationAdapter(): never {
              throw new Error("This fixture must not start a V2 chat session");
            },
            get snapshot(): never {
              throw new Error("Must not probe");
            },
            textGeneration: {
              generateThreadTitle: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: "generateThreadTitle",
                    detail: "Droid ACP request failed.",
                    cause: providerFailure,
                  }),
                ),
              generateBranchName: (): never => {
                throw new Error("Unexpected generation");
              },
              generateCommitMessage: (): never => {
                throw new Error("Unexpected generation");
              },
              generateReviewGuide: (): never => {
                throw new Error("Unexpected review guide generation");
              },
              generateTranscriptionPostProcessing: (): never => {
                throw new Error("Unexpected transcript cleanup");
              },
              generatePrContent: (): never => {
                throw new Error("Unexpected generation");
              },
            },
          };
          yield* buildAppUnderTest({
            layers: {
              serverSettings: {
                getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
              },
              scientServerSettings: {
                resolveCustomModels: () =>
                  Effect.succeed([
                    { ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") },
                  ]),
              },
              providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
            },
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const result = yield* client[WS_METHODS.serverTestCustomModel]({
                  revision: 1,
                  connectionId: "openrouter",
                  modelId: "restricted",
                  instanceId: id,
                }).pipe(Effect.result);
                if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
                  assert.fail("Expected an actionable model-test failure");
                assert.equal(
                  result.failure.message,
                  "Droid: 403 Complete 18+ age confirmation in OpenRouter settings.",
                );

                const config = yield* client[WS_METHODS.serverGetConfig]({});
                assert.equal(config.settings.customModels.revision, 1);
              }),
            ),
          );
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "says why Droid ran no custom model test when its tool blocking is not confirmed",
      () =>
        Effect.gen(function* () {
          const id = ProviderInstanceId.make("droid");
          const catalog: CustomModelsSettings = {
            revision: 1,
            connections: [
              {
                id: "lab",
                name: "Lab",
                baseUrl: "http://127.0.0.1:1/v1",
                protocol: "openai-completions",
                credentialId: "saved-key",
                models: [
                  {
                    id: "one",
                    modelId: "one",
                    name: "One",
                    images: false,
                    reasoning: false,
                    instanceIds: [id],
                  },
                ],
              },
            ],
          };
          const slug = droidCustomModelId("lab", "one");
          let prompts = 0;
          const current: Record<string, string> = {
            autonomy_level: "auto-high",
            model: "gpt-5.6-sol",
          };
          // Droid's own background generation, in a process whose organization
          // policy dropped the hook that refuses tool calls.
          const textGeneration = yield* makeDroidTextGeneration(
            yield* decodeDroidSettings({ binaryPath: "droid" }),
            {},
            () =>
              Effect.sync(
                () =>
                  ({
                    handleSessionUpdate: () => Effect.void,
                    handleRequestPermission: () => Effect.void,
                    handleElicitation: () => Effect.void,
                    start: () => Effect.succeed({}),
                    getConfigOptions: Effect.sync(() => [
                      {
                        id: "autonomy_level",
                        name: "Autonomy",
                        type: "select" as const,
                        currentValue: current.autonomy_level,
                        options: ["normal", "auto-high"].map((value) => ({ value, name: value })),
                      },
                      {
                        id: "model",
                        name: "Model",
                        category: "model",
                        type: "select" as const,
                        currentValue: current.model,
                        options: ["gpt-5.6-sol", slug].map((value) => ({ value, name: value })),
                      },
                    ]),
                    setConfigOption: (configId: string, value: string) =>
                      Effect.sync(() => {
                        current[configId] = value;
                        return {};
                      }),
                    setModel: (model: string) =>
                      Effect.sync(() => {
                        current.model = model;
                      }),
                    backgroundToolGuard: () => Effect.succeed("disabled-by-policy" as const),
                    prompt: () =>
                      Effect.sync(() => {
                        prompts += 1;
                        return { stopReason: "end_turn" as const };
                      }),
                  }) as unknown as DroidAcpRuntime,
              ),
          ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)));
          const instance: ProviderInstance = {
            instanceId: id,
            driverKind: ProviderDriverKind.make("droid"),
            enabled: true,
            displayName: "Droid",
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("droid"),
              continuationKey: id,
            },
            get orchestrationAdapter(): never {
              throw new Error("This fixture must not start a V2 chat session");
            },
            get snapshot(): never {
              throw new Error("Must not probe");
            },
            textGeneration,
          };
          yield* buildAppUnderTest({
            layers: {
              serverSettings: {
                getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
              },
              scientServerSettings: {
                resolveCustomModels: () =>
                  Effect.succeed([
                    { ...catalog.connections[0]!, apiKey: Redacted.make("synthetic-key") },
                  ]),
              },
              providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
            },
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          const result = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.serverTestCustomModel]({
                revision: 1,
                connectionId: "lab",
                modelId: "one",
                instanceId: id,
              }).pipe(Effect.result),
            ),
          );
          if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
            assert.fail("Expected the test to be refused");
          // The Test runs through background generation, so it is refused too, in its own words.
          assert.equal(
            result.failure.message,
            "Droid: Your organization's Droid policy disables Scient's tool blocking, which the test needs, so the test was not run. To try this model, send a message in a Droid thread.",
          );
          assert.equal(prompts, 0);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("says a custom model test timed out and names the agent", () =>
      Effect.gen(function* () {
        const id = ProviderInstanceId.make("droid_work");
        const catalog: CustomModelsSettings = {
          revision: 1,
          connections: [
            {
              id: "slow",
              name: "Slow",
              baseUrl: "http://127.0.0.1:1/v1",
              protocol: "openai-completions",
              credentialId: null,
              models: [
                {
                  id: "one",
                  modelId: "one",
                  name: "One",
                  images: false,
                  reasoning: false,
                  instanceIds: [id],
                },
              ],
            },
          ],
        };
        const started = yield* Deferred.make<void>();
        const deadlineRegistered = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        const instance: ProviderInstance = {
          instanceId: id,
          driverKind: ProviderDriverKind.make("droid"),
          enabled: true,
          displayName: "Droid work",
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("droid"),
            continuationKey: id,
          },
          get orchestrationAdapter(): never {
            throw new Error("This fixture must not start a V2 chat session");
          },
          get snapshot(): never {
            throw new Error("Must not probe");
          },
          textGeneration: {
            generateThreadTitle: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(cancelled, undefined)),
              ),
            generateBranchName: (): never => {
              throw new Error("Unexpected generation");
            },
            generateCommitMessage: (): never => {
              throw new Error("Unexpected generation");
            },
            generateReviewGuide: (): never => {
              throw new Error("Unexpected review guide generation");
            },
            generateTranscriptionPostProcessing: (): never => {
              throw new Error("Unexpected transcript cleanup");
            },
            generatePrContent: (): never => {
              throw new Error("Unexpected generation");
            },
          },
        };
        yield* buildAppUnderTest({
          layers: {
            serverSettings: {
              getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, customModels: catalog }),
            },
            scientServerSettings: {
              resolveCustomModels: () =>
                Effect.succeed([{ ...catalog.connections[0]!, apiKey: null }]),
            },
            providerInstanceRegistry: { getInstance: () => Effect.succeed(instance) },
          },
        }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              Duration.toMillis(duration) === 45_000
                ? clock.sleep(duration).pipe(
                    Effect.forkChild({ startImmediately: true }),
                    Effect.tap(() => Deferred.succeed(deadlineRegistered, undefined)),
                    Effect.flatMap(Fiber.join),
                  )
                : clock.sleep(duration),
          }),
        );
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const pending = yield* client[WS_METHODS.serverTestCustomModel]({
                revision: 1,
                connectionId: "slow",
                modelId: "one",
                instanceId: id,
              }).pipe(Effect.result, Effect.forkChild);
              yield* Deferred.await(started);
              // The RPC server owns this timer. Observe its registration before advancing it.
              yield* Deferred.await(deadlineRegistered);
              yield* TestClock.adjust("44999 millis");
              assert.isFalse(yield* Deferred.isDone(cancelled));
              yield* TestClock.adjust("1 millis");
              yield* Deferred.await(cancelled);
              return yield* Fiber.join(pending);
            }),
          ),
        );
        if (result._tag !== "Failure" || result.failure._tag !== "CustomModelError")
          assert.fail("Expected a timed-out test");
        assert.equal(result.failure.message, "Droid work: No response within 45 s.");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("keeps agent session import project failures structured over websocket rpc", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const projectId = ProjectId.make("missing-import-project");
        const wsUrl = yield* getWsServerUrl("/ws");
        const error = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.agentSessionsImport]({ projectId }).pipe(Effect.flip),
          ),
        );

        assert.equal(error._tag, "AgentSessionImportProjectNotFoundError");
        if (error._tag === "AgentSessionImportProjectNotFoundError") {
          assert.equal(error.projectId, projectId);
        }
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("returns scanner skip counts over websocket rpc", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-import-rpc-codex-",
        });
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-agent-import-rpc-workspace-",
        });
        const transcriptDirectory = path.join(codexHome, "sessions", "2026", "08", "31");
        const transcriptPath = path.join(transcriptDirectory, "rollout-skipped.jsonl");
        yield* fileSystem.makeDirectory(transcriptDirectory, { recursive: true });
        // A reply with no user turn cannot be imported; a session with no messages is not counted.
        yield* fileSystem.writeFileString(
          transcriptPath,
          [
            encodeTestJson({
              timestamp: "2026-08-31T12:00:00.000Z",
              type: "session_meta",
              payload: { id: "rpc-skipped-session", cwd: workspaceRoot },
            }),
            encodeTestJson({
              timestamp: "2026-08-31T12:00:01.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Orphaned reply" }],
              },
            }),
          ].join("\n"),
        );
        yield* fileSystem.utimes(transcriptPath, 0, 0);

        const projectId = ProjectId.make("agent-import-rpc-project");
        const app = yield* buildAppUnderTest({
          layers: {
            serverSettings: {
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                providerInstances: {
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: { homePath: codexHome },
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    enabled: false,
                    config: {},
                  },
                },
              }),
            },
          },
        });

        yield* app.v2.projects.create({
          commandId: CommandId.make("scanner-native-project"),
          projectId,
          title: "Agent import RPC",
          workspaceRoot,
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const scan = yield* client[WS_METHODS.agentSessionsScan]({});
              assert.deepEqual(
                scan.candidates.map((candidate) => candidate.path),
                [workspaceRoot],
              );
              return yield* client[WS_METHODS.agentSessionsImport]({ projectId });
            }),
          ),
        );

        assert.deepEqual(result, { importedCount: 0, skippedCount: 1 });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("uploads Codex thread feedback through websocket rpc", () =>
      Effect.gen(function* () {
        const input = {
          threadId: ThreadId.make("thread-feedback"),
          reason: "The agent stopped early.",
        };
        const uploadFeedback = vi.fn<
          NonNullable<ProviderAdapterV2SessionRuntime["uploadFeedback"]>
        >(() => Effect.succeed({ feedbackId: "codex-thread-feedback" }));
        let instance: ProviderInstance | undefined;
        const app = yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: (instanceId) =>
                Effect.succeed(
                  instanceId === defaultModelSelection.instanceId ? instance : undefined,
                ),
              listInstances: Effect.sync(() => (instance === undefined ? [] : [instance])),
            },
          },
        });
        const nativeAdapter = makeNativeSessionAdapterV2({
          instanceId: defaultModelSelection.instanceId,
          driver: ProviderDriverKind.make("codex"),
          idAllocator: app.v2.idAllocator,
          defaultCwd: app.cwd,
          capabilities: CodexProviderCapabilitiesV2,
          continuations: { offer: () => Effect.void },
          open: () =>
            Effect.succeed({
              nativeId: "controlled-feedback-thread",
              nativeThreadKnown: true,
              send: () => Effect.die("Feedback routing must not start a turn"),
              interrupt: Effect.void,
              respond: () => Effect.die("Feedback routing must not answer a request"),
              resume: () => Effect.void,
            }),
        });
        instance = {
          instanceId: nativeAdmissionInstance.instanceId,
          driverKind: nativeAdmissionInstance.driverKind,
          enabled: true,
          displayName: nativeAdmissionInstance.displayName,
          continuationIdentity: nativeAdmissionInstance.continuationIdentity,
          snapshot: nativeAdmissionInstance.snapshot,
          orchestrationAdapter: {
            ...nativeAdapter,
            openSession: (input) =>
              nativeAdapter
                .openSession(input)
                .pipe(Effect.map((runtime) => ({ ...runtime, uploadFeedback }))),
          },
          get textGeneration(): never {
            throw new Error("Feedback must not generate text");
          },
        };
        yield* seedV2StreamThread(app, input.threadId);
        const runtimePolicy = {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: app.cwd,
        };
        const runtime = yield* app.v2.providerSessions.open({
          threadId: input.threadId,
          providerSessionId: ProviderSessionId.make("feedback-session"),
          modelSelection: defaultModelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId: input.threadId,
          modelSelection: defaultModelSelection,
          runtimePolicy,
        });
        yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("feedback-provider-thread"),
              type: "provider-thread.updated",
              threadId: input.threadId,
              occurredAt: yield* DateTime.now,
              payload: providerThread,
            },
          ],
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.providerUploadFeedback](input)),
        );
        assert.deepStrictEqual(response, { feedbackId: "codex-thread-feedback" });
        const projection = yield* app.v2.threads.getThreadRecords(input.threadId, [
          "providerThreads",
        ]);
        const persistedProviderThread = projection.providerThreads.find(
          (row) => row.id === providerThread.id,
        );
        if (persistedProviderThread === undefined)
          return yield* Effect.die("Expected the feedback provider thread to be persisted");
        assert.deepStrictEqual(uploadFeedback.mock.calls, [
          [
            {
              providerThread: persistedProviderThread,
              reason: input.reason,
            },
          ],
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("serves absolute host media without a local thread and rejects relative media", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-host-media-" });
        const wsUrl = yield* getWsServerUrl("/ws");
        const threadId = ThreadId.make("thread-on-another-environment");

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              for (const [name, mimeType] of [
                ["screenshot.png", "image/png"],
                ["recording.mp4", "video/mp4"],
              ] as const) {
                const filePath = path.join(directory, name);
                yield* fileSystem.writeFileString(filePath, "host media bytes");
                const issued = yield* client[WS_METHODS.assetsCreateUrl]({
                  resource: { _tag: "media-file", threadId, path: filePath },
                });
                const response = yield* HttpClient.get(issued.relativeUrl);
                assert.equal(response.status, 200);
                assert.equal(response.headers["content-type"], mimeType);
                assert.equal(yield* response.text, "host media bytes");

                const error = yield* client[WS_METHODS.assetsCreateUrl]({
                  resource: { _tag: "media-file", threadId, path: name },
                }).pipe(Effect.flip);
                assert.equal(error._tag, "AssetWorkspaceContextResolutionError");
                assert.deepInclude(error, {
                  resource: { _tag: "media-file", threadId, path: name },
                });
              }
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("preserves signed HTML asset MIME types through HTTP compression", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-compressed-asset-",
        });
        const htmlPath = path.join(directory, "report.html");
        const stylePath = path.join(directory, "assets", "report.css");
        const scriptPath = path.join(directory, "assets", "report.js");
        const html = `<!doctype html><title>Compressed report</title><link rel="stylesheet" href="assets/report.css"><script src="assets/report.js"></script>${"<p>report body</p>".repeat(128)}`;
        const style = `.report { color: navy; }\n${"/* compressible style */\n".repeat(128)}`;
        const script = `document.body.dataset.ready = "true";\n${"// compressible script\n".repeat(128)}`;
        yield* fileSystem.makeDirectory(path.dirname(scriptPath), { recursive: true });
        yield* fileSystem.writeFileString(htmlPath, html);
        yield* fileSystem.writeFileString(stylePath, style);
        yield* fileSystem.writeFileString(scriptPath, script);

        const wsUrl = yield* getWsServerUrl("/ws");
        const issued = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "environment-file",
                path: EnvironmentFilePath.make(htmlPath),
                access: "html-document",
              },
            }),
          ),
        );
        const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const token = suffix.slice(0, suffix.indexOf("/"));
        const assetUrl = (assetPath: string) => `${ASSET_ROUTE_PREFIX}/${token}/${assetPath}`;

        for (const encoding of ["gzip", "br"] as const) {
          const requestHeaders = { "accept-encoding": encoding };
          const htmlResponse = yield* HttpClient.get(issued.relativeUrl, {
            headers: requestHeaders,
          });
          assert.equal(htmlResponse.status, 200);
          assert.equal(htmlResponse.headers["content-encoding"], encoding);
          assert.equal(htmlResponse.headers["content-type"], "text/html; charset=utf-8");
          assert.equal(
            htmlResponse.headers["content-security-policy"],
            "sandbox allow-scripts allow-forms allow-popups allow-downloads",
          );
          assert.equal(htmlResponse.headers["x-content-type-options"], "nosniff");
          assert.equal(yield* htmlResponse.text, html);

          const styleResponse = yield* HttpClient.get(assetUrl("assets/report.css"), {
            headers: requestHeaders,
          });
          assert.equal(styleResponse.status, 200);
          assert.equal(styleResponse.headers["content-encoding"], encoding);
          assert.match(styleResponse.headers["content-type"] ?? "", /^text\/css/);
          assert.equal(styleResponse.headers["x-content-type-options"], "nosniff");
          assert.equal(yield* styleResponse.text, style);

          const scriptResponse = yield* HttpClient.get(assetUrl("assets/report.js"), {
            headers: requestHeaders,
          });
          assert.equal(scriptResponse.status, 200);
          assert.equal(scriptResponse.headers["content-encoding"], encoding);
          assert.match(scriptResponse.headers["content-type"] ?? "", /javascript/);
          assert.equal(scriptResponse.headers["x-content-type-options"], "nosniff");
          assert.equal(yield* scriptResponse.text, script);
        }

        const headResponse = yield* HttpClient.head(issued.relativeUrl, {
          headers: { "accept-encoding": "identity" },
        });
        assert.equal(headResponse.status, 200);
        assert.equal(headResponse.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(headResponse.headers["content-length"], String(Buffer.byteLength(html)));
        assert.equal(yield* headResponse.text, "");

        const rangeResponse = yield* HttpClient.get(issued.relativeUrl, {
          headers: { "accept-encoding": "br, gzip", range: "bytes=0-14" },
        });
        assert.equal(rangeResponse.status, 206);
        assert.isUndefined(rangeResponse.headers["content-encoding"]);
        assert.equal(rangeResponse.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(
          rangeResponse.headers["content-range"],
          `bytes 0-14/${Buffer.byteLength(html)}`,
        );
        assert.equal(yield* rangeResponse.text, "<!doctype html>");
      }).pipe(Effect.provide(NodeHttpServerTest), Effect.scoped),
    );

    it.effect("serves draft workspace files without a thread", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const wsUrl = yield* getWsServerUrl("/ws");
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-draft-media-" });
        yield* fileSystem.writeFileString(path.join(directory, "note.html"), "<p>draft</p>");

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const issued = yield* client[WS_METHODS.assetsCreateUrl]({
                resource: { _tag: "draft-workspace-file", cwd: directory, path: "note.html" },
              });
              const response = yield* HttpClient.get(issued.relativeUrl);
              assert.equal(response.status, 200);
              assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
              assert.equal(yield* response.text, `<p>draft</p>${FILE_PREVIEW_SCROLL_SCRIPT}`);
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("uploads image bytes through a signed URL issued by websocket rpc", () =>
      Effect.gen(function* () {
        const config = yield* buildAppUnderTest();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const wsUrl = yield* getWsServerUrl("/ws");

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
                name: "screenshot.png",
                mimeType: "image/png",
                sizeBytes: 6,
              });
              const rejected = yield* HttpClient.post(issued.relativeUrl, {
                body: HttpBody.uint8Array(new Uint8Array([1, 2, 3]), "image/png"),
              });
              assert.equal(rejected.status, 400);

              const response = yield* HttpClient.post(issued.relativeUrl, {
                headers: { origin: crossOriginClientOrigin },
                body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
              });
              assert.equal(response.status, 204);
              assertBrowserApiCorsResponseHeaders(response.headers);

              const attachmentPath = path.join(config.attachmentsDir, `${issued.attachmentId}.png`);
              assert.isTrue(yield* fileSystem.exists(attachmentPath));

              yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: issued.attachmentId });
              assert.isFalse(yield* fileSystem.exists(attachmentPath));

              const streamed = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
                name: "streamed.png",
                mimeType: "image/png",
                sizeBytes: 6,
              });
              const streamedResponse = yield* HttpClient.post(streamed.relativeUrl, {
                body: HttpBody.stream(Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])), "image/png"),
              });
              assert.equal(streamedResponse.status, 204);
              yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: streamed.attachmentId });

              const uploadedFile = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
                type: "file",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 6,
              });
              const fileResponse = yield* HttpClient.post(uploadedFile.relativeUrl, {
                body: HttpBody.stream(
                  Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
                  "application/pdf",
                ),
              });
              assert.equal(fileResponse.status, 204);
              const uploadedFilePath = path.join(
                config.attachmentsDir,
                `${uploadedFile.attachmentId}.pdf`,
              );
              assert.isTrue(yield* fileSystem.exists(uploadedFilePath));

              // A mint that carries the attachment's display name and mime
              // serves a real download filename and Content-Type.
              const download = yield* client[WS_METHODS.assetsCreateUrl]({
                resource: {
                  _tag: "attachment",
                  attachmentId: uploadedFile.attachmentId,
                  fileName: "report.pdf",
                  mimeType: "application/pdf",
                },
              });
              const downloadResponse = yield* HttpClient.get(download.relativeUrl);
              assert.equal(downloadResponse.status, 200);
              assert.equal(
                downloadResponse.headers["content-disposition"],
                'attachment; filename="report.pdf"',
              );
              assert.equal(downloadResponse.headers["content-type"], "application/pdf");

              // Old clients mint without name or mime and still get a download.
              const bareDownload = yield* client[WS_METHODS.assetsCreateUrl]({
                resource: { _tag: "attachment", attachmentId: uploadedFile.attachmentId },
              });
              const bareResponse = yield* HttpClient.get(bareDownload.relativeUrl);
              assert.equal(bareResponse.status, 200);
              assert.equal(bareResponse.headers["content-disposition"], "attachment");
              assert.equal(bareResponse.headers["content-type"], "application/octet-stream");

              yield* client[WS_METHODS.attachmentsDelete]({
                attachmentId: uploadedFile.attachmentId,
              });
              assert.isFalse(yield* fileSystem.exists(uploadedFilePath));
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects an over-limit chunked upload through the route without hanging", () =>
      Effect.gen(function* () {
        const config = yield* buildAppUnderTest();
        const fileSystem = yield* FileSystem.FileSystem;
        const wsUrl = yield* getWsServerUrl("/ws");

        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
                type: "file",
                name: "big.bin",
                mimeType: "application/octet-stream",
                sizeBytes: 6,
              });
              const NodeHttp = yield* Effect.promise(() => import("node:http"));
              const uploadUrl = new URL(issued.relativeUrl, yield* getHttpServerUrl());
              const status = yield* Effect.callback<number, Error>((resume) => {
                let completed = false;
                const complete = (result: Effect.Effect<number, Error>) => {
                  if (completed) return;
                  completed = true;
                  resume(result);
                };
                const request = NodeHttp.request(
                  uploadUrl,
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/octet-stream",
                      "transfer-encoding": "chunked",
                    },
                  },
                  (response) => {
                    request.end();
                    response.resume();
                    response.once("end", () => complete(Effect.succeed(response.statusCode ?? 0)));
                    response.once("error", (error) => complete(Effect.fail(error)));
                  },
                );
                request.once("error", (error) => complete(Effect.fail(error)));
                request.flushHeaders();
                request.write(new Uint8Array(4), () => {
                  request.write(new Uint8Array(4));
                });

                return Effect.sync(() => request.destroy());
              });
              assert.equal(status, 400);
              assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), []);
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("keeps feedback errors structured across websocket rpc", () =>
      Effect.gen(function* () {
        const input = {
          threadId: ThreadId.make("thread-feedback-failure"),
          reason: "The agent failed to upload feedback.",
        };
        const threadId = input.threadId;
        const uploadFeedback = vi.fn<
          NonNullable<ProviderAdapterV2SessionRuntime["uploadFeedback"]>
        >(() =>
          Effect.fail(
            new ProviderAdapterProtocolError({
              driver: ProviderDriverKind.make("codex"),
              detail: "private provider detail",
            }),
          ),
        );
        let instance: ProviderInstance | undefined;
        const app = yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: (instanceId) =>
                Effect.succeed(
                  instanceId === defaultModelSelection.instanceId ? instance : undefined,
                ),
              listInstances: Effect.sync(() => (instance === undefined ? [] : [instance])),
            },
          },
        });
        const nativeAdapter = makeNativeSessionAdapterV2({
          instanceId: defaultModelSelection.instanceId,
          driver: ProviderDriverKind.make("codex"),
          idAllocator: app.v2.idAllocator,
          defaultCwd: app.cwd,
          capabilities: CodexProviderCapabilitiesV2,
          continuations: { offer: () => Effect.void },
          open: () =>
            Effect.succeed({
              nativeId: "controlled-feedback-failure-thread",
              nativeThreadKnown: true,
              send: () => Effect.die("Feedback routing must not start a turn"),
              interrupt: Effect.void,
              respond: () => Effect.die("Feedback routing must not answer a request"),
              resume: () => Effect.void,
            }),
        });
        instance = {
          instanceId: nativeAdmissionInstance.instanceId,
          driverKind: nativeAdmissionInstance.driverKind,
          enabled: true,
          displayName: nativeAdmissionInstance.displayName,
          continuationIdentity: nativeAdmissionInstance.continuationIdentity,
          snapshot: nativeAdmissionInstance.snapshot,
          orchestrationAdapter: {
            ...nativeAdapter,
            openSession: (input) =>
              nativeAdapter
                .openSession(input)
                .pipe(Effect.map((runtime) => ({ ...runtime, uploadFeedback }))),
          },
          get textGeneration(): never {
            throw new Error("Feedback must not generate text");
          },
        };
        yield* seedV2StreamThread(app, input.threadId);
        const runtimePolicy = {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: app.cwd,
        };
        const runtime = yield* app.v2.providerSessions.open({
          threadId: input.threadId,
          providerSessionId: ProviderSessionId.make("feedback-failure-session"),
          modelSelection: defaultModelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId: input.threadId,
          modelSelection: defaultModelSelection,
          runtimePolicy,
        });
        yield* app.v2.eventSink.write({
          events: [
            {
              id: EventId.make("feedback-failure-provider-thread"),
              type: "provider-thread.updated",
              threadId: input.threadId,
              occurredAt: yield* DateTime.now,
              payload: providerThread,
            },
          ],
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const error = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.providerUploadFeedback](input).pipe(Effect.flip),
          ),
        );

        assert.strictEqual(error._tag, "ProviderUploadFeedbackError");
        if (error._tag === "ProviderUploadFeedbackError") {
          assert.strictEqual(error.threadId, threadId);
          assert.strictEqual(error.message, `Failed to upload feedback for thread ${threadId}.`);
          assert.isDefined(error.cause);
        }
        const projection = yield* app.v2.threads.getThreadRecords(input.threadId, [
          "providerThreads",
        ]);
        const persistedProviderThread = projection.providerThreads.find(
          (row) => row.id === providerThread.id,
        );
        if (persistedProviderThread === undefined)
          return yield* Effect.die("Expected the feedback provider thread to be persisted");
        assert.deepStrictEqual(uploadFeedback.mock.calls, [
          [
            {
              providerThread: persistedProviderThread,
              reason: input.reason,
            },
          ],
        ]);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
        yield* fs.writeFileString(
          path.join(workspaceDir, "needle-file.ts"),
          "export const needle = 1;",
        );

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsSearchEntries]({
              cwd: workspaceDir,
              query: "needle",
              limit: 10,
            }),
          ).pipe(Effect.result),
        );

        assertTrue(result._tag === "Failure");
        const failureMessage = String(result.failure);
        assertTrue(
          failureMessage.includes("SocketOpenError") || failureMessage.includes("SocketCloseError"),
        );
        assertTrue(
          failureMessage.includes("Unauthorized") ||
            failureMessage.includes("An error occurred during Open"),
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("rejects dormant Codex subscription-sharing RPCs before starting auth", () =>
      Effect.gen(function* () {
        let authCalls = 0;
        yield* buildAppUnderTest({
          layers: {
            providerAuth: {
              start: () =>
                Effect.sync(() => {
                  authCalls += 1;
                  return providerSetupAuthState;
                }),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const exported = yield* client[WS_METHODS.chatGptReconnectProfile]({
                instanceId: providerSetupInstanceId,
                methodId: "chatgpt",
              }).pipe(Effect.flip);
              assert.equal(exported._tag, "ProviderSetupError");
              const handoff = yield* client[WS_METHODS.chatGptHandoffSubscribe]({
                instanceId: providerSetupInstanceId,
                environmentId: testEnvironmentDescriptor.environmentId,
                attemptId: "synthetic-handoff",
                returnUrl: "scient://auth-return",
                profile: null,
              }).pipe(Stream.runHead, Effect.flip);
              assert.equal(handoff._tag, "ProviderSetupError");
            }),
          ),
        );
        assert.equal(authCalls, 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "provider setup lets read-only clients observe installation but not change setup",
      () =>
        Effect.gen(function* () {
          let installStarts = 0;
          let authCalls = 0;
          yield* buildAppUnderTest({
            layers: {
              providerInstanceRegistry: {
                getInstance: (instanceId) =>
                  Effect.succeed(
                    instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
                  ),
              },
              antigravityInstallation: {
                start: Effect.sync(() => {
                  installStarts += 1;
                  return providerSetupInstallState;
                }),
                changes: Stream.succeed(providerSetupInstallState),
              },
              providerAuth: {
                start: () =>
                  Effect.sync(() => {
                    authCalls += 1;
                    return providerSetupAuthState;
                  }),
                subscribe: () =>
                  Stream.fromEffect(
                    Effect.sync(() => {
                      authCalls += 1;
                      return providerSetupAuthState;
                    }),
                  ),
              },
            },
          });
          const token = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
            scope: "orchestration:read",
          });
          assert.equal(token.response.status, 200);
          const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
            headers: { authorization: `Bearer ${token.body.access_token ?? ""}` },
          });
          const { ticket } = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
          const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}&wsTicket=${encodeURIComponent(ticket)}`;
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
                  instanceId: providerSetupInstanceId,
                }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
                assert.deepEqual(observed, providerSetupInstallState);
                const errors = [
                  yield* client[WS_METHODS.providerInstallStart]({
                    instanceId: providerSetupInstanceId,
                  }).pipe(Effect.flip),
                  yield* client[WS_METHODS.providerAuthStart]({
                    instanceId: providerSetupInstanceId,
                  }).pipe(Effect.flip),
                  yield* client[WS_METHODS.providerAuthSubscribe]({
                    instanceId: providerSetupInstanceId,
                  }).pipe(Stream.runHead, Effect.flip),
                ];
                for (const error of errors) {
                  assert.equal(error._tag, "EnvironmentAuthorizationError");
                  if (error._tag === "EnvironmentAuthorizationError") {
                    assert.equal(error.requiredScope, "orchestration:operate");
                  }
                }
              }),
            ),
          );
          assert.equal(installStarts, 0);
          assert.equal(authCalls, 0);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("provider setup binds private sign-in to the authenticated websocket session", () =>
      Effect.gen(function* () {
        const flowId = "private-sign-in-flow";
        const callbackUrl = "http://127.0.0.1:51234/?state=test-state&code=test-code";
        const waiting: ProviderAuthState = {
          ...providerSetupAuthState,
          phase: "waiting",
          flowId,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
          expiresAt: "2026-09-02T00:05:00.000Z",
        };
        const calls: Array<{
          readonly operation: string;
          readonly instanceId: ProviderInstanceId;
          readonly ownerSessionId: string;
        }> = [];
        const forwardedCallbacks: string[] = [];
        const logoutInstances: ProviderInstanceId[] = [];
        let flowOwner = "";
        const controller: ProviderAuthController = {
          start: (ownerSessionId) =>
            Effect.sync(() => {
              flowOwner = ownerSessionId;
              calls.push({
                operation: "start",
                instanceId: providerSetupInstanceId,
                ownerSessionId,
              });
              return waiting;
            }),
          subscribe: (ownerSessionId) =>
            Stream.fromEffect(
              Effect.sync(() => {
                calls.push({
                  operation: "subscribe",
                  instanceId: providerSetupInstanceId,
                  ownerSessionId,
                });
                return ownerSessionId === flowOwner
                  ? waiting
                  : { ...waiting, flowId: null, authorizationUrl: null, expiresAt: null };
              }),
            ),
          complete: (ownerSessionId, input) =>
            Effect.gen(function* () {
              calls.push({
                operation: "complete",
                instanceId: providerSetupInstanceId,
                ownerSessionId,
              });
              if (ownerSessionId !== flowOwner)
                return yield* new ProviderSetupError({
                  instanceId: providerSetupInstanceId,
                  operation: "complete",
                  detail: "This sign-in belongs to another client.",
                });
              assert.equal(input.flowId, flowId);
              forwardedCallbacks.push(input.callbackUrl);
              return { ...waiting, phase: "verifying" as const, authorizationUrl: null };
            }),
          cancel: (ownerSessionId, cancelledFlowId) =>
            Effect.sync(() => {
              assert.equal(cancelledFlowId, flowId);
              calls.push({
                operation: "cancel",
                instanceId: providerSetupInstanceId,
                ownerSessionId,
              });
              return { ...providerSetupAuthState, phase: "cancelled" as const, flowId };
            }),
          logout: (stopSessions) =>
            stopSessions.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  logoutInstances.push(providerSetupInstanceId);
                  return providerSetupAuthState;
                }),
              ),
            ),
        };
        const instance: ProviderInstance = {
          instanceId: providerSetupInstanceId,
          driverKind: providerSetupDriver,
          enabled: true,
          displayName: providerSetupInstance.displayName,
          continuationIdentity: providerSetupInstance.continuationIdentity,
          auth: controller,
          get orchestrationAdapter(): never {
            throw new Error("Sign-in must not open native sessions");
          },
          get snapshot(): never {
            throw new Error("Sign-in must not probe snapshots");
          },
          get textGeneration(): never {
            throw new Error("Sign-in must not generate text");
          },
        };
        const changes = yield* PubSub.unbounded<void>();
        yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === instance.instanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              subscribeChanges: PubSub.subscribe(changes),
            },
          },
        });
        const firstCookie = yield* getAuthenticatedSessionCookieHeader();
        const secondCookie = yield* getAuthenticatedSessionCookieHeader();
        const { clientSessions: firstClients } = yield* readAuthAccessSnapshot({
          cookie: firstCookie,
        });
        const { clientSessions: secondClients } = yield* readAuthAccessSnapshot({
          cookie: secondCookie,
        });
        const firstOwner = firstClients.find((session) => session.current)?.sessionId;
        const secondOwner = secondClients.find((session) => session.current)?.sessionId;
        assertTrue(firstOwner !== undefined && secondOwner !== undefined);
        assert.notEqual(firstOwner, secondOwner);
        const baseWsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const target = {
          instanceId: providerSetupInstanceId,
          ownerSessionId: "client-supplied-owner",
        };
        yield* Effect.scoped(
          withWsRpcClient(appendSessionCookieToWsUrl(baseWsUrl, firstCookie), (client) =>
            Effect.gen(function* () {
              const started = yield* client[WS_METHODS.providerAuthStart](target);
              assert.equal(started.flowId, flowId);
              const ownState = yield* client[WS_METHODS.providerAuthSubscribe](target).pipe(
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              );
              assert.equal(ownState.authorizationUrl, waiting.authorizationUrl);
              yield* Effect.scoped(
                withWsRpcClient(
                  appendSessionCookieToWsUrl(baseWsUrl, secondCookie),
                  (otherClient) =>
                    Effect.gen(function* () {
                      const otherState = yield* otherClient[WS_METHODS.providerAuthSubscribe](
                        target,
                      ).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
                      assert.isNull(otherState.authorizationUrl);
                      assert.isNull(otherState.flowId);
                      const forged = { ...target, ownerSessionId: firstOwner, flowId, callbackUrl };
                      const denied = yield* otherClient[WS_METHODS.providerAuthComplete](
                        forged,
                      ).pipe(Effect.flip);
                      assert.equal(denied._tag, "ProviderSetupError");
                      assert.deepEqual(forwardedCallbacks, []);
                    }),
                ),
              );
              const completed = yield* client[WS_METHODS.providerAuthComplete]({
                ...target,
                flowId,
                callbackUrl,
              });
              assert.equal(completed.phase, "verifying");
              const cancelled = yield* client[WS_METHODS.providerAuthCancel]({ ...target, flowId });
              assert.equal(cancelled.phase, "cancelled");
              const signedOut = yield* client[WS_METHODS.providerAuthLogout](target);
              assert.equal(signedOut.phase, "idle");
            }),
          ),
        );
        assert.deepEqual(forwardedCallbacks, [callbackUrl]);
        assert.deepEqual(logoutInstances, [providerSetupInstanceId]);
        assert.isTrue(calls.every((call) => call.instanceId === providerSetupInstanceId));
        assert.deepEqual(
          calls.map((call) => call.ownerSessionId),
          [firstOwner, firstOwner, secondOwner, secondOwner, firstOwner, firstOwner],
        );
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "provider setup routes installation operations and returns only safe typed errors",
      () =>
        Effect.gen(function* () {
          const calls: string[] = [];
          let state = providerSetupInstallState;
          yield* buildAppUnderTest({
            layers: {
              providerInstanceRegistry: {
                getInstance: (instanceId) =>
                  Effect.succeed(
                    instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
                  ),
              },
              antigravityInstallation: {
                start: Effect.sync(() => {
                  calls.push("start");
                  return state;
                }),
                cancel: (operationId) =>
                  Effect.gen(function* () {
                    calls.push(`cancel:${operationId}`);
                    if (operationId !== state.operationId) {
                      return yield* new AntigravityInstallationError({
                        operation: "cancel",
                        detail: "This installation is no longer running.",
                        cause: new Error("Private download diagnostics."),
                      });
                    }
                    state = { ...state, phase: "cancelled" };
                    return state;
                  }),
                changes: Stream.fromEffect(Effect.sync(() => state)),
              },
            },
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const unknownInstance = yield* client[WS_METHODS.providerInstallStart]({
                  instanceId: ProviderInstanceId.make("unknown-instance"),
                }).pipe(Effect.flip);
                assert.equal(unknownInstance._tag, "ProviderSetupError");
                assert.deepEqual(calls, []);
                const started = yield* client[WS_METHODS.providerInstallStart]({
                  instanceId: providerSetupInstanceId,
                });
                assert.deepEqual(started, providerSetupInstallState);
                const stale = yield* client[WS_METHODS.providerInstallCancel]({
                  instanceId: providerSetupInstanceId,
                  operationId: "old-operation",
                }).pipe(Effect.flip);
                assert.equal(stale._tag, "ProviderSetupError");
                if (stale._tag === "ProviderSetupError") {
                  assert.equal(stale.instanceId, providerSetupInstanceId);
                  assert.equal(stale.operation, "cancel");
                  assert.equal(stale.detail, "This installation is no longer running.");
                  assert.notProperty(stale, "cause");
                }
                const cancelled = yield* client[WS_METHODS.providerInstallCancel]({
                  instanceId: providerSetupInstanceId,
                  operationId: "install-operation",
                });
                assert.equal(cancelled.phase, "cancelled");
                const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
                  instanceId: providerSetupInstanceId,
                }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
                assert.deepEqual(observed, cancelled);
              }),
            ),
          );
          assert.deepEqual(calls, ["start", "cancel:old-operation", "cancel:install-operation"]);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const providers = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            checkedAt: "2026-04-11T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const;
        const changeEvent = {
          keybindings: [],
          issues: [],
        } as const;

        yield* buildAppUnderTest({
          config: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
            otlpLogsUrl: "http://localhost:4318/v1/logs",
          },
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({
                keybindings: [],
                issues: [],
              }),
              subscribeChanges: Effect.succeed(Stream.succeed(changeEvent)),
            },
            providerRegistry: {
              getProviders: Effect.succeed(providers),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.equal(first.version, 1);
          assert.deepEqual(first.config.keybindings, []);
          assert.deepEqual(first.config.issues, []);
          assert.deepEqual(first.config.providers, providers);
          assert.equal(path.basename(first.config.observability.logsDirectoryPath), "logs");
          assert.equal(first.config.observability.localTracingEnabled, true);
          assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
          assert.equal(first.config.observability.otlpTracesEnabled, true);
          assert.equal(
            first.config.observability.otlpMetricsUrl,
            "http://localhost:4318/v1/metrics",
          );
          assert.equal(first.config.observability.otlpMetricsEnabled, true);
          assert.equal(first.config.observability.otlpLogsUrl, "http://localhost:4318/v1/logs");
          assert.equal(first.config.observability.otlpLogsEnabled, true);
          assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
        }
        assert.deepEqual(second, {
          version: 1,
          type: "keybindingsUpdated",
          payload: { keybindings: [], issues: [] },
        });
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "provider refresh asks the registry to invalidate model caches before probing",
      () => {
        // The registry owns what invalidation clears (ProviderRegistry.test.ts); the server only
        // scopes it to the request and runs it before the probe.
        const instanceId = ProviderInstanceId.make("codex_work");
        const cwd = "/synthetic/provider-refresh";
        const calls: string[] = [];
        const invalidations: unknown[] = [];
        const probe = (kind: string) =>
          Effect.sync(() => {
            calls.push(kind);
            return [];
          });
        return Effect.gen(function* () {
          yield* buildAppUnderTest({
            layers: {
              providerRegistry: {
                invalidateModelCaches: (input) =>
                  Effect.sync(() => {
                    calls.push("invalidate");
                    invalidations.push(input);
                  }),
                refresh: () => probe("refresh"),
                refreshInstance: () => probe("refreshInstance"),
                refreshWorkspaceSnapshot: () => probe("refreshWorkspaceSnapshot"),
              },
            },
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          for (const mode of [
            "all",
            "targeted",
            "workspace",
            "workspace-fresh",
            "background",
          ] as const) {
            const workspaceScoped = mode === "workspace" || mode === "workspace-fresh";
            const targeted = mode === "targeted" || workspaceScoped;
            calls.length = 0;
            invalidations.length = 0;
            yield* Effect.scoped(
              withWsRpcClient(wsUrl, (client) =>
                client[WS_METHODS.serverRefreshProviders]({
                  ...(targeted ? { instanceId } : {}),
                  ...(workspaceScoped ? { cwd } : {}),
                  ...(mode === "workspace-fresh" ? { fresh: true } : {}),
                  ...(mode !== "background" ? { refreshModels: true } : {}),
                }),
              ),
            );
            const probeKind = workspaceScoped
              ? "refreshWorkspaceSnapshot"
              : targeted
                ? "refreshInstance"
                : "refresh";
            assert.deepEqual(
              calls,
              mode === "background" ? [probeKind] : ["invalidate", probeKind],
              mode,
            );
            assert.deepEqual(
              invalidations,
              mode === "background"
                ? []
                : [
                    {
                      instanceId: targeted ? instanceId : undefined,
                      cwd: workspaceScoped ? cwd : undefined,
                      fresh: mode === "workspace-fresh" ? true : undefined,
                    },
                  ],
              mode,
            );
          }
        }).pipe(Effect.provide(NodeHttpServerTest));
      },
    );

    it.effect("serves config on reconnect without starting provider probes", () =>
      Effect.gen(function* () {
        const refresh = vi.fn(() => Effect.never);
        yield* buildAppUnderTest({
          layers: { providerRegistry: { refresh } },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        for (let connection = 0; connection < 2; connection += 1) {
          const event = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.subscribeServerConfig]({}).pipe(
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              ),
            ),
          );
          assert.equal(event.type, "snapshot");
        }
        assert.equal(refresh.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("returns cached whole-host resources over websocket", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        const [first, second] = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.all(
              [
                client[WS_METHODS.serverGetHostResources]({}),
                client[WS_METHODS.serverGetHostResources]({}),
              ],
              { concurrency: "unbounded" },
            ),
          ),
        );
        assert.deepEqual(first, second);
        assert.isAtLeast(first.sampledAt, 0);
        assert.isAbove(first.cpuCount, 0);
        assert.isAbove(first.totalMemoryBytes, 0);
        assert.isAtLeast(first.availableMemoryBytes, 0);
        assert.isAtMost(first.availableMemoryBytes, first.totalMemoryBytes);
        if (first.cpuUtilization !== null) {
          assert.isAtLeast(first.cpuUtilization, 0);
          assert.isAtMost(first.cpuUtilization, 1);
        }
      }).pipe(Effect.provide(NodeHttpServerTest), TestClock.withLive),
    );

    it.effect("counts macOS reclaimable memory once and shares concurrent samples", () =>
      Effect.gen(function* () {
        const commandCalls = yield* Ref.make(0);
        const hostResources = yield* HostResources.make().pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provide(
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
              string: () =>
                Ref.update(commandCalls, (count) => count + 1).pipe(
                  Effect.as(
                    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n" +
                      "Pages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n" +
                      "Pages purgeable: 999.\n",
                  ),
                ),
            }),
          ),
        );
        const [first, second] = yield* Effect.all([hostResources.read, hostResources.read], {
          concurrency: "unbounded",
        });
        assert.equal(first.availableMemoryBytes, 35 * 16384);
        assert.deepEqual(first, second);
        assert.deepEqual(yield* hostResources.read, first);
        assert.equal(yield* Ref.get(commandCalls), 1);
      }).pipe(TestClock.withLive),
    );

    it.effect("retries host sampling immediately after its caller is interrupted", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const commandCalls = yield* Ref.make(0);
        const hostResources = yield* HostResources.make().pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provide(
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
              string: () =>
                Effect.gen(function* () {
                  const call = yield* Ref.updateAndGet(commandCalls, (count) => count + 1);
                  if (call === 1) {
                    yield* Deferred.succeed(started, undefined);
                    return yield* Effect.never;
                  }
                  return (
                    "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n" +
                    "Pages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n"
                  );
                }),
            }),
          ),
        );
        const firstRead = yield* hostResources.read.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(firstRead);
        const recovered = yield* hostResources.read;
        assert.equal(recovered.availableMemoryBytes, 35 * 4096);
        assert.equal(yield* Ref.get(commandCalls), 2);
      }).pipe(TestClock.withLive),
    );

    it.effect("routes websocket resource telemetry through the subscription", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const snapshot = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeResourceTelemetry]({}).pipe(Stream.runHead),
          ),
        );

        assertTrue(Option.isSome(snapshot));
        assert.equal(snapshot.value.processes.length, 0);
        assert.equal(snapshot.value.groups.backend.processCount, 0);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    // An already-shipped client decodes this stream against an event union
    // without environmentThemesUpdated, so an ungated emit would kill its whole
    // config subscription. Opting in is the only way to receive them.
    it.effect("subscribeServerConfig sends published themes to an opt-in subscriber", () =>
      Effect.gen(function* () {
        const themes = [
          {
            id: "nightfall",
            name: "Nightfall",
            appearance: "dark" as const,
            canvas: "#1a1b26",
            accent: "#7aa2f7",
          },
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            environmentTheme: {
              current: Effect.succeed(themes),
              streamChanges: Stream.succeed(themes),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({ environmentThemes: true }).pipe(
              Stream.take(2),
              Stream.runCollect,
            ),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        // Not in the snapshot as well, or every opt-in client receives the same
        // array twice on every connect.
        if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
        assert.equal(second?.type, "environmentThemesUpdated");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("subscribeServerConfig withholds published themes from other subscribers", () =>
      Effect.gen(function* () {
        const themes = [
          {
            id: "nightfall",
            name: "Nightfall",
            appearance: "dark" as const,
            canvas: "#1a1b26",
            accent: "#7aa2f7",
          },
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            environmentTheme: {
              current: Effect.succeed(themes),
              streamChanges: Stream.succeed(themes),
            },
            providerRegistry: { streamChanges: Stream.empty },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(1), Stream.runCollect),
          ),
        );

        const first = Array.from(events)[0];
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect.each([false, true])(
      "routes websocket rpc subscribeServerConfig emits provider status updates (limits: %s)",
      (hasLimits) =>
        Effect.gen(function* () {
          const nextProviders = [
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              installed: true,
              version: "1.0.0",
              status: "ready" as const,
              auth: { status: "authenticated" as const },
              checkedAt: "2026-04-11T00:00:00.000Z",
              models: [],
              slashCommands: [],
              skills: [],
              ...(hasLimits
                ? {
                    usageLimits: {
                      checkedAt: "2026-04-11T00:00:00.000Z",
                      windows: [
                        { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 },
                      ],
                    },
                  }
                : {}),
            },
          ] as const;

          yield* buildAppUnderTest({
            layers: {
              keybindings: {
                loadConfigState: Effect.succeed({
                  keybindings: [],
                  issues: [],
                }),
                streamChanges: Stream.empty,
              },
              providerRegistry: {
                getProviders: Effect.succeed([]),
                streamChanges: Stream.succeed(nextProviders),
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          const events = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.subscribeServerConfig]({ usageLimitsCommand: true }).pipe(
                Stream.take(2),
                Stream.runCollect,
              ),
            ),
          );

          const [first, second] = Array.from(events);
          assert.equal(first?.type, "snapshot");
          if (first?.type === "snapshot") {
            assert.deepEqual(first.config.providers, []);
          }
          assert.deepEqual(second, {
            version: 1,
            type: "providerStatuses",
            payload: {
              providers: hasLimits
                ? [
                    {
                      ...nextProviders[0],
                      slashCommands: [
                        {
                          name: "usage-limits",
                          description: "Show this provider's usage limits",
                        },
                      ],
                    },
                  ]
                : nextProviders,
            },
          });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "routes websocket rpc subscribeServerConfig keeps the limits command from clients that do not ask for it",
      () =>
        Effect.gen(function* () {
          const codex = {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            checkedAt: "2026-04-11T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
            usageLimits: {
              checkedAt: "2026-04-11T00:00:00.000Z",
              windows: [
                { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 },
              ],
            },
          };
          yield* buildAppUnderTest({
            layers: {
              keybindings: {
                loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
                streamChanges: Stream.empty,
              },
              providerRegistry: {
                getProviders: Effect.succeed([codex]),
                streamChanges: Stream.succeed([{ ...codex, version: "1.0.1" }]),
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          const events = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
            ),
          );

          const [first, second] = Array.from(events);
          assert.equal(first?.type, "snapshot");
          if (first?.type === "snapshot") {
            assert.deepEqual(first.config.providers, [codex]);
          }
          assert.deepEqual(second, {
            version: 1,
            type: "providerStatuses",
            payload: { providers: [{ ...codex, version: "1.0.1" }] },
          });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "routes websocket rpc subscribeServerConfig republishes commands when only a limits source changes",
      () =>
        Effect.gen(function* () {
          const codex = {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            checkedAt: "2026-04-11T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          };
          const hub = {
            id: UsageLimitSourceId.make("hub"),
            kind: "cliproxy" as const,
            label: "Accounts",
            checkedAt: "2026-04-11T00:00:00.000Z",
            accounts: [
              {
                id: "work",
                driver: ProviderDriverKind.make("codex"),
                usageLimits: {
                  checkedAt: "2026-04-11T00:00:00.000Z",
                  windows: [
                    { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 },
                  ],
                },
              },
            ],
          };

          yield* buildAppUnderTest({
            layers: {
              keybindings: {
                loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
                streamChanges: Stream.empty,
              },
              // The registry emits no change: only the source refresh can carry it.
              providerRegistry: {
                getProviders: Effect.succeed([codex]),
                streamChanges: Stream.empty,
              },
              usageLimitSources: {
                current: Effect.succeed([]),
                // Replay the empty snapshot, then a later refresh, as the live stream does.
                streamChanges: Stream.concat(Stream.make([]), Stream.make([hub])),
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          const events = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.subscribeServerConfig]({ usageLimitsCommand: true }).pipe(
                Stream.take(2),
                Stream.runCollect,
              ),
            ),
          );

          const [first, second] = Array.from(events);
          assert.equal(first?.type, "snapshot");
          if (first?.type === "snapshot") {
            assert.deepEqual(first.config.providers, [codex]);
          }
          assert.deepEqual(second, {
            version: 1,
            type: "providerStatuses",
            payload: {
              providers: [
                {
                  ...codex,
                  slashCommands: [
                    { name: "usage-limits", description: "Show this provider's usage limits" },
                  ],
                },
              ],
            },
          });
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("delivers provider statuses over websocket while registry updates continue", () =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
        const subscribed = yield* Deferred.make<void>();
        const provider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-08-23T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
              streamChanges: Stream.empty,
            },
            providerRegistry: {
              getProviders: Effect.succeed([]),
              streamChanges: Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                Stream.flatMap(() => Stream.fromQueue(updates)),
              ),
            },
          },
        });
        const url = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(url, (client) =>
            Effect.gen(function* () {
              const snapshot = yield* Deferred.make<void>();
              const delivered = yield* Deferred.make<ReadonlyArray<ServerProvider>>();
              const consumer = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
                Stream.runForEach((event) =>
                  event.type === "snapshot"
                    ? Deferred.succeed(snapshot, undefined).pipe(Effect.asVoid)
                    : event.type === "providerStatuses"
                      ? Deferred.succeed(delivered, event.payload.providers).pipe(Effect.asVoid)
                      : Effect.void,
                ),
                Effect.forkChild,
              );
              yield* Deferred.await(snapshot);
              yield* Deferred.await(subscribed);
              let revision = 0;
              // Keep the change source open and busy until reception; debounce cannot
              // satisfy this witness by flushing only when a finite source ends.
              const producer = yield* Effect.gen(function* () {
                while (true) {
                  revision += 1;
                  yield* Queue.offer(updates, [{ ...provider, version: `1.0.${revision}` }]);
                  yield* Effect.sleep("50 millis");
                }
              }).pipe(Effect.forkChild);
              const received = yield* Deferred.await(delivered).pipe(Effect.timeout("3 seconds"));
              assert.equal(received.length, 1);
              assert.equal(received[0]?.instanceId, provider.instanceId);
              assert.equal(received[0]?.status, "ready");
              assert.notEqual(received[0]?.version, "1.0.0");
              yield* Fiber.interrupt(producer);
              yield* Fiber.interrupt(consumer);
            }),
          ),
        );
      }).pipe(Effect.provide(NodeHttpServerTest), TestClock.withLive),
    );

    it.effect("coalesces sustained provider updates without starving the latest state", () =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
        const observed = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
        const consumer = yield* coalesceProviderStatusUpdates(Stream.fromQueue(updates)).pipe(
          Stream.runForEach((providers) => Queue.offer(observed, providers)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const activeProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "warning" as const,
          auth: { status: "unauthenticated" as const },
          checkedAt: "2026-08-23T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
        const terminalProvider = {
          ...activeProvider,
          status: "ready" as const,
          checkedAt: "2026-08-23T00:00:00.100Z",
        } satisfies ServerProvider;

        yield* Queue.offer(updates, [activeProvider]);
        yield* TestClock.adjust("100 millis");
        yield* Queue.offer(updates, [terminalProvider]);
        yield* TestClock.adjust("101 millis");
        yield* Effect.yieldNow;

        const latest = yield* Queue.poll(observed);
        assert.isTrue(Option.isSome(latest));
        assert.deepEqual(Option.getOrUndefined(latest), [terminalProvider]);
        yield* Fiber.interrupt(consumer);
      }),
    );

    it.effect("redacts provider authorization material from read-only clients", () =>
      Effect.gen(function* () {
        const providers = [
          {
            instanceId: ProviderInstanceId.make("grok"),
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            installed: true,
            version: "1.0.5",
            status: "warning" as const,
            auth: { status: "unauthenticated" as const },
            checkedAt: "2026-08-23T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
            connection: {
              methods: ["grok_account" as const, "grok_device_code" as const],
              canDisconnect: false,
              operation: {
                operationId: "grok-operation",
                method: "grok_device_code" as const,
                status: "waiting_for_device_code" as const,
                startedAt: "2026-08-23T00:00:00.000Z",
                finishedAt: null,
                message: "Finish signing in.",
                authorizationUrl: "https://accounts.x.ai/device?user_code=GROK-1234",
                authorizationUrlKind: "manual_fallback" as const,
                acceptsAuthorizationCode: true,
                userCode: "GROK-1234",
                instructions: "Enter code: GROK-1234",
              },
              accountOperation: {
                operationId: "account-operation",
                method: "scient_agent_account" as const,
                status: "waiting_for_device_code" as const,
                startedAt: "2026-08-23T00:00:00.000Z",
                finishedAt: null,
                message: "Finish signing in.",
                account: "openai-codex",
                authorizationUrl: "https://auth.example.com/device",
                authorizationUrlKind: "primary" as const,
                userCode: "ACCT-1234",
                instructions: "Enter code: ACCT-1234",
              },
            },
          },
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
              streamChanges: Stream.empty,
            },
            providerRegistry: {
              getProviders: Effect.succeed(providers),
              streamChanges: Stream.succeed(
                providers.map((provider) => ({
                  ...provider,
                  checkedAt: "2026-08-23T00:00:01.000Z",
                })),
              ),
            },
          },
        });

        const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "orchestration:read",
        });
        assert.isDefined(tokenBody.access_token);
        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          },
        });
        const wsTicketBody = yield* responseJsonEffect<{ readonly ticket: string }>(
          wsTicketResponse,
        );
        const readOnlyWsUrl = `${yield* getWsServerUrl("/ws", {
          authenticated: false,
        })}&wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;
        const readOnlyResult = yield* Effect.scoped(
          withWsRpcClient(readOnlyWsUrl, (client) =>
            Effect.gen(function* () {
              const config = yield* client[WS_METHODS.serverGetConfig]({});
              const events = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
                Stream.filter((event) => event.type === "providerStatuses"),
                Stream.take(1),
                Stream.runCollect,
              );
              return { config, events };
            }),
          ),
        );

        const assertAuthorizationMaterialRedacted = (provider: ServerProvider | undefined) => {
          assert.isDefined(provider);
          assert.equal(provider?.connection?.operation?.status, "waiting_for_device_code");
          assert.equal(provider?.connection?.operation?.acceptsAuthorizationCode, true);
          assert.isUndefined(provider?.connection?.operation?.authorizationUrl);
          assert.isUndefined(provider?.connection?.operation?.authorizationUrlKind);
          assert.isUndefined(provider?.connection?.operation?.userCode);
          assert.isUndefined(provider?.connection?.operation?.instructions);
          const accountOperation = provider?.connection?.accountOperation;
          assert.equal(accountOperation?.account, "openai-codex");
          assert.isUndefined(accountOperation?.authorizationUrl);
          assert.isUndefined(accountOperation?.authorizationUrlKind);
          assert.isUndefined(accountOperation?.userCode);
          assert.isUndefined(accountOperation?.instructions);
        };

        assertAuthorizationMaterialRedacted(readOnlyResult.config.providers[0]);
        const providerUpdate = Array.from(readOnlyResult.events).find(
          (event) => event.type === "providerStatuses",
        );
        assert.equal(providerUpdate?.type, "providerStatuses");
        if (providerUpdate?.type === "providerStatuses") {
          assertAuthorizationMaterialRedacted(providerUpdate.payload.providers[0]);
        }

        const operatorWsUrl = yield* getWsServerUrl("/ws");
        const operatorResult = yield* Effect.scoped(
          withWsRpcClient(operatorWsUrl, (client) =>
            Effect.gen(function* () {
              const config = yield* client[WS_METHODS.serverGetConfig]({});
              const update = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
                Stream.filter((event) => event.type === "providerStatuses"),
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              );
              return { config, update };
            }),
          ),
        );
        const operatorConfig = operatorResult.config;
        assert.equal(operatorResult.update.type, "providerStatuses");
        if (operatorResult.update.type === "providerStatuses") {
          assert.equal(
            operatorResult.update.payload.providers[0]?.connection?.operation?.authorizationUrl,
            "https://accounts.x.ai/device?user_code=GROK-1234",
          );
          assert.equal(
            operatorResult.update.payload.providers[0]?.connection?.operation?.userCode,
            "GROK-1234",
          );
        }
        assert.equal(
          operatorConfig.providers[0]?.connection?.operation?.authorizationUrl,
          "https://accounts.x.ai/device?user_code=GROK-1234",
        );
        assert.equal(operatorConfig.providers[0]?.connection?.operation?.userCode, "GROK-1234");
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect(
      "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
      () =>
        Effect.gen(function* () {
          const lifecycleEvents = [
            {
              version: 1 as const,
              sequence: 1,
              type: "welcome" as const,
              payload: {
                environment: testEnvironmentDescriptor,
                cwd: "/tmp/project",
                projectName: "project",
              },
            },
          ] as const;
          const liveEvents = Stream.make({
            version: 1 as const,
            sequence: 2,
            type: "ready" as const,
            payload: { at: "2026-01-01T00:00:00.000Z", environment: testEnvironmentDescriptor },
          });

          yield* buildAppUnderTest({
            layers: {
              serverLifecycleEvents: {
                snapshot: Effect.succeed({
                  sequence: 1,
                  events: lifecycleEvents,
                }),
                stream: liveEvents,
              },
            },
          });

          const wsUrl = yield* getWsServerUrl("/ws");
          const events = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.subscribeServerLifecycle]({}).pipe(
                Stream.take(2),
                Stream.runCollect,
              ),
            ),
          );

          const [first, second] = Array.from(events);
          assert.equal(first?.type, "welcome");
          assert.equal(first?.sequence, 1);
          assert.equal(second?.type, "ready");
          assert.equal(second?.sequence, 2);
        }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("subscribeServerLifecycle buffers updates published during snapshot capture", () =>
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
        const streamSubscribed = yield* Deferred.make<void>();
        const snapshotPublished = yield* Deferred.make<void>();
        const bootstrapProjectId = ProjectId.make("project-bootstrap");
        const bootstrapThreadId = ThreadId.make("thread-bootstrap");
        const snapshotEvent = {
          version: 1 as const,
          sequence: 1,
          type: "welcome" as const,
          payload: {
            environment: testEnvironmentDescriptor,
            cwd: "/tmp/project",
            projectName: "project",
            bootstrapStatus: "pending" as const,
          },
        };
        const gapEvent = {
          version: 1 as const,
          sequence: 2,
          type: "welcome" as const,
          payload: {
            environment: testEnvironmentDescriptor,
            cwd: "/tmp/project",
            projectName: "project",
            bootstrapStatus: "complete" as const,
            bootstrapProjectId,
            bootstrapThreadId,
            bootstrapProjectCreated: true,
            bootstrapThreadCreated: true,
          },
        };
        const sentinelEvent = {
          version: 1 as const,
          sequence: 3,
          type: "ready" as const,
          payload: { at: "2026-01-01T00:00:01.000Z", environment: testEnvironmentDescriptor },
        };
        const liveStream = Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(pubsub);
            yield* Deferred.succeed(streamSubscribed, undefined);
            return Stream.fromSubscription(subscription);
          }),
        );

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: PubSub.publish(pubsub, gapEvent).pipe(
                Effect.andThen(Deferred.succeed(snapshotPublished, undefined)),
                Effect.as({ sequence: 1, events: [snapshotEvent] }),
              ),
              stream: liveStream,
            },
          },
        });

        yield* Effect.gen(function* () {
          yield* Deferred.await(snapshotPublished);
          yield* Deferred.await(streamSubscribed);
          yield* PubSub.publish(pubsub, sentinelEvent);
        }).pipe(Effect.forkScoped);

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        if (first?.type !== "welcome") {
          assert.fail("expected the pending bootstrap event");
        }
        assert.equal(first.payload.bootstrapStatus, "pending");
        assert.equal(second?.type, "welcome");
        assert.equal(second?.sequence, 2);
        if (second?.type !== "welcome") {
          assert.fail("expected the bootstrap completion event");
        }
        assert.equal(second.payload.bootstrapStatus, "complete");
        assert.equal(second.payload.bootstrapProjectId, bootstrapProjectId);
        assert.equal(second.payload.bootstrapThreadId, bootstrapThreadId);
        assert.equal(second.payload.bootstrapProjectCreated, true);
        assert.equal(second.payload.bootstrapThreadCreated, true);
      }).pipe(Effect.provide(NodeHttpServerTest)),
    );

    it.effect("routes websocket rpc project listing and exact file reads", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-files-" });
        yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workspaceDir, "src", "index.ts"),
          "export const answer = 42;\n",
        );
        yield* fs.writeFileString(path.join(workspaceDir, ".env"), "LOCAL_ONLY=true\n");
        yield* fs.makeDirectory(path.join(workspaceDir, ".git"), { recursive: true });
        yield* fs.writeFileString(path.join(workspaceDir, ".git", "config"), "[core]\n");
        yield* fs.makeDirectory(path.join(workspaceDir, ".scient"), { recursive: true });
        yield* fs.writeFileString(path.join(workspaceDir, ".scient", "project.json"), "{}\n");
        yield* fs.makeDirectory(path.join(workspaceDir, ".scient", "sources", "records"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(workspaceDir, ".scient", "sources", "records", "source.json"),
          "{}\n",
        );
        yield* fs.symlink(
          path.join(workspaceDir, ".scient", "project.json"),
          path.join(workspaceDir, "managed-alias.json"),
        );

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.all({
              listing: client[WS_METHODS.projectsListEntries]({ cwd: workspaceDir }),
              directory: client[WS_METHODS.projectsListDirectory]({
                cwd: workspaceDir,
                relativeDirectory: "",
                view: "ordinary",
              }),
              scient: client[WS_METHODS.projectsListDirectory]({
                cwd: workspaceDir,
                relativeDirectory: ".scient",
                view: "ordinary",
              }),
              internals: client[WS_METHODS.projectsListDirectory]({
                cwd: workspaceDir,
                relativeDirectory: "",
                view: "with-internals",
              }),
              file: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "src/index.ts",
              }),
              managedFile: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: ".scient/project.json",
              }),
              managedAlias: client[WS_METHODS.projectsReadFile]({
                cwd: workspaceDir,
                relativePath: "managed-alias.json",
              }),
            }),
          ),
        );

        assert.isTrue(response.listing.entries.some((entry) => entry.path === "src/index.ts"));
        assert.isTrue(response.directory.complete);
        assert.isTrue(response.directory.entries.some((entry) => entry.relativePath === ".env"));
        assert.isFalse(response.directory.entries.some((entry) => entry.relativePath === ".git"));
        assert.isTrue(
          response.scient.entries.some(
            (entry) => entry.relativePath === ".scient/sources" && entry.readOnly,
          ),
        );
        assert.isTrue(response.internals.entries.some((entry) => entry.relativePath === ".git"));
        assert.deepEqual(response.file, {
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
          revision: `sha256:${NodeCrypto.createHash("sha256")
            .update("export const answer = 42;\n")
            .digest("hex")}`,
          readOnly: false,
        });
        assert.equal(response.managedFile.readOnly, true);
        assert.equal(response.managedAlias.readOnly, true);
      }).pipe(Effect.provide(NodeHttpServerTest), TestClock.withLive),
    );
  },
);
