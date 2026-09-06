import { piModelSettings } from "./PiCustomModelsTestHelpers.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelReasoningMetadata } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makePiCustomModelsClientFactory } from "./PiCustomModels.ts";
import { applyPiModelSelection } from "./PiModelSelection.ts";
import { piDiscoveredModelToServerProviderModel } from "./PiModel.ts";

const binary = process.env.SCIENT_PI_TEST_BINARY;
const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

it.effect.skipIf(!binary)(
  "restores legacy hosted reasoning through discovery and cold runtime selection without metadata IO",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-legacy-reasoning-" });
        const instanceId = ProviderInstanceId.make("pi-legacy-reasoning");
        // This stale empty snapshot used to mask the native ladder after reload.
        let override = false;
        const factory = yield* makePiCustomModelsClientFactory(
          piModelSettings(
            {
              resolveCustomModels: () =>
                Effect.sync(() => [
                  {
                    id: "legacy",
                    name: "Synthetic hosted connection",
                    protocol: "openai-responses" as const,
                    baseUrl: "https://api.openai.com/v1",
                    credentialId: null,
                    apiKey: null,
                    models: [
                      {
                        id: "legacy",
                        modelId: "gpt-5",
                        name: "Legacy model",
                        contextWindow: 64000,
                        maxOutputTokens: 1024,
                        images: false,
                        reasoning: true,
                        instanceIds: [instanceId],
                        ...(override
                          ? {
                              reasoningOverride: {
                                supported: true,
                                levels: ["low", "high"] as const,
                                defaultLevel: "high" as const,
                              },
                            }
                          : {}),
                        reasoningMetadata: {
                          status: "unknown" as const,
                          source: "unknown" as const,
                          checkedAt: "2026-09-06T00:00:00Z",
                          stale: true,
                          supported: null,
                          levels: [],
                        },
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
        const guard = root + "/guard.mjs";
        yield* fs.writeFileString(
          guard,
          `
export default function() {
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "127.0.0.1") throw new Error("External metadata IO is forbidden in this fixture");
    return fetch(input, options);
  };
}`,
        );
        for (const coldStart of [false, true]) {
          const client = yield* factory({
            command: binary!,
            cwd: root,
            args: [
              "--no-session",
              "--offline",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--no-tools",
              "-e",
              guard,
            ],
            env: {
              PATH: process.env.PATH,
              HOME: root,
              PI_CODING_AGENT_DIR: root + "/profile",
              PI_TELEMETRY: "0",
              PI_SKIP_VERSION_CHECK: "1",
            },
          });
          const discovered = (yield* client.getAvailableModels()).models.find(
            (model) => model.provider === "scient_legacy",
          );
          expect(discovered).toMatchObject({
            contextWindow: 64000,
            maxTokens: 1024,
            reasoning: true,
          });
          expect(discovered?.reasoningMetadata).toBeUndefined();
          const composerModel = piDiscoveredModelToServerProviderModel({
            id: discovered!.id,
            provider: discovered!.provider,
            ...(discovered?.reasoning === undefined ? {} : { reasoning: discovered.reasoning }),
            ...(discovered?.thinkingLevelMap
              ? { thinkingLevelMap: discovered.thinkingLevelMap }
              : {}),
            name: "Legacy model",
          });
          expect(composerModel?.capabilities?.optionDescriptors?.[0]).toMatchObject({
            options: expect.arrayContaining([{ id: "low", label: "Low" }]),
          });
          const selected = { provider: "scient_legacy", modelId: "gpt-5" };
          for (const level of ["low", "high"] as const) {
            expect(
              (yield* applyPiModelSelection(client, selected, level)).confirmedThinkingLevel,
            ).toBe(level);
          }
          if (!coldStart) {
            override = true;
            const selectedOverride = yield* applyPiModelSelection(client, selected, undefined, {
              messageCount: 0,
            });
            expect(selectedOverride.supportedThinkingLevels).toEqual(["low", "high"]);
            expect(selectedOverride.confirmedThinkingLevel).toBe("high");
          }
          yield* client.close();
        }
        expect(yield* fs.exists(root + "/profile/models.json")).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

// The installed 0.84.4 bundle uses baseUrl.includes("api.x.ai") for its xAI heuristic.
// A path segment triggers that heuristic while the network destination remains loopback.
for (const basePath of ["/v1", "/api.x.ai/v1"]) {
  const explicitOnly = basePath !== "/v1";
  it.effect.skipIf(!binary)(
    `serializes only allowed reasoning efforts and refreshes maps (${basePath})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-reasoning-" });
          const requests: Array<{ path: string | undefined; body: Record<string, unknown> }> = [];
          const server = NodeHttp.createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += String(chunk);
            requests.push({ path: request.url, body: decodeBody(body) });
            const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
              `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
            response
              .writeHead(200, { "content-type": "text/event-stream" })
              .end(
                chunk({ role: "assistant", content: "Synthetic reasoning response." }, null) +
                  chunk({}, "stop") +
                  "data: [DONE]\n\n",
              );
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                  });
                }),
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
          if (!address || typeof address === "string")
            throw new Error("Missing local test endpoint");
          const instanceId = ProviderInstanceId.make("pi-reasoning-live");
          let metadata: ModelReasoningMetadata = {
            status: "known",
            source: "manual",
            checkedAt: "2026-09-06T00:00:00Z",
            stale: false,
            supported: true,
            levels: ["off", "low", "high", "max"],
            defaultLevel: "high",
            mode: "effort",
          };
          const factory = yield* makePiCustomModelsClientFactory(
            piModelSettings(
              {
                resolveCustomModels: () =>
                  Effect.sync(() => [
                    {
                      id: "reasoning_fixture",
                      name: "Synthetic local reasoning",
                      protocol: "openai-completions" as const,
                      baseUrl: `http://127.0.0.1:${address.port}${basePath}`,
                      credentialId: null,
                      apiKey: null,
                      models: [
                        {
                          id: "synthetic",
                          modelId: "synthetic",
                          name: "Synthetic reasoning",
                          contextWindow: 32000,
                          maxOutputTokens: 128,
                          images: false,
                          reasoning: true,
                          ...(explicitOnly ? {} : { defaultReasoningLevel: "high" as const }),
                          instanceIds: [instanceId],
                          ...(explicitOnly
                            ? {
                                reasoningOverride: {
                                  supported: true,
                                  levels: metadata.levels,
                                  defaultLevel: "high" as const,
                                },
                              }
                            : { reasoningMetadata: metadata }),
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
              "--no-session",
              "--offline",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--no-tools",
            ],
            env: {
              PATH: process.env.PATH,
              HOME: root,
              PI_CODING_AGENT_DIR: root + "/profile",
              PI_TELEMETRY: "0",
              PI_SKIP_VERSION_CHECK: "1",
            },
          });
          const selected = { provider: "scient_reasoning_fixture", modelId: "synthetic" };
          for (const [index, level] of (
            [undefined, "low", "high", "max", "off"] as const
          ).entries()) {
            const confirmed = yield* applyPiModelSelection(client, selected, level, {
              messageCount: 0,
            });
            expect(confirmed.supportedThinkingLevels).toEqual(metadata.levels);
            expect(confirmed.state.model.reasoningMetadata).toEqual(
              explicitOnly ? undefined : metadata,
            );
            expect(confirmed.confirmedThinkingLevel).toBe(level ?? "high");
            const completed = yield* client.events.pipe(
              Stream.takeUntil((event) => "type" in event && event.type === "agent_settled"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* client.prompt(`Synthetic effort ${level}`);
            const events = Array.from(yield* Fiber.join(completed));
            expect(
              events.findLast((event) => "type" in event && event.type === "message_end"),
            ).toMatchObject({
              message: { role: "assistant", stopReason: "stop" },
            });
            expect(requests).toHaveLength(index + 1);
            expect(requests.at(-1)).toMatchObject({
              path: `${basePath}/chat/completions`,
              body: {
                model: "synthetic",
                reasoning_effort: level === "off" ? "none" : (level ?? "high"),
              },
            });
          }
          // A live metadata change must reach the existing idle Pi process through setModel refresh.
          metadata = { ...metadata, levels: ["low", "high", "max"] };
          for (const level of ["minimal", "off"] as const) {
            const rejected = yield* applyPiModelSelection(client, selected, level).pipe(
              Effect.andThen(client.prompt("This must never reach HTTP")),
              Effect.result,
            );
            expect(rejected._tag).toBe("Failure");
            if (rejected._tag === "Failure")
              expect(rejected.failure).toMatchObject({
                _tag: "PiModelSelectionError",
                kind: "validation",
                detail: expect.stringContaining("not supported"),
              });
            expect(requests).toHaveLength(5);
          }
          expect((yield* client.getThinkingLevels()).levels).toEqual(metadata.levels);
          expect(yield* fs.exists(root + "/profile/models.json")).toBe(false);
          expect(decodeBody(yield* fs.readFileString(root + "/profile/auth.json"))).toEqual({});
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
}

for (const protocol of ["openai-responses", "anthropic-messages"] as const) {
  it.effect.skipIf(!binary)(
    `captures ${protocol} reasoning fields and reports the intentional HTTP rejection`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-reasoning-wire-" });
          const requests: Array<{ path: string | undefined; body: Record<string, unknown> }> = [];
          const rejection = "Synthetic wire capture only; intentional HTTP 400";
          const server = NodeHttp.createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += String(chunk);
            requests.push({ path: request.url, body: decodeBody(body) });
            response.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({
                type: "error",
                error: { type: "invalid_request_error", message: rejection },
              }),
            );
          });
          yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.once("error", reject);
                  server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                  });
                }),
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
          if (!address || typeof address === "string")
            throw new Error("Missing local test endpoint");
          const instanceId = ProviderInstanceId.make("pi-reasoning-wire");
          const metadata: ModelReasoningMetadata = {
            status: "known",
            source: "manual",
            checkedAt: "2026-09-06T00:00:00Z",
            stale: false,
            supported: true,
            levels: ["low", "high"],
            defaultLevel: "high",
            mode: protocol === "anthropic-messages" ? "adaptive" : "effort",
          };
          const factory = yield* makePiCustomModelsClientFactory(
            piModelSettings(
              {
                resolveCustomModels: () =>
                  Effect.succeed([
                    {
                      id: "wire_fixture",
                      name: "Synthetic wire capture",
                      protocol,
                      baseUrl: `http://127.0.0.1:${address.port}${protocol === "openai-responses" ? "/v1" : ""}`,
                      credentialId: null,
                      apiKey: null,
                      models: [
                        {
                          id: "synthetic",
                          modelId: "synthetic",
                          name: "Synthetic wire model",
                          contextWindow: 32000,
                          maxOutputTokens: 128,
                          images: false,
                          reasoning: true,
                          instanceIds: [instanceId],
                          reasoningMetadata: metadata,
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
              "--no-session",
              "--offline",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--no-tools",
            ],
            env: {
              PATH: process.env.PATH,
              HOME: root,
              PI_CODING_AGENT_DIR: root + "/profile",
              PI_TELEMETRY: "0",
              PI_SKIP_VERSION_CHECK: "1",
            },
          });
          const confirmed = yield* applyPiModelSelection(
            client,
            { provider: "scient_wire_fixture", modelId: "synthetic" },
            "high",
          );
          expect(confirmed.confirmedThinkingLevel).toBe("high");
          const completed = yield* client.events.pipe(
            Stream.takeUntil((event) => "type" in event && event.type === "agent_settled"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* client.prompt("Capture this synthetic request and reject it");
          const events = Array.from(yield* Fiber.join(completed));
          // A captured request is transport evidence, not successful generation.
          expect(
            events.findLast((event) => "type" in event && event.type === "message_end"),
          ).toMatchObject({
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: expect.stringContaining(rejection),
            },
          });
          expect(requests).toHaveLength(1);
          expect(requests[0]).toMatchObject(
            protocol === "openai-responses"
              ? {
                  path: "/v1/responses",
                  body: { model: "synthetic", reasoning: { effort: "high" } },
                }
              : {
                  path: "/v1/messages",
                  body: {
                    model: "synthetic",
                    output_config: { effort: "high" },
                    thinking: { type: "adaptive" },
                  },
                },
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
}
