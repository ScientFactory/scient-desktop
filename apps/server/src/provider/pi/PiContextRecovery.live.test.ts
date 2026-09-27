// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { rejectNonPostRequest } from "./PiLiveTestHelpers.ts";

const binary = process.env.SCIENT_PI_TEST_BINARY;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

for (const outcome of ["success", "compaction-error", "still-full"] as const)
  it.effect.skipIf(!binary)(
    `real Pi context recovery: ${outcome}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-context-recovery-" });
          const profile = `${root}/profile`;
          yield* fs.makeDirectory(profile);
          yield* fs.writeFileString(
            `${profile}/settings.json`,
            json({
              compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024 },
            }),
          );
          const requests: Array<Record<string, unknown>> = [];
          const server = NodeHttp.createServer(async (request, response) => {
            if (rejectNonPostRequest(request, response)) return;
            let raw = "";
            for await (const chunk of request) raw += String(chunk);
            const body = decodeRecord(raw);
            requests.push(body);
            const summary = !Array.isArray(body.tools) || body.tools.length === 0;
            if (summary && outcome === "compaction-error") {
              response.writeHead(400, { "content-type": "application/json" });
              response.end(json({ error: { message: "Synthetic compaction failure" } }));
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              `data: ${json({ id: "fixture", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: summary ? "Completed the first two steps. Continue the pending task without repeating work." : "Completed synthetic step." }, finish_reason: null }] })}\n\ndata: ${json({ id: "fixture", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 20, total_tokens: Math.ceil(raw.length / 4) + 20 } })}\n\ndata: [DONE]\n\n`,
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
          if (!address || typeof address === "string") throw new Error("Missing fixture endpoint");
          yield* fs.writeFileString(
            `${profile}/models.json`,
            json({
              providers: {
                "scient-test": {
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  api: "openai-completions",
                  apiKey: "synthetic",
                  models: [
                    {
                      id: "synthetic",
                      name: "Synthetic",
                      reasoning: false,
                      input: ["text"],
                      contextWindow: 16000,
                      maxTokens: 2048,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            }),
          );
          const instanceId = ProviderInstanceId.make("pi-context-fixture");
          const threadId = ThreadId.make("pi-context-thread");
          const adapter = yield* makePiAdapter({
            binaryPath: binary!,
            providerInstanceId: instanceId,
            stateDir: root,
            attachmentsDir: `${root}/attachments`,
            environment: {
              PATH: process.env.PATH,
              HOME: root,
              PI_CODING_AGENT_DIR: profile,
              PI_TELEMETRY: "0",
              PI_SKIP_VERSION_CHECK: "1",
            },
          });
          yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
          expect(adapter.compaction).toEqual({ type: "slash-command", command: "/compact" });
          const allEvents = [];
          const inputs = [
            "a".repeat(8000),
            "b".repeat(8000),
            "c".repeat(outcome === "still-full" ? 50000 : 32000),
          ];
          if (outcome === "success") inputs.push("/compact");
          for (const [index, input] of inputs.entries()) {
            const collected = yield* adapter.streamEvents.pipe(
              Stream.takeUntil((event) => event.type === "turn.completed"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* adapter.sendTurn({
              threadId,
              input,
              originalInput: input,
              modelSelection: createModelSelection(instanceId, "scient-test/synthetic"),
            });
            const events = Array.from(yield* Fiber.join(collected));
            allEvents.push(...events);
            expect(events.find((event) => event.type === "turn.completed")?.payload.state).toBe(
              outcome !== "success" && index === 2 ? "failed" : "completed",
            );
            if (outcome !== "success" && index === 2) {
              expect(
                events.find((event) => event.type === "runtime.error")?.payload.message,
              ).toContain("automatic recovery could not make room");
            } else {
              expect(events.filter((event) => event.type === "runtime.error")).toEqual([]);
            }
          }
          expect(
            requests.some((body) =>
              json(body).includes("Context was compacted before the next request"),
            ),
          ).toBe(outcome === "success");
          expect(allEvents.filter((event) => event.type === "turn.completed")).toHaveLength(
            inputs.length,
          );
          if (outcome !== "success") {
            // A split turn needs both a history and a turn-prefix summary.
            // Neither failure may dispatch the oversized task to the endpoint.
            expect(requests).toHaveLength(outcome === "still-full" ? 4 : 3);
            expect(
              requests.filter((body) => Array.isArray(body.tools) && body.tools.length > 0),
            ).toHaveLength(2);
          } else expect(requests.length).toBeGreaterThanOrEqual(5);
          yield* adapter.stopAll();
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
