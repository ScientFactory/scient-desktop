// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Clock, Effect, FileSystem, Redacted, Schema, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { beforeAll } from "vite-plus/test";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { droidCustomModelId, makeDroidCustomModelsRuntimeFactory } from "./DroidCustomModels.ts";
import { factoryFixtureBody, qualifyDroidTestBinary } from "./DroidLiveTestPreflight.ts";

const binary = process.env.SCIENT_DROID_TEST_BINARY;
beforeAll(() => qualifyDroidTestBinary(binary), 10_000);

const ChatRequest = Schema.Struct({
  model: Schema.String,
  tools: Schema.optional(
    Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
  ),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
});
const decodeChatRequest = Schema.decodeUnknownSync(Schema.fromJsonString(ChatRequest));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const chunk = (choice: unknown) =>
  `data: ${encodeJson({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [choice] })}\n\n`;

/** A real Droid process with one Scient custom model at `modelBaseUrl`; Factory's API is `origin`. */
const startDroid = Effect.fn("startDroid")(function* (input: {
  readonly origin: string;
  readonly modelBaseUrl: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-request-limit-" });
  const home = NodePath.join(root, "home");
  const tmp = NodePath.join(root, "tmp");
  const cwd = NodePath.join(root, "work");
  for (const directory of [home, tmp, cwd]) NodeFS.mkdirSync(directory, { recursive: true });
  const instanceId = ProviderInstanceId.make("droid_request_limit");
  const connections: ReadonlyArray<ResolvedModelConnection> = [
    {
      id: "limit",
      name: "Limit",
      protocol: "openai-completions",
      baseUrl: input.modelBaseUrl,
      apiKey: Redacted.make("sk-limit-synthetic-0123456789"),
      credentialId: "limit-key",
      models: [
        {
          id: "fixture",
          modelId: "fixture-model",
          name: "Fixture",
          instanceIds: [instanceId],
          configurationMode: "manual",
          contextWindow: 128_000,
          maxOutputTokens: 1024,
          reasoning: false,
          images: false,
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
    cwd,
    clientInfo: { name: "scient-droid-request-limit-test", version: "0" },
    environment: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: `${tmp}/`,
      FACTORY_PROFILE_DIR: NodePath.join(home, "profile"),
      FACTORY_API_KEY: "fk-fixture",
      FACTORY_API_BASE_URL: input.origin,
      FACTORY_TELEMETRY_INGEST_BASE_URL: input.origin,
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
      FACTORY_DISABLE_KEYRING: "true",
      NO_PROXY: "127.0.0.1,localhost,::1",
    },
  });
  yield* runtime.start().pipe(Effect.timeout("20 seconds"));
  yield* runtime.setModel(droidCustomModelId("limit", "fixture"));
  return runtime;
});

/** A loopback server for the test's lifetime. */
const listen = (handler: NodeHttp.RequestListener) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => NodeHttp.createServer(handler)),
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
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

// Verified against Droid 0.228.0: every truncated response makes Droid ask the
// model to continue, without bound (thousands of requests a minute).
it.effect.skipIf(!binary)(
  "real Droid's truncation loop ends at Scient's per-turn limit",
  () =>
    Effect.gen(function* () {
      let agentRequests = 0;
      const origin = yield* listen(async (request, response) => {
        if (!request.url?.endsWith("/chat/completions")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(factoryFixtureBody(request.url));
          return;
        }
        let body = "";
        for await (const part of request) body += String(part);
        // Droid's own session-title request carries no tools and finishes normally.
        const agent = decodeChatRequest(body).tools !== undefined;
        if (agent) agentRequests++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          chunk({
            index: 0,
            delta: { role: "assistant", content: `Partial ${agentRequests} ` },
            finish_reason: null,
          }),
        );
        response.write(chunk({ index: 0, delta: {}, finish_reason: agent ? "length" : "stop" }));
        response.end("data: [DONE]\n\n");
      });
      const runtime = yield* startDroid({ origin, modelBaseUrl: `${origin}/v1` });
      let text = "";
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.sync(() => {
          const update = notification.update;
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
            text += update.content.text;
        }),
      );
      const result = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "Write a very long essay." }] })
        .pipe(Effect.timeout("30 seconds"));
      expect(result.stopReason).toBe("max_tokens");
      expect(runtime.requestLimitBreach?.()?.reason).toBe("truncated-responses");
      // Five consecutive truncations; the title request may reset one streak.
      expect(agentRequests).toBeGreaterThanOrEqual(5);
      expect(agentRequests).toBeLessThanOrEqual(10);
      // Partial output stands.
      expect(text).toContain("Partial 1");
      const settled = agentRequests;
      yield* Effect.sleep("2 seconds");
      expect(agentRequests).toBe(settled);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  120_000,
);

// Droid retries a 5xx about 21 times over 200 s without a word, and ends the
// turn on a 4xx with its message (verified against Droid 0.213.0 and 0.231.0).
it.effect.skipIf(!binary)(
  "real Droid ends the turn at once, with the cause, when the model endpoint cannot be reached",
  () =>
    Effect.gen(function* () {
      const origin = yield* listen((request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(factoryFixtureBody(request.url));
      });
      // A local model server that is not running: nothing listens on its port.
      const stopped = yield* Effect.scoped(listen(() => undefined));
      const runtime = yield* startDroid({ origin, modelBaseUrl: `${stopped}/v1` });
      const started = yield* Clock.currentTimeMillis;
      const failure = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "Say hello." }] })
        .pipe(Effect.timeout("30 seconds"), Effect.flip);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(10_000);
      expect(failure).toMatchObject({
        _tag: "AcpRequestError",
        data: `400 Scient could not connect to ${new URL(stopped).host}: connection refused.`,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  60_000,
);
