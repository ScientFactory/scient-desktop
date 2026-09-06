import { piModelSettings } from "./PiCustomModelsTestHelpers.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ProviderInstanceId, PiSettings, type CustomModelProtocol } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { makePiCustomModelsClientFactory } from "./PiCustomModels.ts";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";

const binary = process.env.SCIENT_PI_TEST_BINARY;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
it.effect.skipIf(!binary)(
  "registers, refreshes and detaches custom models without writing native config",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-custom-models-" });
        const instanceId = ProviderInstanceId.make("pi");
        yield* fs.makeDirectory(root + "/profile");
        const nativeAuth = '{ "openai": { "type": "api_key", "key": "native-test-key" } }';
        yield* fs.writeFileString(root + "/profile/auth.json", nativeAuth);
        let connections: ResolvedModelConnection[] = [
          {
            id: "fixture",
            name: "Fixture",
            protocol: "openai-completions",
            baseUrl: "http://127.0.0.1:9999/v1",
            credentialId: "fixture-secret",
            apiKey: Redacted.make("!literal-test-key"),
            models: [
              {
                id: "model",
                modelId: "test",
                name: "Test model",
                contextWindow: 32000,
                maxOutputTokens: 1000,
                images: false,
                reasoning: false,
                instanceIds: [instanceId],
              },
            ],
          },
        ];
        const healthy = connections[0]!;
        const { apiKey: _key, ...metadata } = healthy;
        const unavailable: ResolvedModelConnection = {
          ...metadata,
          id: "broken",
          credentialError: "Re-enter the API key for Broken in Custom models.",
        };
        connections.push(unavailable);
        connections.push({
          id: "automatic",
          name: "Automatic fixture",
          credentialId: "automatic-secret",
          protocol: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: Redacted.make("different-scient-key"),
          models: [
            {
              id: "native-model",
              modelId: "gpt-4o-mini",
              name: "Native automatic",
              configurationMode: "automatic",
              reasoning: false,
              images: false,
              instanceIds: [instanceId],
            },
            {
              id: "unknown-native",
              modelId: "unknown-scient-test-model",
              name: "Unknown",
              configurationMode: "automatic",
              reasoning: false,
              images: false,
              instanceIds: [instanceId],
            },
            {
              id: "verified-endpoint",
              modelId: "verified-endpoint-model",
              name: "Verified endpoint",
              configurationMode: "automatic",
              reasoning: false,
              images: false,
              instanceIds: [instanceId],
              reasoningMetadata: {
                status: "known",
                source: "provider",
                checkedAt: "2026-09-06T00:00:00.000Z",
                stale: false,
                supported: false,
                levels: [],
                contextWindow: 246000,
                maxOutputTokens: 20000,
                images: true,
              },
            },
          ],
        });
        const factory = yield* makePiCustomModelsClientFactory(
          piModelSettings(
            {
              resolveCustomModels: () => Effect.sync(() => connections),
            },
            instanceId,
          ),
          instanceId,
          root,
        );
        const spawn = {
          command: binary!,
          args: [
            "--no-session",
            "--offline",
            "--no-extensions",
            "--no-context-files",
            "--no-tools",
          ],
          cwd: root,
          env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root + "/profile" },
        };
        let client = yield* factory(spawn);
        const catalog = yield* client.getAvailableModels();
        expect(catalog.models.some((model) => model.provider === "openai")).toBe(true);
        const native = catalog.models.find(
          (model) => model.provider === "openai" && model.id === "gpt-4o-mini",
        )!;
        const automatic = catalog.models.find((model) => model.provider === "scient_automatic")!;
        expect(automatic).toMatchObject({
          id: native.id,
          contextWindow: native.contextWindow,
          maxTokens: native.maxTokens,
          input: native.input,
          reasoning: native.reasoning,
        });
        expect(automatic.contextWindow).toBeGreaterThan(32000);
        expect(automatic.maxTokens).toBeGreaterThan(4096);
        expect(
          catalog.models.find((model) => model.id === "verified-endpoint-model"),
        ).toMatchObject({
          contextWindow: 246000,
          maxTokens: 20000,
          input: ["text", "image"],
        });
        expect(json(catalog)).not.toContain("different-scient-key");
        expect(catalog.models.some((model) => model.id === "unknown-scient-test-model")).toBe(
          false,
        );
        expect(
          yield* client.setModel("scient_automatic", "unknown-scient-test-model").pipe(Effect.flip),
        ).toMatchObject({
          _tag: "PiRpcProtocolError",
          detail: expect.stringContaining("Automatic settings are unavailable"),
        });
        expect(catalog.models.some((model) => model.provider === "scient_broken")).toBe(false);
        expect(catalog.models.find((model) => model.provider === "scient_fixture")?.id).toBe(
          "test",
        );
        expect(json(catalog)).not.toContain("!literal-test-key");
        expect(
          (yield* client.getCommands()).commands.some((c) => c.name === "scient-models-refresh"),
        ).toBe(false);
        const rejected = yield* client.setModel("scient_broken", "test").pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PiRpcProtocolError",
          detail: expect.stringContaining("Re-enter"),
        });
        connections = [{ ...unavailable, id: "fixture" }];
        expect((yield* client.getAvailableModels().pipe(Effect.result))._tag).toBe("Failure");
        client = yield* factory(spawn);
        expect(
          (yield* client.getAvailableModels()).models.some((m) => m.provider === "scient_fixture"),
        ).toBe(false);
        expect(
          (yield* client.getAvailableModels()).models.some((m) => m.provider === "openai"),
        ).toBe(true);
        expect(yield* client.setModel("scient_fixture", "test").pipe(Effect.flip)).toMatchObject({
          _tag: "PiRpcProtocolError",
          detail: expect.stringContaining("Re-enter"),
        });
        connections = [healthy];
        expect(
          (yield* client.getAvailableModels()).models.some((m) => m.provider === "scient_fixture"),
        ).toBe(true);
        yield* client.setModel("scient_fixture", "test");
        connections = [];
        expect((yield* client.getAvailableModels().pipe(Effect.result))._tag).toBe("Failure");
        client = yield* factory(spawn);
        expect(
          (yield* client.getAvailableModels()).models.some((m) => m.provider === "scient_fixture"),
        ).toBe(false);
        expect(yield* fs.exists(root + "/profile/models.json")).toBe(false);
        expect(yield* fs.readFileString(root + "/profile/auth.json")).toBe(nativeAuth);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

function responseEvents(protocol: CustomModelProtocol) {
  const text = '{"title":"Connection ready"}';
  const named = (event: Record<string, unknown>) =>
    `event: ${event.type}\ndata: ${json(event)}\n\n`;
  if (protocol === "anthropic-messages")
    return [
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "synthetic",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      { type: "message_stop" },
    ]
      .map(named)
      .join("");
  if (protocol === "openai-responses") {
    const item = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    return [
      {
        type: "response.created",
        response: { id: "resp_test", object: "response", status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, content: [], status: "in_progress" },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_text.done",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        text,
      },
      {
        type: "response.content_part.done",
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part: item.content[0],
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          object: "response",
          status: "completed",
          output: [item],
          model: "synthetic",
          usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 },
        },
      },
    ]
      .map((event, sequence_number) => named({ ...event, sequence_number }))
      .join("");
  }
  return (
    [
      {
        id: "test",
        object: "chat.completion.chunk",
        model: "synthetic",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      },
      {
        id: "test",
        object: "chat.completion.chunk",
        model: "synthetic",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
      },
    ]
      .map((event) => `data: ${json(event)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

for (const protocol of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
  it.effect.skipIf(!binary)(
    `uses a custom ${protocol} model through native Pi without exposing keys`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-custom-model-api-" });
          const requests: Array<{
            path: string | undefined;
            key: string | undefined;
            body: Record<string, unknown>;
          }> = [];
          const server = NodeHttp.createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += String(chunk);
            requests.push({
              path: request.url,
              key:
                protocol === "anthropic-messages"
                  ? String(request.headers["x-api-key"] ?? "")
                  : request.headers.authorization,
              body: decodeBody(body),
            });
            response
              .writeHead(200, { "content-type": "text/event-stream" })
              .end(responseEvents(protocol));
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
          if (!address || typeof address === "string") throw new Error("Missing test endpoint");
          const instanceId = ProviderInstanceId.make("pi");
          let key: string | null = "!literal-test-key";
          const keys = [
            "!literal-test-key",
            "$literal-key",
            "abc$SCIENT_QA_PRESENT",
            "abc${SCIENT_QA_PRESENT}",
            "abc$SCIENT_QA_MISSING",
            "abc$$tail",
            "abc$!tail",
            "!abc$SCIENT_QA_PRESENT",
            "$$!${SCIENT_QA_PRESENT}$",
            null,
          ];
          const environment = {
            PATH: process.env.PATH,
            HOME: root,
            PI_CODING_AGENT_DIR: root + "/profile",
            SCIENT_QA_PRESENT: "must-not-be-substituted",
          };
          const factory = yield* makePiCustomModelsClientFactory(
            piModelSettings(
              {
                resolveCustomModels: () =>
                  Effect.sync(() => [
                    {
                      id: "fixture",
                      name: "Fixture",
                      protocol,
                      baseUrl: `http://127.0.0.1:${address.port}${protocol === "anthropic-messages" ? "" : "/v1"}`,
                      credentialId: key ? "fixture-secret" : null,
                      apiKey: key ? Redacted.make(key) : null,
                      models: [
                        {
                          id: "model",
                          modelId: "synthetic",
                          name: "Synthetic",
                          contextWindow: 32000,
                          maxOutputTokens: 128,
                          images: false,
                          imageInput: "automatic",
                          reasoningMetadata: {
                            status: "unknown",
                            supported: null,
                            levels: [],
                            source: "provider",
                            checkedAt: "2026-09-06T00:00:00Z",
                            stale: false,
                            images: true,
                          },
                          reasoning: false,
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
          const generation = yield* makePiTextGeneration(
            decodePiSettings({ binaryPath: binary!, enabled: true }),
            environment,
            factory,
          );
          for (const next of keys) {
            key = next;
            expect(
              yield* generation.generateThreadTitle({
                cwd: root,
                message: "Connection test",
                modelSelection: createModelSelection(instanceId, "scient_fixture/synthetic"),
              }),
            ).toEqual({ title: "Connection ready" });
          }
          expect(requests).toHaveLength(keys.length);
          const spawn = {
            command: binary!,
            args: [
              "--no-session",
              "--offline",
              "--no-extensions",
              "--no-context-files",
              "--no-tools",
            ],
            cwd: root,
            env: environment,
          };
          for (const next of keys) {
            key = next;
            const client = yield* factory(spawn);
            yield* client.getAvailableModels();
            yield* client.setModel("scient_fixture", "synthetic");
            const events = yield* client.events.pipe(
              Stream.takeUntil((event) => "type" in event && event.type === "agent_settled"),
              Stream.runCollect,
              Effect.timeout("10 seconds"),
              Effect.forkScoped,
            );
            const image =
              "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAWSURBVBiVY/zPwPCfAQ9gwic5fBQAABJbAg7ns3KxAAAAAElFTkSuQmCC";
            yield* client.prompt("Reply with a connection test title.", [
              { type: "image", data: image, mimeType: "image/png" },
            ]);
            const completed = yield* Fiber.join(events);
            expect(json(completed)).toContain("Connection ready");
            expect(json(requests.at(-1)?.body)).toContain(image);
            expect(json(completed)).not.toContain("literal-test-key");
            yield* client.close();
          }
          expect(requests).toHaveLength(keys.length * 2);
          expect(requests.map((r) => r.key)).toEqual(
            [...keys, ...keys].map((key) => {
              const value = key ?? "scient-keyless";
              return protocol === "anthropic-messages" ? value : "Bearer " + value;
            }),
          );
          for (const request of requests) {
            expect(request.body.model).toBe("synthetic");
            expect(request.body.tools ?? []).toEqual([]);
            expect(json(request.body)).not.toContain("literal-test-key");
          }
          const auth = yield* fs.readFileString(root + "/profile/auth.json");
          expect(auth).not.toContain("literal");
          expect(yield* fs.exists(root + "/profile/models.json")).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 45_000 },
  );
}
