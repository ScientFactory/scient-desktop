// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
/**
 * The installed agent's own usage report reaches the provider turn: a stub model answers with
 * OpenAI-style usage, and the turn's usage carries the counts and timing the agent's /stats reads.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import { layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { nativeOmpOrchestration } from "../testUtils/nativeOmpOrchestration.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";

const dependencies = Layer.mergeAll(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  allocatorLayer,
  OmpExecutableGate.layer,
  McpProviderSessions.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-usage-" }).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe.runIf(ompQualifyBinary)("installed native OMP turn usage", () => {
  it.live(
    "reports the model request's tokens and timing on the provider turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-usage-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const server = NodeHttp.createServer((request, response) => {
            request.resume();
            request.on("end", () => {
              response.writeHead(200, { "content-type": "text/event-stream" });
              const chunk = (value: object) =>
                response.write(
                  `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: "usage", ...value })}\n\n`,
                );
              chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Counted." } }] });
              chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
              chunk({
                choices: [],
                usage: {
                  prompt_tokens: 1_200,
                  completion_tokens: 40,
                  total_tokens: 1_240,
                  prompt_tokens_details: { cached_tokens: 300 },
                },
              });
              response.end("data: [DONE]\n\n");
            });
          });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("stub did not listen");
          const instanceId = ProviderInstanceId.make("omp-turn-usage");
          const { environment } = ompLiveInstance(root, {
            blockEgress: true,
            baseEnv: { PATH: (yield* HostProcess.Environment).PATH ?? "" },
          });
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () =>
                Effect.succeed([
                  {
                    id: "stub",
                    name: "Stub",
                    protocol: "openai-completions",
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    credentialId: null,
                    apiKey: null,
                    models: [
                      {
                        id: "usage",
                        modelId: "usage",
                        name: "Usage",
                        configurationMode: "manual",
                        contextWindow: 128000,
                        maxOutputTokens: 4096,
                        images: false,
                        reasoning: false,
                        instanceIds: [instanceId],
                      },
                    ],
                  },
                ]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          const cwd = yield* checkpointWorkspace("installed-omp-usage");
          const selection = { instanceId, model: "scient_stub/usage" };
          const f = yield* nativeOmpOrchestration({
            cwd,
            instanceId,
            target: ompQualifyTarget,
            modelSelection: selection,
            binaryPath: ompQualifyBinary!,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            environment,
            receiptTimeoutMs: 30_000,
            makeProcess: factory,
          });
          yield* f.run(({ send, waitFor }) =>
            Effect.gen(function* () {
              const sink = yield* EventSinkV2;
              const now = yield* DateTime.now;
              const projectId = ProjectId.make("usage-project");
              yield* sink.commitProjectCommand({
                commandId: CommandId.make("installed-usage-project"),
                projectId,
                commandType: "project.create",
                acceptedAt: now,
                event: {
                  eventId: EventId.make("installed-usage-project-created"),
                  type: "project.created",
                  aggregateKind: "project",
                  aggregateId: projectId,
                  occurredAt: DateTime.formatIso(now),
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  payload: {
                    projectId,
                    title: "Installed usage",
                    workspaceRoot: cwd,
                    scripts: [],
                    defaultModelSelection: selection,
                    createdAt: DateTime.formatIso(now),
                    updatedAt: DateTime.formatIso(now),
                  },
                },
              });
              yield* send("Count this.");
              const projection = yield* waitFor((p) => p.runs[0]?.status === "completed");
              const usage = projection.providerTurns.find(
                (turn) => turn.status === "completed",
              )?.turnTokenUsage;
              expect(usage).toMatchObject({
                usageScope: "main_agent",
                usageStatus: "complete",
                inputTokens: 1_200,
                outputTokens: 40,
                cachedInputTokens: 300,
                requests: 1,
                failedRequests: 0,
              });
              expect(usage?.modelDurationMs).toBeGreaterThanOrEqual(0);
              expect(usage?.firstTokenMs).toBeGreaterThanOrEqual(0);
            }),
          );
        }).pipe(Effect.provide(dependencies)),
      ),
    60_000,
  );
});
