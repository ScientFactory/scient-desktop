// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Effect, FileSystem, Redacted, Schema, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { beforeAll } from "vite-plus/test";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { droidCustomModelId, makeDroidCustomModelsRuntimeFactory } from "./DroidCustomModels.ts";
import { qualifyDroidTestBinary } from "./DroidLiveTestPreflight.ts";

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

/** Everything the agent can reach from its shell, per the key-exposure review. */
const PROBE_COMMAND = [
  "env",
  // A transform defeats Droid's own output masking.
  "env | rev",
  "echo ---settings---",
  'cat "$FACTORY_RUNTIME_SETTINGS_PATH" | rev',
  'cat "$FACTORY_RUNTIME_SETTINGS_PATH"',
  "echo ---process---",
  "ps eww $PPID",
].join("; ");

/**
 * Droid replaces its session files by rename while it runs (0.213.0 writes a
 * `.tmp` beside them), so a pass that loses a file between listing and reading
 * starts over: the result always comes from one pass that read every file.
 */
const filesContaining = (root: string, needle: string): ReadonlyArray<string> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return NodeFS.readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((entry) => {
        if (!entry.isFile()) return [];
        const file = NodePath.join(entry.parentPath, entry.name);
        return NodeFS.readFileSync(file).includes(needle) ? [file] : [];
      });
    } catch (error) {
      if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

// Verified against Droid 0.213.0, 0.228.0, 0.229.0 and 0.230.0 (SCIENT_DROID_TEST_BINARY,
// SCIENT_DROID_TEST_VERSION=<version>) with a synthetic key and a local stub.
it.effect.skipIf(!binary)(
  "real Droid is given no custom-model key: not in its environment, overlay or process",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-key-isolation-" });
      const home = NodePath.join(root, "home");
      const tmp = NodePath.join(root, "tmp");
      const cwd = NodePath.join(root, "work");
      for (const directory of [home, tmp, cwd]) NodeFS.mkdirSync(directory, { recursive: true });
      const realKey = `sk-isolation-${NodeCrypto.randomBytes(16).toString("hex")}`;
      const modelRequests: Array<{
        readonly authorization: string | undefined;
        readonly request: typeof ChatRequest.Type;
      }> = [];
      let toolCallSent = false;
      // Factory's API and the model API are both this synthetic server.
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeHttp.createServer(async (request, response) => {
            if (!request.url?.endsWith("/chat/completions")) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end("{}");
              return;
            }
            let body = "";
            for await (const part of request) body += String(part);
            const chat = decodeChatRequest(body);
            modelRequests.push({ authorization: request.headers.authorization, request: chat });
            response.writeHead(200, { "content-type": "text/event-stream" });
            const shell = chat.tools?.find((tool) => tool.function.name === "Execute");
            if (shell && !toolCallSent) {
              toolCallSent = true;
              response.write(
                chunk({
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_probe",
                        type: "function",
                        function: {
                          name: "Execute",
                          arguments: encodeJson({
                            summary: "Run key isolation diagnostics",
                            command: PROBE_COMMAND,
                            // Droid 0.213.0 requires the reason with the level; later ones accept it.
                            riskLevelReason: "Read-only diagnostics of the process environment.",
                            riskLevel: "low",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                }),
              );
              response.write(chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }));
            } else {
              response.write(
                chunk({
                  index: 0,
                  delta: { role: "assistant", content: "Done" },
                  finish_reason: null,
                }),
              );
              response.write(chunk({ index: 0, delta: {}, finish_reason: "stop" }));
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
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const instanceId = ProviderInstanceId.make("droid_isolation");
      const connections: ReadonlyArray<ResolvedModelConnection> = [
        {
          id: "isolation",
          name: "Isolation",
          protocol: "openai-completions",
          baseUrl: `${origin}/v1`,
          apiKey: Redacted.make(realKey),
          credentialId: "isolation-key",
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
        clientInfo: { name: "scient-droid-isolation-test", version: "0" },
        environment: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: `${tmp}/`,
          FACTORY_PROFILE_DIR: NodePath.join(home, "profile"),
          FACTORY_API_KEY: "fk-fixture",
          FACTORY_API_BASE_URL: origin,
          FACTORY_TELEMETRY_INGEST_BASE_URL: origin,
          FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
          FACTORY_DISABLE_KEYRING: "true",
          NO_PROXY: "127.0.0.1,localhost,::1",
        },
      });
      const acpTraffic: Array<string> = [];
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.sync(() => {
          acpTraffic.push(encodeJson(notification));
        }),
      );
      yield* runtime.handleRequestPermission((request) =>
        Effect.sync(() => {
          acpTraffic.push(encodeJson(request));
          const allow = request.options.find((option) => option.kind === "allow_once");
          return {
            outcome: allow
              ? { outcome: "selected" as const, optionId: allow.optionId }
              : { outcome: "cancelled" as const },
          };
        }),
      );
      yield* runtime.start().pipe(Effect.timeout("20 seconds"));
      yield* runtime.setModel(droidCustomModelId("isolation", "fixture"));
      yield* runtime.setConfigOption("autonomy_level", "auto-high");
      const result = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "Run the diagnostics." }] })
        .pipe(Effect.timeout("60 seconds"));
      expect(result.stopReason).toBe("end_turn");

      // The model API received the real key in the protocol's header, and only through the broker.
      expect(modelRequests.length).toBeGreaterThanOrEqual(2);
      for (const { authorization } of modelRequests)
        expect(authorization).toBe(`Bearer ${realKey}`);

      // The agent ran every probe; none of their output holds the key.
      const toolOutput = modelRequests
        .flatMap(({ request }) => request.messages)
        .filter((message) => message.role === "tool")
        .map((message) => encodeJson(message.content))
        .join("\n");
      expect(toolOutput).not.toContain(realKey);
      expect(toolOutput).not.toContain([...realKey].toReversed().join(""));
      expect(toolOutput).toContain("FACTORY_RUNTIME_SETTINGS_PATH");
      expect(toolOutput).toContain("---settings---");
      // Droid masks the overlay's apiKey in direct output; reversed, the agent
      // reads the capability, which is all it holds (the documented residual).
      expect(toolOutput).toContain([..."scient-cap-"].toReversed().join(""));
      expect(toolOutput).toContain("---process---");
      // Nothing Droid sent Scient, and nothing it wrote to disk, holds the key.
      expect(acpTraffic.join("\n")).not.toContain(realKey);
      expect(filesContaining(root, realKey)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  120_000,
);

const MODEL_PATHS = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/v1/messages",
} as const;

const WITHHELD =
  "The model endpoint returned HTTP 401. Scient withheld its response because it contained your API key.";

/**
 * What Droid reports for the withheld body, as for any error from that API:
 * the OpenAI formats show `error.message`, Messages shows the whole body.
 */
const REPORTED_ERROR: Record<keyof typeof MODEL_PATHS, string> = {
  "openai-completions": `401 ${WITHHELD}`,
  "openai-responses": `401 ${WITHHELD}`,
  "anthropic-messages": `401 ${encodeJson({ type: "error", error: { type: "scient_withheld", message: WITHHELD } })}`,
};

// Verified against Droid 0.229.0 (SCIENT_DROID_TEST_BINARY=~/.local/bin/droid,
// SCIENT_DROID_TEST_VERSION=0.229.0) with a synthetic key and a local stub.
for (const protocol of Object.keys(MODEL_PATHS) as Array<keyof typeof MODEL_PATHS>) {
  it.effect.skipIf(!binary)(
    `an endpoint's error echoing the key reaches Scient only as Scient's notice (${protocol})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-withheld-" });
        const home = NodePath.join(root, "home");
        const tmp = NodePath.join(root, "tmp");
        const cwd = NodePath.join(root, "work");
        for (const directory of [home, tmp, cwd]) NodeFS.mkdirSync(directory, { recursive: true });
        const realKey = `sk-withheld-${NodeCrypto.randomBytes(16).toString("hex")}`;
        let modelRequests = 0;
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.createServer(async (request, response) => {
              for await (const _part of request);
              if (!request.url?.endsWith(MODEL_PATHS[protocol])) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end("{}");
                return;
              }
              modelRequests++;
              const key =
                request.headers.authorization?.replace(/^Bearer /, "") ??
                String(request.headers["x-api-key"]);
              response.writeHead(401, { "content-type": "application/json" });
              response.end(
                encodeJson({
                  error: {
                    message: `Incorrect API key provided: ${key}.`,
                    type: "invalid_request_error",
                  },
                }),
              );
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
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const instanceId = ProviderInstanceId.make("droid_withheld");
        const connections: ReadonlyArray<ResolvedModelConnection> = [
          {
            id: "withheld",
            name: "Withheld",
            protocol,
            baseUrl: protocol === "anthropic-messages" ? origin : `${origin}/v1`,
            apiKey: Redacted.make(realKey),
            credentialId: "withheld-key",
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
          clientInfo: { name: "scient-droid-withheld-test", version: "0" },
          environment: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: `${tmp}/`,
            FACTORY_PROFILE_DIR: NodePath.join(home, "profile"),
            FACTORY_API_KEY: "fk-fixture",
            FACTORY_API_BASE_URL: origin,
            FACTORY_TELEMETRY_INGEST_BASE_URL: origin,
            FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
            FACTORY_DISABLE_KEYRING: "true",
            NO_PROXY: "127.0.0.1,localhost,::1",
          },
        });
        const acpTraffic: Array<string> = [];
        yield* runtime.handleSessionUpdate((notification) =>
          Effect.sync(() => {
            acpTraffic.push(encodeJson(notification));
          }),
        );
        yield* runtime.start().pipe(Effect.timeout("20 seconds"));
        yield* runtime.setModel(droidCustomModelId("withheld", "fixture"));
        const error = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "Hello." }] })
          .pipe(Effect.timeout("90 seconds"), Effect.flip);
        expect(modelRequests).toBeGreaterThanOrEqual(1);
        // Droid fails the prompt with the endpoint's error, which is Scient's notice.
        expect(error._tag).toBe("AcpRequestError");
        expect(error._tag === "AcpRequestError" && error.data).toBe(REPORTED_ERROR[protocol]);
        expect(acpTraffic.join("\n")).not.toContain(realKey);
        expect(filesContaining(root, realKey)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
    120_000,
  );
}
