// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import * as McpRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { readMcpProviderSession } from "@t3tools/provider-core/server/mcpSession";
import { ComputeMcpGateway } from "../../mcp/toolkits/compute/ComputeMcpGateway.ts";
import { WorkspaceBindingResolver } from "../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { WorkspaceBindingResolutionError } from "../../scient/projectScope/WorkspaceBinding.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { nativeOmpOrchestration } from "../testUtils/nativeOmpOrchestration.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
    }),
  ),
);
const files = (root: string, name: string) =>
  NodeFS.readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith(name));
const environment = Layer.succeed(ServerEnvironment, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-native-mcp-authority")),
  getDescriptor: Effect.die("Unused synthetic descriptor"),
});
const testLayer = McpRegistry.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerNodeHttp,
      OmpExecutableGate.layer,
      environment,
      allocatorLayer,
      NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-mcp-authority-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

describe.runIf(ompQualifyBinary)("installed native OMP MCP authority", () => {
  it.live(
    "rejects a stopped session's tool calls at Scient's MCP server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-native-mcp-cli-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const registry = yield* McpSessionRegistry;
          let inventoryCalls = 0;
          const routes = McpHttpServer.ScientComputeToolkitRegistrationLive.pipe(
            Layer.provideMerge(McpHttpServer.layerMcpTransport),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(McpSessionRegistry, registry),
                Layer.succeed(WorkspaceBindingResolver, {
                  ...workspaceResolverForTest(new Map()),
                  resolveThread: () =>
                    Effect.fail(
                      new WorkspaceBindingResolutionError({
                        operation: "native-mcp-test",
                        kind: "project-required",
                      }),
                    ),
                }),
                Layer.succeed(ComputeMcpGateway, {
                  runtimeInventory: () =>
                    Effect.sync(() => {
                      inventoryCalls++;
                      return { languages: [] };
                    }),
                }),
              ),
            ),
          );
          yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
            Layer.build,
          );
          const modelServer = NodeHttp.createServer((request, response) => {
            let raw = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
              raw += chunk;
            });
            request.on("end", () => {
              const body = parse(raw);
              const answered = body.messages.some((message) => message.role === "tool");
              response.writeHead(200, { "content-type": "text/event-stream" });
              const chunk = (delta: unknown, finish: string | null = null) =>
                response.write(
                  `data: ${encode({ id: "inventory", object: "chat.completion.chunk", created: 1, model: "authority", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
                );
              chunk({ role: "assistant", content: "" });
              if (!answered) {
                chunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: "inventory-1",
                      type: "function",
                      function: { name: "scient_compute_inventory", arguments: "{}" },
                    },
                  ],
                });
                chunk({}, "tool_calls");
              } else {
                chunk({ content: "INVENTORY_ACCEPTED" });
                chunk({}, "stop");
              }
              response.end("data: [DONE]\n\n");
            });
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  modelServer.closeAllConnections();
                  modelServer.close(() => resolve());
                }),
            ),
          );
          yield* Effect.promise(
            () => new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve)),
          );
          const address = modelServer.address();
          if (!address || typeof address === "string")
            return yield* Effect.die("Synthetic model did not listen");
          const instanceId = ProviderInstanceId.make("native-mcp-authority");
          const { environment: isolated } = ompLiveInstance(root, {
            blockEgress: true,
            baseEnv: { PATH: process.env.PATH ?? "" },
          });
          const customModels = yield* makeOmpCustomModelsClientFactory(
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
                        id: "authority",
                        modelId: "authority",
                        name: "Authority",
                        configurationMode: "manual",
                        contextWindow: 128_000,
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
          let shutdowns = 0;
          let confirmed = false;
          const f = yield* nativeOmpOrchestration({
            instanceId,
            target: ompQualifyTarget,
            modelSelection: { instanceId, model: "scient_stub/authority" },
            binaryPath: ompQualifyBinary!,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            environment: isolated,
            configureMcp: true,
            mcpSessionRegistryLayer: Layer.succeed(McpSessionRegistry, registry),
            receiptTimeoutMs: 30_000,
            makeProcess: (options) =>
              customModels(options).pipe(
                Effect.map((client) => ({
                  ...client,
                  shutdown: client.shutdown.pipe(
                    Effect.tap((exit) =>
                      Effect.sync(() => {
                        shutdowns++;
                        confirmed = exit.exited === true || exit.code !== null;
                      }),
                    ),
                  ),
                })),
              ),
          });
          yield* f.run(({ send, waitFor }) =>
            Effect.gen(function* () {
              yield* send("Read Scient Compute inventory");
              const completed = yield* waitFor((p) =>
                p.runs.some((row) => row.status === "completed"),
              );
              expect(inventoryCalls).toBe(1);
              expect(
                completed.messages.some(
                  (row) => row.role === "assistant" && row.text.includes("INVENTORY_ACCEPTED"),
                ),
              ).toBe(true);
              const credential = readMcpProviderSession(f.threadId);
              if (!credential) return yield* Effect.die("Missing native MCP credential");
              expect(credential.providerInstanceId).toBe(instanceId);
              const manager = yield* ProviderSessionManagerV2;
              yield* manager.release({
                providerSessionId: completed.providerSessions[0]!.id,
                reason: "manual_shutdown",
              });
              expect(readMcpProviderSession(f.threadId)).toBeUndefined();
              const client = yield* HttpClient.HttpClient;
              const rejected = yield* client.post(credential.endpoint, {
                headers: {
                  authorization: credential.authorizationHeader,
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                },
                body: HttpBody.text(
                  encode({
                    jsonrpc: "2.0",
                    id: "late-call",
                    method: "tools/call",
                    params: { name: "scient_compute_inventory", arguments: {} },
                  }),
                  "application/json",
                ),
              });
              expect(rejected.status).toBe(401);
              expect(yield* rejected.text).toContain("invalid_mcp_credential");
              expect(inventoryCalls).toBe(1);
              expect(shutdowns).toBe(1);
              expect(confirmed).toBe(true);
              expect(files(root, ".session.lock")).toEqual([]);
              expect(files(root, "events.bin")).toEqual([]);
              expect(
                NodeFS.readdirSync(NodePath.join(root, "state"), { recursive: true }).filter(
                  (file) => String(file).includes("scient-extension-"),
                ),
              ).toEqual([]);
            }),
          );
        }),
      ).pipe(Effect.provide(testLayer)),
    90_000,
  );
});
