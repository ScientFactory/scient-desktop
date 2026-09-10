// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { beforeAll } from "vite-plus/test";
import { qualifyDroidTestBinary } from "./DroidLiveTestPreflight.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, FileSystem, Path, Redacted, Stream, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as TestClock from "effect/testing/TestClock";
import type { ResolvedModelConnection } from "../../customModels.ts";
import {
  applyDroidModelAndEffort,
  buildDroidModelsFromConfigOptions,
} from "../acp/DroidAcpSupport.ts";
import { droidCustomModelId, makeDroidCustomModelsRuntimeFactory } from "./DroidCustomModels.ts";

const binary = process.env.SCIENT_DROID_TEST_BINARY;
beforeAll(() => qualifyDroidTestBinary(binary), 10_000);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

it.effect.skipIf(!binary)(
  "real Droid transmits corrected efforts and rejects levels its generic transport would remap",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-droid-reasoning-" });
      const requests: Record<string, unknown>[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeHttp.createServer(async (request, response) => {
            if (!request.url?.includes("chat/completions")) {
              response.writeHead(200, { "content-type": "application/json" });
              response.end("{}");
              return;
            }
            let body = "";
            for await (const chunk of request) body += String(chunk);
            requests.push(decodeRequest(body));
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const choice of [
              { index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null },
              { index: 0, delta: {}, finish_reason: "stop" },
            ])
              response.write(
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [choice] })}\n\n`,
              );
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
      const instanceId = ProviderInstanceId.make("droid_reasoning_fixture");
      const connections: ReadonlyArray<ResolvedModelConnection> = [
        {
          id: "reasoning",
          name: "Fixture",
          protocol: "openai-completions",
          baseUrl,
          apiKey: Redacted.make("fixture-key"),
          credentialId: "fixture",
          models: [
            {
              id: "fixture",
              modelId: "scient-generic-reasoning-fixture",
              name: "Fixture",
              instanceIds: [instanceId],
              contextWindow: 128000,
              maxOutputTokens: 1024,
              reasoning: true,
              defaultReasoningLevel: "high",
              images: false,
              reasoningMetadata: {
                status: "known",
                source: "provider",
                supported: true,
                levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
                defaultLevel: "max",
                mandatory: true,
                mode: "effort",
                checkedAt: "2026-09-06T00:00:00.000Z",
                stale: false,
              },
            },
          ],
        },
      ];
      const factory = yield* makeDroidCustomModelsRuntimeFactory(
        {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            customModels: { revision: 0, connections },
          }),
          resolveCustomModels: () => Effect.succeed(connections),
          subscribeChanges: Effect.succeed(Stream.never),
        },
        instanceId,
      );
      const runtime = yield* factory({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        droidSettings: { binaryPath: binary! },
        cwd: root,
        clientInfo: { name: "scient-reasoning-test", version: "0" },
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
      yield* runtime.start().pipe(Effect.timeout("8 seconds"));
      const modelId = droidCustomModelId("reasoning", "fixture");
      yield* applyDroidModelAndEffort({ runtime, requestedModel: modelId, requestedEffort: "max" });
      const model = buildDroidModelsFromConfigOptions(yield* runtime.getConfigOptions).find(
        (entry) => entry.slug === modelId,
      );
      expect(model?.efforts.map((entry) => entry.value)).toEqual(["low", "medium", "high", "max"]);
      expect(model?.currentEffortValue).toBe("max");
      for (const effort of [undefined, "max", "low", "high", "medium"]) {
        yield* applyDroidModelAndEffort({
          runtime,
          requestedModel: modelId,
          requestedEffort: effort,
        });
        const before = requests.length;
        const result = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "Answer briefly. Do not use tools." }] })
          .pipe(Effect.timeout("10 seconds"));
        expect(result.stopReason).toBe("end_turn");
        expect(requests.length).toBeGreaterThan(before);
        expect(requests[before]?.reasoning_effort).toBe(effort ?? "high");
      }
      const before = requests.length;
      for (const effort of ["xhigh", "minimal"]) {
        const result = yield* Effect.exit(
          applyDroidModelAndEffort({ runtime, requestedModel: modelId, requestedEffort: effort }),
        );
        expect(result._tag).toBe("Failure");
      }
      expect(requests.length).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  45000,
);
