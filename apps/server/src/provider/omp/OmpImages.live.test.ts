// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { nativeOmpSession } from "../testUtils/nativeOmpSession.ts";
import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";

/**
 * Live proof of decision 6 against a real `omp` (opt in with
 * OMP_QUALIFY_BINARY): a small image reaches the model inline, and an image
 * too large for the RPC frame reaches it through OMP's `read` tool. The model
 * is a local OpenAI-compatible stub that records each request; no paid
 * provider is contacted and the key is synthetic.
 */
const binary = ompQualifyBinary;

/** A real, uncompressed PNG of random pixels, `side` × `side`. */
const noisePng = (side: number): Buffer => {
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((side * 3 + 1) * side);
  let seed = 11;
  for (let index = 0; index < rows.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rows[index] = index % (side * 3 + 1) === 0 ? 0 : seed & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

interface StubRequest {
  readonly imageParts: number;
  readonly toolResult: boolean;
}

/**
 * Answers with a `read` tool call for an attached image path it finds in the
 * user message, and with plain text otherwise.
 */
const startStub = () =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeHttp.Server; readonly requests: Array<StubRequest> }>(
          (resolve) => {
            const requests: Array<StubRequest> = [];
            const server = NodeHttp.createServer((request, response) => {
              let raw = "";
              request.on("data", (chunk) => (raw += chunk));
              request.on("end", () => {
                const body = JSON.parse(raw || "{}") as {
                  readonly messages?: ReadonlyArray<{
                    readonly role: string;
                    readonly content: unknown;
                  }>;
                };
                const messages = body.messages ?? [];
                const parts = messages.flatMap((message) =>
                  Array.isArray(message.content)
                    ? (message.content as ReadonlyArray<{
                        readonly type: string;
                        readonly text?: string;
                      }>)
                    : [],
                );
                const toolResult = messages.some((message) => message.role === "tool");
                requests.push({
                  imageParts: parts.filter((part) => part.type === "image_url").length,
                  toolResult,
                });
                const path = parts
                  .flatMap((part) => (part.text ?? "").split("\n"))
                  .find((line) => line.startsWith('"') && line.includes("attachments"));
                const events: Array<unknown> = [];
                const delta = (value: unknown, finish: string | null = null) =>
                  events.push({
                    id: "stub",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "vision",
                    choices: [{ index: 0, delta: value, finish_reason: finish }],
                  });
                if (path && !toolResult) {
                  delta({ role: "assistant", content: null });
                  delta({
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_read_image",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({
                            path: JSON.parse(path),
                            i: "view the attached image",
                          }),
                        },
                      },
                    ],
                  });
                  delta({}, "tool_calls");
                } else {
                  delta({ role: "assistant", content: "" });
                  delta({ content: "I can see it." });
                  delta({}, "stop");
                }
                response.writeHead(200, { "content-type": "text/event-stream" });
                for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
                response.end("data: [DONE]\n\n");
              });
            });
            server.listen(0, "127.0.0.1", () => resolve({ server, requests }));
          },
        ),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

describe.runIf(binary)("real Oh My Pi image attachments", () => {
  it.effect(
    "sends a small image inline and a 3 MB image through the read tool",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-images-live-${process.pid}`);
          NodeFS.rmSync(root, { recursive: true, force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const { environment, homePath } = ompLiveInstance(root, {
            blockEgress: true,
            baseEnv: { PATH: process.env.PATH ?? "" },
          });
          const attachments = NodePath.join(root, "attachments");
          NodeFS.mkdirSync(attachments, { recursive: true });
          const stub = yield* startStub();
          const address = stub.server.address();
          if (!address || typeof address === "string") throw new Error("stub did not listen");
          const instanceId = ProviderInstanceId.make("omp-images-live");
          const connection: ResolvedModelConnection = {
            id: "stub",
            name: "Stub",
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            credentialId: null,
            apiKey: null,
            models: [
              {
                id: "vision",
                modelId: "vision",
                name: "Vision",
                configurationMode: "manual",
                contextWindow: 128_000,
                maxOutputTokens: 4_096,
                images: true,
                imageInput: "enabled",
                reasoning: false,
                instanceIds: [instanceId],
              },
            ],
          };
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () => Effect.succeed([connection]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          const threadId = ThreadId.make("omp-images-live-thread");
          const session = yield* nativeOmpSession({
            root,
            threadId,
            modelSelection: createModelSelection(instanceId, "scient_stub/vision"),
            target: ompQualifyTarget,
            binaryPath: binary!,
            instanceId,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: attachments,
            environment,
            homePath,
            makeProcess: factory,
          });
          const terminals = yield* Queue.unbounded<ProviderAdapterV2Event>();
          yield* session.events.pipe(
            Stream.runForEach((event) =>
              event.type === "turn.terminal" ? Queue.offer(terminals, event) : Effect.void,
            ),
            Effect.forkScoped,
          );
          const send = (id: string, side: number) =>
            Effect.gen(function* () {
              const image = noisePng(side);
              NodeFS.writeFileSync(NodePath.join(attachments, `${id}.png`), image);
              yield* session.start({
                text: "Describe the attached image.",
                attachments: [
                  {
                    type: "image",
                    id,
                    name: `${id}.png`,
                    mimeType: "image/png",
                    sizeBytes: image.length,
                  },
                ],
              });
              const terminal = yield* Queue.take(terminals).pipe(Effect.timeout("60 seconds"));
              expect(terminal.type).toBe("turn.terminal");
              if (terminal.type !== "turn.terminal") throw new Error("Missing native terminal");
              expect(terminal.status).toBe("completed");
              return image.length;
            });

          // About 600 KB: fits the 1 MiB frame with its base64 overhead.
          const smallBytes = yield* send("small-live-image", 450);
          expect(smallBytes).toBeGreaterThan(550_000);
          expect(stub.requests).toHaveLength(1);
          expect(stub.requests[0]).toEqual({ imageParts: 1, toolResult: false });

          // About 3 MB: attached as a file and opened with the read tool.
          const largeBytes = yield* send("large-live-image", 1000);
          expect(largeBytes).toBeGreaterThan(2_900_000);
          const large = stub.requests.slice(1);
          expect(large).toHaveLength(2);
          // The first request has only the earlier inline image; the read
          // tool's result adds the large one to the second.
          expect(large[0]).toEqual({ imageParts: 1, toolResult: false });
          expect(large[1]).toEqual({ imageParts: 2, toolResult: true });
          yield* session.close;
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    180_000,
  );
});
