// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makePiCustomModelsClientFactory } from "./PiCustomModels.ts";
import { piModelSettings } from "./PiCustomModelsTestHelpers.ts";

const binary = process.env.SCIENT_PI_TEST_BINARY;
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect.skipIf(!binary)(
  "qualifies exact xAI Responses native inheritance and request routing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-xai-" });
      const requests: { path: string; body: Record<string, unknown>; key: string | undefined }[] =
        [];
      const server = NodeHttp.createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        requests.push({
          path: request.url!,
          body: decode(body),
          key: request.headers.authorization,
        });
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          json({ error: { message: "Synthetic xAI wire capture", type: "invalid_request_error" } }),
        );
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      // Keep the production provider identity while redirecting only the synthetic child's HTTP transport.
      const extension = root + "/fixture.mjs";
      yield* fs.writeFileString(
        extension,
        `
export default function() {
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.x.ai/")) return fetch(url.replace("https://api.x.ai", "http://127.0.0.1:${address.port}"), init);
    if (url.startsWith("http://127.0.0.1:")) return fetch(input, init);
    throw new Error("External networking forbidden in fixture");
  };
}`,
      );
      const instanceId = ProviderInstanceId.make("pi");
      const factory = yield* makePiCustomModelsClientFactory(
        piModelSettings(
          {
            resolveCustomModels: () =>
              Effect.succeed([
                {
                  id: "xai",
                  name: "SpaceXAI",
                  protocol: "openai-responses",
                  baseUrl: "https://api.x.ai/v1",
                  credentialId: "fixture",
                  apiKey: Redacted.make("synthetic-xai"),
                  models: [
                    {
                      id: "grok",
                      modelId: "grok-4.6",
                      name: "Grok",
                      configurationMode: "automatic",
                      reasoning: false,
                      images: false,
                      instanceIds: [instanceId],
                    },
                  ],
                },
              ]),
          },
          instanceId,
        ),
        instanceId,
        root,
      );
      const client = yield* factory({
        command: binary!,
        cwd: root,
        args: [
          "--offline",
          "--no-session",
          "--no-extensions",
          "--no-context-files",
          "--no-tools",
          "--extension",
          extension,
        ],
        env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root + "/profile" },
      });
      const inventory = yield* client.getAvailableModels();
      expect(inventory.models.find((model) => model.provider === "scient_xai")).toMatchObject({
        id: "grok-4.6",
        api: "openai-responses",
        contextWindow: 500000,
        maxTokens: 500000,
      });
      yield* client.setModel("scient_xai", "grok-4.6");
      const complete = yield* client.events.pipe(
        Stream.takeUntil((event) => "type" in event && event.type === "agent_settled"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* client.prompt("Capture this request");
      yield* Fiber.join(complete);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/v1/responses",
        body: { model: "grok-4.6" },
        key: "Bearer synthetic-xai",
      });
      expect(json(client.assessModelConnections?.(inventory.models))).not.toContain(
        "synthetic-xai",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 20000 },
);
