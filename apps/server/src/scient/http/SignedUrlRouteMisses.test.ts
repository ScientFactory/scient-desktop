import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { EnvironmentHttpApi, EnvironmentId } from "@t3tools/contracts";
import { ASSET_ROUTE_PREFIX } from "../../assets/AssetAccess.ts";
import * as AssetSigner from "../../assets/AssetSigner.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../../assets/AttachmentUpload.ts";
import * as NativeAppIconResolver from "../../assets/NativeAppIconResolver.ts";
import * as WorkspacePreviewRevisions from "../../assets/WorkspacePreviewRevisions.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as RelayDeliveryProof from "../../scheduledTasks/RelayDeliveryProof.ts";
import {
  ScheduledTaskService,
  WEBHOOK_ROUTE_PREFIX,
} from "../../scheduledTasks/ScheduledTaskService.ts";
import * as WebhookRoute from "../../scheduledTasks/webhookRoute.ts";
import { SourceControlDrivers } from "../../sourceControl/builtInDrivers.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as SignedUrlRouteMisses from "./SignedUrlRouteMisses.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

// A synthetic bearer token: no span attribute or logged field may ever carry it.
const TOKEN = "synthetic-signed-token-5f2c9a";

const serveSignedRoutes = Effect.fn("serveSignedRoutes")(function* (withRouteMisses: boolean) {
  const serverSpans: Array<Tracer.NativeSpan> = [];
  const logged: Array<string> = [];
  const layerTracer = Layer.succeed(
    Tracer.Tracer,
    Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        if (options.kind === "server") serverSpans.push(span);
        return span;
      },
    }),
  );
  const layerLogger = Logger.layer(
    [
      Logger.make(({ fiber, message }) => {
        logged.push(
          `${String(message)} ${JSON.stringify(fiber.getRef(References.CurrentLogAnnotations))}`,
        );
      }),
    ],
    { mergeWithExisting: false },
  );
  const layerRoutes = Layer.mergeAll(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(WebhookRoute.layer),
      Layer.provide(RelayDeliveryProof.layer),
    ),
    ServerHttp.layerAssetRoute,
    ServerHttp.layerAttachmentUploadRoute,
    // Stands in for the app's static route, which answers every other GET.
    HttpRouter.add("GET", "*", HttpServerResponse.text("index")),
    ...(withRouteMisses ? [SignedUrlRouteMisses.layer] : []),
  );
  // Unsigned tokens stop at the signer and unknown hooks at the task service.
  const layerRouteServices = Layer.mergeAll(
    Layer.mock(AssetSigner.AssetSigner)({ verify: () => Effect.succeed(false) }),
    Layer.mock(DocumentText.DocumentText)({}),
    Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
    Layer.mock(SecureRandom.SecureRandom)({}),
    ServerConfig.layerTest(process.cwd(), { prefix: "scient-signed-url-test-" }),
    Layer.succeed(SourceControlDrivers)([]),
    Layer.mock(WorkspacePaths.WorkspacePaths)({}),
    Layer.mock(WorkspacePreviewRevisions.WorkspacePreviewRevisions)({}),
    Layer.mock(ScheduledTaskService)({
      triggerWebhook: () => Effect.succeed({ _tag: "not_found" as const }),
    }),
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeedNone,
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
    }),
    HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak)),
    PlatformNodeCrypto.layerSignature,
  );
  // HttpRouter.serve prefers outer services; route handlers resolve them from there.
  const services = yield* Layer.build(
    HttpRouter.serve(layerRoutes, { disableListenLog: true }).pipe(
      ServerHttp.withUntracedRequests,
      Layer.provideMerge(layerRouteServices),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(layerTracer),
      Layer.provide(layerLogger),
    ),
  );
  const client = Context.get(services, HttpClient.HttpClient);
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
  // Everything a span records: name and every attribute value.
  const traced = () =>
    serverSpans.map((span) => `${span.name} ${JSON.stringify([...span.attributes.entries()])}`);
  return { send, traced, logged, serverSpans };
});

const webhookUrl = `${WEBHOOK_ROUTE_PREFIX}/hook-1/${TOKEN}`;
const uploadUrl = `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.${TOKEN}`;

// Requests that reach a signed route, with the status that route answers.
const matched: ReadonlyArray<readonly [HttpClientRequest.HttpClientRequest, number]> = [
  [HttpClientRequest.post(webhookUrl).pipe(HttpClientRequest.bodyText("{}")), 404],
  [HttpClientRequest.get(webhookUrl), 404],
  // The webhook GET route answers HEAD probes itself.
  [HttpClientRequest.head(webhookUrl), 405],
  [HttpClientRequest.get(`${ASSET_ROUTE_PREFIX}/payload.${TOKEN}/image.png`), 404],
  [HttpClientRequest.post(uploadUrl), 404],
];

// Requests under a signed prefix that match none of its routes.
const misses: ReadonlyArray<HttpClientRequest.HttpClientRequest> = [
  HttpClientRequest.delete(webhookUrl),
  // A method outside HttpMethod that Node still accepts.
  HttpClientRequest.make("PROPFIND" as HttpMethod.HttpMethod)(webhookUrl),
  HttpClientRequest.post(`${webhookUrl}/extra`),
  HttpClientRequest.get(`${webhookUrl}/extra`),
  HttpClientRequest.head(`${webhookUrl}/extra`),
  HttpClientRequest.get(`${WEBHOOK_ROUTE_PREFIX}/${TOKEN}`),
  HttpClientRequest.get(uploadUrl),
  HttpClientRequest.put(uploadUrl),
  HttpClientRequest.options(uploadUrl),
];

describe("signed URL route misses", () => {
  it.effect("keeps signed URL tokens out of request spans and logs, matched or not", () =>
    Effect.gen(function* () {
      const { send, traced, logged, serverSpans } = yield* serveSignedRoutes(true);

      for (const [request, status] of matched) {
        expect((yield* send(request)).status, `${request.method} ${request.url}`).toBe(status);
      }
      for (const request of misses) {
        expect((yield* send(request)).status, `${request.method} ${request.url}`).toBe(404);
      }

      expect(serverSpans).toHaveLength(matched.length + misses.length);
      expect(logged.length).toBeGreaterThanOrEqual(matched.length + misses.length);
      for (const record of [...traced(), ...logged]) {
        expect(record).not.toContain(TOKEN);
      }
      expect(serverSpans.map((span) => span.attributes.get("url.path"))).toContain(
        `${WEBHOOK_ROUTE_PREFIX}/REDACTED`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Proves the check above can see a leak: without the catch-alls a route miss keeps its token.
  it.effect("sees the token in a route miss's span when no catch-all covers it", () =>
    Effect.gen(function* () {
      const { send, traced } = yield* serveSignedRoutes(false);

      yield* send(HttpClientRequest.delete(webhookUrl));
      expect(traced().join("\n")).toContain(TOKEN);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
