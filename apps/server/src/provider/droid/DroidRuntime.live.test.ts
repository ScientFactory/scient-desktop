// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { beforeAll } from "vite-plus/test";
import { factoryFixtureBody, qualifyDroidTestBinary } from "./DroidLiveTestPreflight.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Effect, FileSystem, Path, Redacted, Stream, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import type { ResolvedModelConnection } from "../../customModels.ts";
import { droidCustomModelId, makeDroidCustomModelsRuntimeFactory } from "./DroidCustomModels.ts";

import { classifyDroidRuntimeTestRequest } from "./DroidRuntimeTestRequests.ts";

const binary = process.env.SCIENT_DROID_TEST_BINARY;
beforeAll(() => qualifyDroidTestBinary(binary), 10_000);
const encodeFixtureValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFixtureRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

// The first thing a release must keep: Scient reads these controls at every
// session start and refuses to send without them. Verified against Droid
// 0.213.0 and 0.230.0.
it.effect.skipIf(!binary)(
  "real Droid starts a session with the controls Scient depends on",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-controls-" });
      // Every Factory request goes to this stub; no account or hosted inference is used.
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeHttp.createServer((request, response) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(factoryFixtureBody(request.url));
          }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
              }),
          ),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        {
          committedCustomModels: () => ({ revision: 0, connections: [] }),
          resolveCustomModels: () => Effect.succeed([]),
          subscribeChanges: Effect.succeed(Stream.never),
        },
        ProviderInstanceId.make("droid_controls_fixture"),
      );
      const runtime = yield* factory({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        droidSettings: { binaryPath: binary! },
        cwd: root,
        clientInfo: { name: "scient-droid-controls-test", version: "0" },
        environment: {
          PATH: process.env.PATH,
          HOME: root,
          FACTORY_PROFILE_DIR: path.join(root, "profile"),
          FACTORY_API_KEY: "fk-fixture",
          FACTORY_API_BASE_URL: baseUrl,
          FACTORY_TELEMETRY_INGEST_BASE_URL: baseUrl,
          FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
          FACTORY_DISABLE_KEYRING: "true",
        },
      });
      const started = yield* runtime.start().pipe(Effect.timeout("8 seconds"));
      expect(started.initializeResult.protocolVersion).toBe(1);
      // The API key signs this session in; pairing is what Scient's sign-in starts.
      expect((started.initializeResult.authMethods ?? []).map((method) => method.id)).toEqual(
        expect.arrayContaining(["factory-api-key", "device-pairing"]),
      );
      expect(started.sessionId).not.toBe("");

      const options = yield* runtime.getConfigOptions;
      const choices = (id: string) => {
        const option = options.find((entry) => entry.id === id);
        expect(option?.type, id).toBe("select");
        return option?.type === "select"
          ? option.options.flatMap((entry) =>
              "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
            )
          : [];
      };
      expect(choices("model").length).toBeGreaterThan(0);
      // Every runtime mode Scient maps to an autonomy level, and plan mode.
      expect(choices("autonomy_level")).toEqual(
        expect.arrayContaining(["normal", "spec", "auto-low", "auto-medium", "auto-high"]),
      );
      expect(choices("reasoning_effort").length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  30_000,
);

for (const explicitLimits of [true, false]) {
  it.effect.skipIf(!binary)(
    `real Droid preserves native recovery after a length stop (explicit limits: ${explicitLimits})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-token-limit-" });
        const requests: Record<string, unknown>[] = [];
        const paths: string[] = [];
        const unexpected: Record<string, unknown>[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.createServer(async (request, response) => {
              paths.push(request.url ?? "");
              if (!request.url?.includes("chat/completions")) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(factoryFixtureBody(request.url));
                return;
              }
              let body = "";
              for await (const chunk of request) body += String(chunk);
              const captured = decodeFixtureRequest(body);
              const kind = classifyDroidRuntimeTestRequest(captured);
              if (kind === "unexpected") {
                unexpected.push(captured);
                response.writeHead(400).end();
                return;
              }
              if (kind === "agent") requests.push(captured);
              const limited = kind === "agent" && requests.length === 1;
              const content =
                kind === "title"
                  ? "Fixture session title"
                  : limited
                    ? "Partial fixture answer"
                    : "Recovered fixture answer";
              response.writeHead(200, { "content-type": "text/event-stream" });
              for (const choice of [
                { index: 0, delta: { role: "assistant", content }, finish_reason: null },
                { index: 0, delta: {}, finish_reason: limited ? "length" : "stop" },
              ]) {
                response.write(
                  `data: ${JSON.stringify({
                    id: "fixture",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "fixture",
                    choices: [choice],
                  })}\n\n`,
                );
              }
              response.end("data: [DONE]\n\n");
            }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close(() => resolve());
                  server.closeAllConnections();
                }),
            ),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const sendTitleRequest = Effect.fnUntraced(
          function* () {
            const response = yield* HttpClient.execute(
              HttpClientRequest.post(`${baseUrl}/chat/completions`).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  model: "fixture",
                  messages: [
                    {
                      role: "system",
                      content:
                        "You are a helper that generates concise session titles for a session picker.",
                    },
                  ],
                }),
              ),
            );
            expect(response.status).toBe(200);
            expect(yield* response.text).toContain("Fixture session title");
          },
          Effect.provide(FetchHttpClient.layer),
          Effect.timeout("5 seconds"),
        );
        // Deliberately put auxiliary traffic first, independent of vendor scheduling.
        yield* sendTitleRequest();
        expect(requests).toEqual([]);
        const instanceId = ProviderInstanceId.make("droid_limit_fixture");
        const connections: ReadonlyArray<ResolvedModelConnection> = [
          {
            id: "limits",
            name: "Fixture",
            protocol: "openai-completions",
            baseUrl,
            apiKey: Redacted.make("fixture-key"),
            credentialId: "fixture",
            models: [
              {
                id: "fixture",
                modelId: "fixture",
                name: "Fixture",
                instanceIds: [instanceId],
                ...(explicitLimits ? { contextWindow: 128000, maxOutputTokens: 1024 } : {}),
                configurationMode: explicitLimits ? "manual" : "automatic",
                reasoning: false,
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
              },
            ],
          },
        ];
        const factory = yield* makeDroidCustomModelsRuntimeFactory(
          {
            committedCustomModels: () => ({ revision: 0, connections }),
            resolveCustomModels: () => Effect.succeed(connections),
            subscribeChanges: Effect.succeed(Stream.never),
          },
          instanceId,
        );
        const runtime = yield* factory({
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          droidSettings: { binaryPath: binary! },
          cwd: root,
          clientInfo: { name: "scient-droid-limit-test", version: "0" },
          environment: {
            PATH: process.env.PATH,
            HOME: root,
            FACTORY_PROFILE_DIR: path.join(root, "profile"),
            FACTORY_API_KEY: "fk-fixture",
            FACTORY_API_BASE_URL: baseUrl,
            FACTORY_TELEMETRY_INGEST_BASE_URL: baseUrl,
            FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
            FACTORY_DISABLE_KEYRING: "true",
          },
        });
        let text = "";
        yield* runtime.handleSessionUpdate((notification) =>
          Effect.sync(() => {
            const update = notification.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
              text += update.content.text;
          }),
        );
        yield* runtime.start().pipe(
          Effect.timeout("8 seconds"),
          Effect.tapError(() => Effect.logInfo("Droid fixture startup timeout", paths)),
        );
        yield* runtime
          .setModel(droidCustomModelId("limits", "fixture"))
          .pipe(Effect.timeout("8 seconds"));
        const image =
          "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAWSURBVBiVY/zPwPCfAQ9gwic5fBQAABJbAg7ns3KxAAAAAElFTkSuQmCC";
        const first = yield* runtime
          .prompt({
            prompt: [
              { type: "text", text: "Answer briefly. Do not use tools." },
              { type: "image", data: image, mimeType: "image/png" },
            ],
          })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.tapError(() =>
              Effect.logInfo("Droid fixture request diagnostics", {
                paths,
                requestCount: requests.length,
              }),
            ),
          );
        expect(unexpected).toEqual([]);
        // Only agent requests advance the simulated length stop and recovery.
        expect(requests.length).toBeGreaterThan(1);
        // Droid re-encodes input images; check the actual image part, not identical PNG bytes.
        const wire = encodeFixtureValue(requests[0]?.messages);
        expect(wire.includes('"type":"image_url"')).toBe(true);
        expect(/data:image\/(png|jpeg|webp);base64,/.test(wire)).toBe(true);
        const outputLimit = requests[0]?.max_tokens ?? requests[0]?.max_completion_tokens;
        if (explicitLimits) expect(outputLimit).toBe(1024);
        // Droid 0.213.0 substitutes a fixed ceiling, not endpoint-discovered capacity.
        else expect(outputLimit).toBe(32000);
        expect(text).toContain("Partial fixture answer");
        expect(text).toContain("Recovered fixture answer");
        expect(first.stopReason).toBe("end_turn");
        const recoveredRequestCount = requests.length;
        yield* sendTitleRequest();
        expect(requests).toHaveLength(recoveredRequestCount);
        text = "";
        const next = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Continue briefly. Do not use tools." }],
        });
        expect(next.stopReason).toBe("end_turn");
        expect(text).toContain("Recovered fixture answer");
        expect(unexpected).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
    30_000,
  );
}

it.effect.skipIf(!binary)(
  "real Droid confirms switches and automatic default requests for every BYOK protocol",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-native-switch-" });
      const inference: Array<{ path: string; body: Record<string, unknown> }> = [];
      const unexpected: Record<string, unknown>[] = [];
      // All Factory HTTP traffic is directed to a synthetic server. No account,
      // production profile, API key or hosted inference is used by this test.
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeHttp.createServer(async (request, response) => {
            if (request.url?.match(/\/(chat\/completions|responses|messages)(\?|$)/)) {
              let body = "";
              for await (const chunk of request) body += String(chunk);
              const captured = decodeFixtureRequest(body);
              const kind = classifyDroidRuntimeTestRequest(captured);
              if (kind === "agent") inference.push({ path: request.url, body: captured });
              if (kind === "unexpected") unexpected.push(captured);
              response.writeHead(400, { "content-type": "application/json" });
              response.end(
                '{"error":{"type":"invalid_request_error","message":"Intentional fixture rejection"}}',
              );
              return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(factoryFixtureBody(request.url));
          }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
              }),
          ),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const instanceId = ProviderInstanceId.make("droid_fixture");
      const connections: ReadonlyArray<ResolvedModelConnection> = [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ].map((protocol, index) => ({
        id: `connection-${index}`,
        name: `connection-${index}`,
        protocol: protocol as ResolvedModelConnection["protocol"],
        baseUrl,
        apiKey: Redacted.make("synthetic-key"),
        credentialId: `key-${index}`,
        models: [
          {
            id: `model-${index}`,
            modelId: "z-ai/glm-5.3-flash",
            name: `Fixture ${index}`,
            instanceIds: [instanceId],
            configurationMode: "automatic",
            reasoning: false,
            images: false,
          },
        ],
      }));
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        {
          committedCustomModels: () => ({ revision: 0, connections }),
          resolveCustomModels: () => Effect.succeed(connections),
          subscribeChanges: Effect.succeed(Stream.never),
        },
        instanceId,
      );
      for (const connection of connections) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* factory({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              droidSettings: { binaryPath: binary! },
              cwd: root,
              clientInfo: { name: "scient-droid-test", version: "0" },
              environment: {
                PATH: process.env.PATH,
                HOME: root,
                FACTORY_PROFILE_DIR: path.join(root, "profile"),
                FACTORY_API_KEY: "fk-fixture",
                FACTORY_API_BASE_URL: baseUrl,
                FACTORY_TELEMETRY_INGEST_BASE_URL: baseUrl,
                FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
                FACTORY_DISABLE_KEYRING: "true",
              },
            });
            yield* runtime.start();
            const original = (yield* runtime.getConfigOptions).find(
              (option) => option.id === "model",
            )?.currentValue;
            expect(typeof original).toBe("string");
            const custom = droidCustomModelId(connection.id, connection.models[0]!.id);
            for (const model of [custom, original as string, custom]) {
              yield* runtime.setModel(model);
              const options = yield* runtime.getConfigOptions;
              expect(options.find((option) => option.id === "model")?.currentValue).toBe(model);
              const effort = options.find((option) => option.id === "reasoning_effort");
              // An inherited effort may change with the model. It must remain a live supported choice.
              if (effort?.type === "select") {
                const levels = effort.options.flatMap((entry) =>
                  "value" in entry ? [entry.value] : entry.options.map((nested) => nested.value),
                );
                expect(levels).toContain(effort.currentValue);
              }
            }
            const before = inference.length;
            const title =
              "You are a helper that generates concise session titles for a session picker.";
            const titleRequest =
              connection.protocol === "anthropic-messages"
                ? { system: [{ type: "text", text: title }], messages: [], tools: [] }
                : connection.protocol === "openai-responses"
                  ? { instructions: title, input: [], tools: [] }
                  : { messages: [{ role: "system", content: title }], tools: [] };
            yield* Effect.gen(function* () {
              const route =
                connection.protocol === "anthropic-messages"
                  ? "messages"
                  : connection.protocol === "openai-responses"
                    ? "responses"
                    : "chat/completions";
              const auxiliary = yield* HttpClient.execute(
                HttpClientRequest.post(`${baseUrl}/${route}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    model: connection.models[0]!.modelId,
                    ...titleRequest,
                  }),
                ),
              );
              // This fixture rejects inference intentionally, including recognized titles.
              expect(auxiliary.status).toBe(400);
              yield* auxiliary.text;
            }).pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout("5 seconds"));
            expect(unexpected).toEqual([]);
            expect(inference).toHaveLength(before);
            yield* runtime
              .prompt({ prompt: [{ type: "text", text: "Answer briefly without tools." }] })
              .pipe(Effect.timeout("8 seconds"), Effect.exit);
            expect(unexpected).toEqual([]);
            expect(inference.length).toBeGreaterThan(before);
            const captured = inference[before]!;
            expect(captured.path).toContain(
              connection.protocol === "anthropic-messages"
                ? "/messages"
                : connection.protocol === "openai-responses"
                  ? "/responses"
                  : "/chat/completions",
            );
            expect(
              captured.body.max_tokens ??
                captured.body.max_completion_tokens ??
                captured.body.max_output_tokens,
              connection.protocol,
            ).toBe(131072);
          }),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  30_000,
);
