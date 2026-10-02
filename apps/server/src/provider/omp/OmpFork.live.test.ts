// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";

/** Real RPC and native tools; only the model is a loopback stub. */
describe.runIf(ompQualifyBinary)("real Oh My Pi fork history", () => {
  it.effect(
    "delivers every byte of a history over one RPC frame, with an image",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-fork-live-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const { environment, homePath } = ompLiveInstance(root, {
            blockEgress: true,
            baseEnv: { PATH: process.env.PATH ?? "" },
          });
          // One long JSON line, like an actual fork handoff. Reading a preview of
          // this line is insufficient: the stub requests every byte range in order.
          const prompt =
            "SCIENT_FORK_CONTEXT_JSON\n" +
            JSON.stringify({
              messages: Array.from({ length: 7000 }, (_, i) => ({
                role: "user",
                text: `entry-${i}:` + "retained history ".repeat(9),
              })),
            }) +
            "\n\nContinue using the complete history and attached image.";
          expect(Buffer.byteLength(prompt)).toBeGreaterThan(1_048_576);
          const chunkSize = 16_384;
          const chunks = Array.from({ length: Math.ceil(prompt.length / chunkSize) }, (_, i) =>
            prompt.slice(i * chunkSize, (i + 1) * chunkSize),
          );
          let delivered = 0;
          let contextPath: string | undefined;
          let sawImage = false;
          let failure: string | undefined;
          const server = NodeHttp.createServer((request, response) => {
            let raw = "";
            request.on("data", (chunk) => {
              raw += chunk;
            });
            request.on("end", () => {
              try {
                const body = JSON.parse(raw) as {
                  messages: Array<{
                    role: string;
                    content: string | Array<{ type: string; text?: string }>;
                  }>;
                };
                const texts = body.messages.flatMap((message) =>
                  typeof message.content === "string"
                    ? [message.content]
                    : message.content.flatMap((part) => part.text ?? []),
                );
                sawImage ||= body.messages.some(
                  (message) =>
                    Array.isArray(message.content) &&
                    message.content.some((part) => part.type === "image_url"),
                );
                if (contextPath === undefined) {
                  const line = texts
                    .flatMap((text) => text.split("\n"))
                    .find(
                      (line) =>
                        line.startsWith('"') &&
                        line.includes("scient-context-") &&
                        line.endsWith('.txt"'),
                    );
                  if (!line) throw new Error("Missing context file in native model input");
                  contextPath = JSON.parse(line) as string;
                } else {
                  const last = body.messages.filter((message) => message.role === "tool").at(-1);
                  const output =
                    typeof last?.content === "string"
                      ? last.content
                      : (last?.content.map((part) => part.text ?? "").join("\n") ?? "");
                  const encoded = output
                    .split("\n")
                    .filter((line) => /^[A-Za-z0-9+/=]+$/u.test(line))
                    .join("");
                  if (Buffer.from(encoded, "base64").toString("utf8") !== chunks[delivered])
                    throw new Error(
                      `Native tool did not deliver complete chunk ${delivered}: ${output.length} bytes: ${output.slice(0, 400)} ... ${output.slice(-200)}`,
                    );
                  delivered += 1;
                }
                response.writeHead(200, { "content-type": "text/event-stream" });
                const delta = (delta: unknown, finish_reason: string | null = null) =>
                  response.write(
                    `data: ${JSON.stringify({ id: "fork-stub", object: "chat.completion.chunk", created: 1, model: "context", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
                  );
                delta({ role: "assistant", content: "" });
                if (delivered < chunks.length) {
                  const escaped = contextPath.replaceAll("'", "'\\''");
                  delta({
                    tool_calls: [
                      {
                        index: 0,
                        id: `read_context_${delivered}`,
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: `dd if='${escaped}' bs=${chunkSize} skip=${delivered} count=1 2>/dev/null | base64 | fold -w 256`,
                            timeout: 10,
                          }),
                        },
                      },
                    ],
                  });
                  delta({}, "tool_calls");
                } else {
                  delta({ content: "All retained history and the image were received." });
                  delta({}, "stop");
                }
                response.end("data: [DONE]\n\n");
              } catch (error) {
                failure = String(error);
                response.writeHead(400, { "content-type": "application/json" });
                response.end(
                  JSON.stringify({ error: { message: failure, type: "invalid_request_error" } }),
                );
              }
            });
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
          );
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Stub did not listen");
          const instanceId = ProviderInstanceId.make("omp-fork-live");
          const connection: ResolvedModelConnection = {
            id: "stub",
            name: "Stub",
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            credentialId: null,
            apiKey: null,
            models: [
              {
                id: "context",
                modelId: "context",
                name: "Context",
                configurationMode: "manual",
                contextWindow: 1_000_000,
                maxOutputTokens: 4096,
                images: true,
                imageInput: "enabled",
                reasoning: false,
                instanceIds: [instanceId],
              },
            ],
          };
          const stateDir = NodePath.join(root, "state");
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () => Effect.succeed([connection]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            stateDir,
          );
          const attachmentsDir = NodePath.join(root, "attachments");
          NodeFS.mkdirSync(attachmentsDir);
          const image = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8n8AAAAASUVORK5CYII=",
            "base64",
          );
          NodeFS.writeFileSync(NodePath.join(attachmentsDir, "fork-image.png"), image);
          const adapter = yield* makeOmpAdapter({
            target: ompQualifyTarget,
            binaryPath: ompQualifyBinary!,
            providerInstanceId: instanceId,
            stateDir,
            attachmentsDir,
            environment,
            homePath,
            makeProcess: factory,
          });
          const terminals = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              event.type === "turn.completed" || event.type === "turn.aborted"
                ? Queue.offer(terminals, event)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          const threadId = ThreadId.make("omp-fork-live-thread");
          yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
          const modelSelection = createModelSelection(instanceId, "scient_stub/context");
          expect(yield* adapter.getModelContextWindow({ threadId, modelSelection })).toBe(
            1_000_000,
          );
          yield* adapter.sendTurn({
            threadId,
            input: prompt,
            originalInput: "Continue using the complete history and attached image.",
            hasContextPreamble: true,
            modelSelection,
            attachments: [
              {
                type: "image",
                id: "fork-image",
                name: "fork-image.png",
                mimeType: "image/png",
                sizeBytes: image.length,
              },
            ],
          });
          const terminal = yield* Queue.take(terminals).pipe(Effect.timeout("120 seconds"));
          expect(failure).toBeUndefined();
          expect(terminal.type).toBe("turn.completed");
          expect(delivered).toBe(chunks.length);
          expect(sawImage).toBe(true);
          const resumeCursor = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          )?.resumeCursor;
          expect(resumeCursor).toBeDefined();
          yield* adapter.stopAll();
          expect(contextPath).toBeDefined();
          expect(NodeFS.existsSync(contextPath!)).toBe(false);
          const resumed = yield* adapter.startSession({
            threadId,
            cwd: root,
            runtimeMode: "full-access",
            resumeCursor,
          });
          expect(resumed.status).toBe("ready");
          yield* adapter.stopAll();
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    180_000,
  );
});
