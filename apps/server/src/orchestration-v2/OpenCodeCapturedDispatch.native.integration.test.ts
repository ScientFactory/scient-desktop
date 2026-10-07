// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OpenCodeSettings,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "../provider/ScientAwareness.ts";
import { buildRuntimeInstructions } from "../provider/RuntimeInstructions.ts";
import type { OpenCodeRuntimeShape } from "../provider/opencodeRuntime.ts";
import * as ScientSkillSession from "../scient/skills/ScientSkillSession.ts";
import * as ScientSkillRegistry from "../scient/skills/ScientSkillRegistry.ts";
import * as ScientSkillPolicy from "../scient/skills/ScientSkillPolicy.ts";
import { makeOpenCodeAdapterV2, openCodePermissionRules } from "./Adapters/OpenCodeAdapterV2.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";
import { makeLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";
import {
  makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const Prompt = Schema.Struct({
  messageID: Schema.String,
  model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
  agent: Schema.String,
  variant: Schema.String,
  system: Schema.String,
  parts: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
});
const decodePrompt = Schema.decodeUnknownSync(Prompt);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const Permissions = Schema.Array(
  Schema.Struct({
    permission: Schema.String,
    pattern: Schema.String,
    action: Schema.Literals(["allow", "deny", "ask"]),
  }),
);
const decodePermissions = Schema.decodeUnknownSync(Schema.Struct({ permission: Permissions }));
const decodeSettings = Schema.decodeEffect(OpenCodeSettings);
const decodeRegisteredMcp = Schema.decodeUnknownEffect(
  Schema.Struct({
    config: Schema.Struct({
      type: Schema.Literal("remote"),
      url: Schema.String,
      headers: Schema.Struct({ Authorization: Schema.String }),
      oauth: Schema.Literal(false),
    }),
  }),
);

const registryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("opencode-captured-dispatch")),
          getDescriptor: Effect.die("No environment descriptor is needed"),
        }),
      ),
    ),
  ),
);
const skillLayer = ScientSkillSession.layer.pipe(
  Layer.provide(
    Layer.merge(
      ScientSkillRegistry.layerFromCatalog({ releases: [], diagnostics: [] }),
      ScientSkillPolicy.layerFromSnapshot({
        userSkills: [],
        projectSkills: [],
        trustedProjects: [],
      }),
    ),
  ),
);

const awaitProjection = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const result = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  if (Option.isNone(result)) return yield* Effect.die("OpenCode canonical turn did not complete");
  return result.value;
});

it.live(
  "ordinary omitted-selection dispatch preserves the custom OpenCode selection at the actual SDK wire",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "opencode-captured-dispatch";
        const cwd = yield* checkpointWorkspace(name);
        yield* Effect.promise(() => initializeScientProject({ root: cwd }));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* makeReplayServerConfig(name);
        yield* Effect.addFinalizer(() =>
          fs.remove(config.baseDir, { recursive: true }).pipe(Effect.ignore),
        );
        const skillPath = path.join(cwd, ".scient/skills/captured-method");
        yield* fs.makeDirectory(skillPath, { recursive: true });
        yield* fs.writeFileString(
          path.join(skillPath, "SKILL.md"),
          "---\nname: captured-method\ndescription: Controlled selected-method evidence.\n---\n\n# Method\n\nRetain the configured selection.\n",
        );
        const registry = Context.get(
          yield* Layer.build(registryLayer),
          McpSessionRegistry.McpSessionRegistry,
        );
        const threadId = ThreadId.make(name);
        const instanceId = ProviderInstanceId.make("opencode-custom-captured");
        const selection = {
          instanceId,
          model: "anthropic/claude-sonnet-4-5",
          options: [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        };
        const policy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd,
        });
        const nativeId = "controlled-native-custom-session";
        const answer = "The configured instance and selection were retained.";
        const currentText = "Retain this exact ordinary request: 🧪\nDo not substitute defaults.";
        const offered = yield* Deferred.make<typeof Prompt.Type>();
        const wireRequests = yield* Queue.unbounded<{
          readonly prompt: typeof Prompt.Type;
          readonly response: NodeHttp.ServerResponse;
        }>();
        const streams = new Set<NodeHttp.ServerResponse>();
        const sockets = new Set<NodeNet.Socket>();
        const releasePeerConnections = () => {
          for (const socket of sockets) socket.destroy();
        };
        const paths: string[] = [];
        const prompts: Array<typeof Prompt.Type> = [];
        let permissions: typeof Permissions.Type = [];
        const createPermissions: Array<typeof Permissions.Type> = [];
        let installedMcp: unknown;
        let scopeAtWire: McpInvocationScope | undefined;
        let connectCount = 0;
        let foreignConnectCount = 0;
        let sdkDirectory: string | undefined;
        const sendEvent = (event: unknown) => {
          for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        const session = () => ({
          id: nativeId,
          permission: permissions,
          time: { created: 1, updated: 1 },
        });
        // The controlled local peer speaks HTTP/SSE to the installed SDK. It never
        // writes canonical turns or messages; those come from the production worker.
        const server = NodeHttp.createServer(async (request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          const route = `${request.method} ${url.pathname}`;
          paths.push(route);
          try {
            if (route === "GET /event") {
              response.writeHead(200, { "Content-Type": "text/event-stream" });
              streams.add(response);
              response.on("close", () => streams.delete(response));
              response.write(
                `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
              );
              return;
            }
            let text = "";
            for await (const chunk of request) text += chunk.toString();
            const body = text === "" ? undefined : decodeJson(text);
            let result: unknown;
            if (route === "POST /mcp") {
              installedMcp = body;
              result = {};
            } else if (route === "POST /session") {
              permissions = decodePermissions(body).permission;
              createPermissions.push(permissions);
              result = session();
            } else if (route === `PATCH /session/${nativeId}`) {
              permissions = decodePermissions(body).permission;
              result = session();
            } else if (route === `GET /session/${nativeId}`) result = session();
            else if (route === "GET /session/status") result = { [nativeId]: { type: "idle" } };
            else if (route === `GET /session/${nativeId}/children`) result = [];
            else if (route === `POST /session/${nativeId}/abort`) result = true;
            else if (route === `POST /session/${nativeId}/prompt_async`) {
              const prompt = decodePrompt(body);
              prompts.push(prompt);
              Queue.offerUnsafe(wireRequests, { prompt, response });
              return;
            } else throw new Error(`Unexpected controlled OpenCode route: ${route}`);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(result));
          } catch (error) {
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : "Controlled peer failure",
              }),
            );
          }
        });
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        yield* Effect.gen(function* () {
          const { prompt, response } = yield* Queue.take(wireRequests);
          const credential = McpProviderSession.readMcpProviderSession(threadId);
          assert.ok(credential);
          const registeredMcp = yield* decodeRegisteredMcp(installedMcp);
          assert.equal(registeredMcp.config.url, credential.endpoint);
          assert.equal(registeredMcp.config.headers.Authorization, credential.authorizationHeader);
          scopeAtWire = yield* registry.resolve(
            credential.authorizationHeader.replace(/^Bearer\s+/, ""),
          );
          response.writeHead(204);
          response.end();
          yield* Deferred.succeed(offered, prompt);
        }).pipe(Effect.forkScoped);
        const url = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<string>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                  const address = server.address();
                  if (address === null || typeof address === "string")
                    return reject(new Error("No local peer address"));
                  resolve(`http://127.0.0.1:${address.port}`);
                });
              }),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.close(() => resolve());
                  releasePeerConnections();
                  server.closeAllConnections();
                }),
            ),
        );
        const allocator = yield* IdAllocatorV2;
        const runtime = {
          connectToOpenCodeServer: () =>
            Effect.sync(() => {
              connectCount++;
              return { url, external: false, exitCode: null };
            }),
          createOpenCodeSdkClient: (input: { baseUrl: string; directory: string }) => {
            sdkDirectory = input.directory;
            return createOpencodeClient({
              baseUrl: input.baseUrl,
              directory: input.directory,
              throwOnError: true,
            });
          },
        } as unknown as OpenCodeRuntimeShape;
        const settings = yield* decodeSettings({});
        const adapter = makeOpenCodeAdapterV2({
          instanceId,
          settings,
          environment: {},
          runtime,
          idAllocator: allocator,
          serverConfig: config,
        });
        const foreign = makeOpenCodeAdapterV2({
          instanceId: ProviderInstanceId.make("opencode"),
          settings,
          environment: {},
          runtime: {
            ...runtime,
            connectToOpenCodeServer: () =>
              Effect.sync(() => {
                foreignConnectCount++;
                throw new Error("The default OpenCode instance must not be selected");
              }),
          },
          idAllocator: allocator,
          serverConfig: config,
        });
        const layer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name, runtimePolicyOverride: { cwd } },
          makeLayer([adapter, foreign]),
          {
            serverConfigLayer: Layer.succeed(ServerConfig.ServerConfig, config),
            configureMcp: true,
            mcpSessionRegistryLayer: Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry),
          },
        ).pipe(Layer.provideMerge(skillLayer));
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const projectId = ProjectId.make(`${name}:project`);
          const now = "2026-10-05T00:00:00.000Z";
          yield* (yield* ProjectStoreV2).apply({
            sequence: 1,
            eventId: EventId.make(`${name}:project`),
            type: "project.created",
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId,
              title: name,
              workspaceRoot: cwd,
              scripts: [],
              defaultModelSelection: selection,
              createdAt: now,
              updatedAt: now,
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            threadId,
            commandId: CommandId.make(`${name}:create`),
            projectId,
            title: name,
            modelSelection: selection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          const dispatch = {
            type: "message.dispatch" as const,
            threadId,
            commandId: CommandId.make(`${name}:send`),
            messageId: MessageId.make(`${name}:message`),
            text: currentText,
            selectedScientSkillNames: ["captured-method"],
            attachments: [],
            dispatchMode: { type: "start_immediately" as const },
            createdBy: "user" as const,
            creationSource: "web" as const,
          };
          assert.isFalse(Object.hasOwn(dispatch, "modelSelection"));
          yield* orchestrator.dispatch(dispatch);
          const prompt = yield* Deferred.await(offered).pipe(Effect.timeout("15 seconds"));
          assert.equal(connectCount, 1);
          assert.equal(foreignConnectCount, 0);
          assert.equal(sdkDirectory, cwd);
          assert.deepEqual(prompt.model, { providerID: "anthropic", modelID: "claude-sonnet-4-5" });
          assert.equal(prompt.agent, "github-copilot");
          assert.equal(prompt.variant, "high");
          assert.include(prompt.system, buildScientAwareness());
          assert.include(
            prompt.system,
            buildRuntimeInstructions({ harness: "OpenCode", model: selection.model }),
          );
          assert.lengthOf(prompt.parts, 1);
          assert.include(prompt.parts[0]!.text, currentText);
          assert.equal(prompt.parts[0]!.text.split(currentText).length - 1, 1);
          assert.include(prompt.parts[0]!.text, "Scient selected skills");
          assert.deepEqual(createPermissions, [openCodePermissionRules(policy)]);
          assert.deepEqual(permissions, openCodePermissionRules(policy));
          assert.ok(installedMcp);
          assert.ok(scopeAtWire?.skillScope);
          assert.equal(scopeAtWire.threadId, threadId);
          assert.equal(scopeAtWire.providerInstanceId, instanceId);
          assert.isTrue(scopeAtWire.capabilities.has("skills:read"));
          assert.deepEqual(
            scopeAtWire.skillScope.skills.map((skill) => skill.name),
            ["captured-method"],
          );
          const before = yield* awaitProjection(
            threadId,
            (projection) => projection.providerTurns[0]?.nativeAcceptance === "accepted",
          );
          assert.deepEqual(before.thread.modelSelection, selection);
          assert.equal(before.thread.providerInstanceId, instanceId);
          assert.deepEqual(before.runs[0]!.modelSelection, selection);
          assert.equal(before.runs[0]!.runtimeMode, "approval-required");
          assert.equal(before.runs[0]!.interactionMode, "default");
          assert.equal(before.providerThreads[0]!.providerInstanceId, instanceId);
          assert.equal(
            before.messages.find((message) => message.id === dispatch.messageId)?.text,
            currentText,
          );
          sendEvent({
            type: "message.updated",
            properties: {
              sessionID: nativeId,
              info: { id: prompt.messageID, role: "user", time: { created: 1 } },
            },
          });
          sendEvent({
            type: "message.updated",
            properties: {
              sessionID: nativeId,
              info: {
                id: "controlled-answer",
                role: "assistant",
                parentID: prompt.messageID,
                time: { created: 2 },
              },
            },
          });
          sendEvent({
            type: "message.part.updated",
            properties: {
              part: {
                type: "text",
                id: "controlled-answer-text",
                sessionID: nativeId,
                messageID: "controlled-answer",
                text: answer,
              },
            },
          });
          sendEvent({
            type: "session.status",
            properties: { sessionID: nativeId, status: { type: "busy" } },
          });
          sendEvent({
            type: "session.status",
            properties: { sessionID: nativeId, status: { type: "idle" } },
          });
          const completed = yield* awaitProjection(
            threadId,
            (projection) => projection.runs[0]?.status === "completed",
          );
          assert.lengthOf(prompts, 1);
          assert.lengthOf(completed.runs, 1);
          assert.deepEqual(completed.runs[0]!.modelSelection, selection);
          assert.equal(completed.providerTurns[0]!.nativeAcceptance, "accepted");
          assert.isTrue(
            completed.turnItems.some(
              (item) => item.type === "assistant_message" && item.text === answer,
            ),
          );
          assert.equal(paths.filter((route) => route === "POST /session").length, 1);
        }).pipe(
          Effect.onError(() =>
            Effect.logError("Controlled OpenCode fixture phase", {
              paths,
              promptCount: prompts.length,
              connectCount,
              foreignConnectCount,
            }),
          ),
          // Release the test-owned HTTP reader before the provided runtime scope
          // waits for its native event consumer; no provider outcome is fabricated.
          Effect.ensuring(Effect.sync(releasePeerConnections)),
          Effect.provide(layer),
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
);
