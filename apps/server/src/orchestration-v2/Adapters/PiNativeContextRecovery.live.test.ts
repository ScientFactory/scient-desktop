// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  binary,
  json,
  decodeRecord,
  layer,
  fixture,
  collect,
  ensure,
} from "./PiNativeTestHarness.ts";

it.layer(layer, { excludeTestServices: true })("real Pi native V2 context recovery", (it) => {
  for (const outcome of ["success", "compaction-error", "still-full", "stop"] as const) {
    it.effect.skipIf(!binary)(
      `recovers native context or settles truthfully: ${outcome}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* fixture(`context-${outcome}`);
            const fs = h.fs;
            const profile = h.profile;
            yield* fs.writeFileString(
              `${profile}/settings.json`,
              json({
                compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1024 },
              }),
            );
            const requests: Array<Record<string, unknown>> = [];
            const compactionStarted = Promise.withResolvers<void>();
            const releaseCompaction = Promise.withResolvers<void>();
            yield* Effect.addFinalizer(() => Effect.sync(() => releaseCompaction.resolve()));
            const server = NodeHttp.createServer(async (request, response) => {
              if (request.method !== "POST") {
                response.writeHead(404).end();
                return;
              }
              let raw = "";
              for await (const chunk of request) raw += String(chunk);
              const body = decodeRecord(raw);
              requests.push(body);
              const summary = !Array.isArray(body.tools) || body.tools.length === 0;
              if (summary && outcome === "stop") {
                compactionStarted.resolve();
                await releaseCompaction.promise;
              }
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
            if (!address || typeof address === "string")
              throw new Error("Missing fixture endpoint");
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

            const runtime = yield* h.open();
            const thread = yield* ensure(h, runtime);
            const c = yield* collect(runtime);
            const inputs = [
              "a".repeat(8000),
              "b".repeat(8000),
              "c".repeat(outcome === "still-full" ? 50000 : 32000),
            ];
            if (outcome === "success") inputs.push("/compact");
            for (const [index, input] of inputs.entries()) {
              const offset = c.events.length;
              yield* h.send(runtime, thread, index + 1, input);
              if (outcome === "stop" && index === 2) {
                yield* Effect.promise(() => compactionStarted.promise);
                const owner = c.events.findLast(
                  (event) =>
                    event.type === "provider_turn.updated" &&
                    event.providerTurn.ordinal === index + 1,
                );
                if (owner?.type !== "provider_turn.updated")
                  return yield* Effect.die("Missing compaction owner");
                yield* runtime.interruptTurn({
                  providerThread: thread,
                  providerTurnId: owner.providerTurn.id,
                  requestRuntimeRestart: true,
                });
                releaseCompaction.resolve();
              }
              const terminal = yield* c.take((event) => event.type === "turn.terminal");
              assert.equal(
                terminal.type === "turn.terminal" ? terminal.status : undefined,
                index !== 2 || outcome === "success"
                  ? "completed"
                  : outcome === "stop"
                    ? "interrupted"
                    : "failed",
              );
              const events = c.events.slice(offset);
              assert.lengthOf(
                events.filter((event) => event.type === "turn.terminal"),
                1,
              );
              const errors = events.filter(
                (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
              );
              if ((outcome === "compaction-error" || outcome === "still-full") && index === 2) {
                assert.include(json(terminal), "automatic recovery could not make room");
              } else assert.lengthOf(errors, 0);
            }
            assert.equal(
              requests.some((body) =>
                json(body).includes("Context was compacted before the next request"),
              ),
              outcome === "success",
            );
            assert.lengthOf(
              c.events.filter((event) => event.type === "turn.terminal"),
              inputs.length,
            );
            if (outcome !== "success") {
              if (outcome !== "stop") assert.lengthOf(requests, outcome === "still-full" ? 4 : 3);
              assert.lengthOf(
                requests.filter((body) => Array.isArray(body.tools) && body.tools.length > 0),
                2,
              );
            } else assert.isAtLeast(requests.length, 5);
          }),
        ),
      60000,
    );
  }
});
