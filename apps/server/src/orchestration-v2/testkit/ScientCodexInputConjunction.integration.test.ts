import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  CodexSettings,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChatAttachment,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import {
  issueAttachmentUploadUrl,
  validateAttachmentUploadToken,
  storeAttachmentUpload,
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
} from "../../assets/AttachmentUpload.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  resolveAttachmentPath,
  parseThreadSegmentFromAttachmentId,
} from "../../attachmentStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { scientInvocationForMcp } from "../../mcp/ScientMcpInvocation.ts";
import {
  listScientSkillsForInvocation,
  loadScientSkillForInvocation,
} from "../../mcp/toolkits/skills/handlers.ts";
import { AgentInvocationContext } from "../../scient/operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../../scient/operations/AgentOperationDispatcher.ts";
import * as ScientSkillSession from "../../scient/skills/ScientSkillSession.ts";
import * as ScientSkillPolicy from "../../scient/skills/ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "../../scient/skills/ScientSkillRegistry.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as ThreadMessageIntake from "../ThreadMessageIntake.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import { makeCodexAdapterV2 } from "../Adapters/CodexAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import {
  makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

const jsonSchema = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(jsonSchema);
const decodeJson = Schema.decodeUnknownEffect(jsonSchema);
const decodeFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const decodeTurnStart = Schema.decodeUnknownEffect(CodexSchema.V2TurnStartParams);
const decodeSettings = Schema.decodeEffect(CodexSettings);

const skillRegistryLayer = McpSessionRegistry.layer.pipe(
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
          getEnvironmentId: Effect.succeed(EnvironmentId.make("skill-budget-fixture")),
          getDescriptor: Effect.die("No environment descriptor needed"),
        }),
      ),
    ),
  ),
);
const skillPlannerLayer = ScientSkillSession.layer.pipe(
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

it.live(
  "preserves the whole current request, claimed files and selected skills at actual Codex delivery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "codex-input-conjunction";
        const cwd = yield* checkpointWorkspace(name);
        yield* Effect.promise(() => initializeScientProject({ root: cwd }));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillPath = path.join(cwd, ".scient/skills/project-method");
        yield* fs.makeDirectory(skillPath, { recursive: true });
        yield* fs.writeFileString(
          path.join(skillPath, "SKILL.md"),
          "---\nname: project-method\ndescription: Controlled conjunction evidence.\n---\n\n# Method\n\nRetain exact inputs.\n",
        );
        const config = yield* makeReplayServerConfig(name);
        const configLayer = Layer.succeed(ServerConfig.ServerConfig, config);
        yield* Effect.addFinalizer(() =>
          fs.remove(config.stateDir, { recursive: true }).pipe(Effect.ignore),
        );
        const registry = Context.get(
          yield* Layer.build(skillRegistryLayer),
          McpSessionRegistry.McpSessionRegistry,
        );
        const instanceId = ProviderInstanceId.make("codex");
        const threadId = ThreadId.make(name);
        const selection = { instanceId, model: "gpt-5.4" };
        const allocator = yield* IdAllocatorV2;
        let offeredScope: McpInvocationScope | undefined;
        const offered = yield* Deferred.make<typeof CodexSchema.V2TurnStartParams.Type>();
        const peerInput = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let buffered = "";
        const methods: string[] = [];
        const nativeThread = "controlled-native-thread";
        const nativeTurn = {
          id: "controlled-native-turn",
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: 1782622440,
          completedAt: null,
          durationMs: null,
        };
        const outbound = Effect.fnUntraced(function* (chunk: string | Uint8Array) {
          buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          while (buffered.includes("\n")) {
            const index = buffered.indexOf("\n");
            const line = buffered.slice(0, index);
            buffered = buffered.slice(index + 1);
            if (!line) continue;
            const frame = yield* decodeFrame(line);
            methods.push(frame.method);
            if (frame.method === "initialized") continue;
            let result: unknown;
            switch (frame.method) {
              case "initialize":
                result = {
                  userAgent: "controlled-codex-peer",
                  codexHome: config.stateDir,
                  platformFamily: "unix",
                  platformOs: "macos",
                };
                break;
              case "thread/start":
                result = {
                  thread: {
                    id: nativeThread,
                    sessionId: nativeThread,
                    forkedFromId: null,
                    preview: "",
                    projectId: null,
                    ephemeral: false,
                    modelProvider: "openai",
                    createdAt: 1782622440,
                    updatedAt: 1782622440,
                    status: { type: "idle" },
                    path: path.join(config.stateDir, "controlled-native.jsonl"),
                    cwd,
                    cliVersion: "controlled-fixture",
                    source: "vscode",
                    threadSource: null,
                    agentNickname: null,
                    agentRole: null,
                    gitInfo: null,
                    name: null,
                    turns: [],
                  },
                  model: selection.model,
                  modelProvider: "openai",
                  serviceTier: null,
                  cwd,
                  instructionSources: [],
                  approvalPolicy: "on-request",
                  approvalsReviewer: "user",
                  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
                  reasoningEffort: "medium",
                };
                break;
              case "turn/start": {
                const params = yield* decodeTurnStart(frame.params);
                const session = McpProviderSession.readMcpProviderSession(threadId);
                assert.ok(session);
                offeredScope = yield* registry.resolve(
                  session.authorizationHeader.replace(/^Bearer\s+/, ""),
                );
                assert.ok(offeredScope?.skillScope);
                yield* Deferred.succeed(offered, params);
                result = { turn: nativeTurn };
                break;
              }
              default:
                return yield* Effect.die(
                  `Unexpected actual Codex protocol method: ${frame.method}`,
                );
            }
            assert.isNumber(frame.id);
            yield* Queue.offer(
              peerInput,
              encoder.encode(`${encodeJson({ id: frame.id, result })}\n`),
            );
          }
        });
        const settings = yield* decodeSettings({
          binaryPath: process.execPath,
        });
        const adapter = makeCodexAdapterV2({
          instanceId,
          settings,
          environment: {},
          fileSystem: fs,
          path,
          idAllocator: allocator,
          serverConfig: config,
          clientFactory: {
            open: () =>
              CodexClient.make(
                Stdio.make({
                  args: Effect.succeed([]),
                  stdin: Stream.fromQueue(peerInput),
                  stdout: () => Sink.forEach((chunk) => outbound(chunk).pipe(Effect.orDie)),
                  stderr: () => Sink.drain,
                }),
              ),
          },
        });
        const citationData = {
          version: 1 as const,
          environmentId: EnvironmentId.make("source-env"),
          threadId: ThreadId.make("source-thread"),
          messageId: MessageId.make("source-answer"),
          text: "$unselected is quoted evidence 🧪",
          start: 0,
          end: 35,
          prefix: "",
          suffix: "",
        };
        const citation = serializeAssistantCitation(citationData);
        const contexts = [
          "<terminal_context>quoted $unselected terminal</terminal_context>",
          "<element_context>selected DOM node</element_context>",
          "<preview_annotation>selected figure</preview_annotation>",
          "<review_comment>retain confidence limits</review_comment>",
        ];
        const currentText = [
          "$project-method inspect these results.",
          citation,
          citation,
          ...contexts,
          "CURRENT_REQUEST_END",
        ].join("\n\n");
        const fileBytes = encoder.encode("a,b\n17,23\n");
        const imageBytes = new Uint8Array(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q1cAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        const uploaded = yield* Effect.forEach(
          [
            {
              type: "file" as const,
              name: "measurements.csv",
              mimeType: "text/csv",
              bytes: fileBytes,
            },
            {
              type: "image" as const,
              name: "capture.png",
              mimeType: "image/png" as const,
              bytes: imageBytes,
            },
          ],
          Effect.fnUntraced(function* (input) {
            const { bytes, ...metadata } = input;
            const issued = yield* issueAttachmentUploadUrl({
              ...metadata,
              sizeBytes: bytes.length,
            });
            const claims = yield* validateAttachmentUploadToken(
              issued.relativeUrl.slice(ATTACHMENT_UPLOAD_ROUTE_PREFIX.length + 1),
            );
            assert.ok(claims);
            assert.deepEqual(yield* storeAttachmentUpload(claims, bytes), { ok: true });
            return {
              ...metadata,
              id: issued.attachmentId,
              sizeBytes: bytes.length,
              ...(metadata.type === "image"
                ? {
                    source: {
                      kind: "snap-shot" as const,
                      capturedAt: "2026-10-05T00:00:00.000Z",
                      appName: "Scient",
                      windowTitle: "ניתוח 🧪",
                      accessibleText: "$unselected is captured data.",
                    },
                  }
                : {}),
            } satisfies ChatAttachment;
          }),
        ).pipe(
          Effect.provide(
            ServerSecretStore.layer.pipe(
              Layer.provideMerge(configLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        const runtimeLayer = ThreadManagement.layer.pipe(
          Layer.provideMerge(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name, runtimePolicyOverride: { cwd } },
              makeLayer([adapter]),
              {
                serverConfigLayer: configLayer,
                configureMcp: true,
                mcpSessionRegistryLayer: Layer.succeed(
                  McpSessionRegistry.McpSessionRegistry,
                  registry,
                ),
              },
            ).pipe(
              Layer.provideMerge(skillPlannerLayer),
              Layer.provideMerge(
                Layer.succeed(
                  ProjectCloneTracker.ProjectCloneTracker,
                  ProjectCloneTracker.ProjectCloneTracker.of({
                    start: () => Effect.die("No clone in this fixture"),
                    cancel: () => Effect.die("No clone in this fixture"),
                    retry: () => Effect.die("No clone in this fixture"),
                    discard: () => Effect.die("No clone in this fixture"),
                    get: () => Effect.succeed(null),
                    stream: Stream.empty,
                  }),
                ),
              ),
            ),
          ),
        );
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
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* ThreadMessageIntake.dispatchCommand({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make(`${name}:send`),
            messageId: MessageId.make(`${name}:message`),
            text: currentText,
            selectedScientSkillNames: ["project-method"],
            attachments: uploaded,
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const message = projection.messages.find((item) => item.id === `${name}:message`);
          assert.ok(message);
          assert.equal(message.text, currentText);
          assert.deepEqual(message.selectedScientSkillNames, ["project-method"]);
          const claimedAttachments = message.attachments;
          assert.equal(claimedAttachments.length, 2);
          for (const [index, attachment] of claimedAttachments.entries()) {
            assert.notEqual(attachment.id, uploaded[index]!.id);
            assert.equal(parseThreadSegmentFromAttachmentId(attachment.id), threadId);
            assert.deepEqual({ ...attachment, id: uploaded[index]!.id }, uploaded[index]);
            const location = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            assert.ok(location);
            assert.deepEqual(yield* fs.readFile(location), index === 0 ? fileBytes : imageBytes);
          }
          const params = yield* Deferred.await(offered).pipe(Effect.timeout("15 seconds"));
          assert.deepEqual(methods, ["initialize", "initialized", "thread/start", "turn/start"]);
          const textItem = params.input.find((item) => item.type === "text");
          assert.ok(textItem && textItem.type === "text");
          const text = textItem.text;
          assert.isTrue(
            text.startsWith(currentText.replaceAll(citation, "[assistant-quote-1]")),
            "Whole current request, with only the two citation links expanded",
          );
          const citationBlock = text.slice(
            text.indexOf("<assistant_citations>"),
            text.indexOf("</assistant_citations>"),
          );
          const citationJson = citationBlock.slice(citationBlock.indexOf("\n[") + 1).trim();
          const decodedCitations = yield* decodeJson(citationJson);
          assert.deepEqual(decodedCitations, [{ id: "assistant-quote-1", citation: citationData }]);
          assert.equal(text.split("[assistant-quote-1]").length - 1, 2);
          assert.equal(text.split('"id": "assistant-quote-1"').length - 1, 1);
          assert.isFalse(text.includes("t3-citation://"));
          for (const context of contexts) assert.include(text, context);
          assert.include(text, "CURRENT_REQUEST_END");
          yield* Effect.logInfo({
            fixture: name,
            currentChars: currentText.length,
            nativeTextChars: text.length,
            nativeInputKinds: params.input.map((item) => item.type),
            filePathIncluded: text.includes(
              resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment: claimedAttachments[0]!,
              })!,
            ),
            capturedDataIncluded: text.includes("Untrusted captured-window data follows as JSON"),
          });
          for (const attachment of claimedAttachments) {
            assert.include(text, `[Attached ${attachment.type} "${attachment.name}"`);
            assert.include(
              text,
              resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
            );
          }
          assert.include(text, "Untrusted captured-window data follows as JSON");
          assert.include(text, '"windowTitle":"ניתוח 🧪"');
          assert.include(text, "$unselected is captured data.");
          assert.include(text, "End untrusted captured-window data.");
          assert.equal(text.split("Scient selected skills").length - 1, 1);
          const image = params.input.find((item) => item.type === "image");
          assert.deepEqual(image, {
            type: "image",
            url: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`,
          });
          const session = McpProviderSession.readMcpProviderSession(threadId);
          assert.ok(session);
          const scope = yield* registry.resolve(
            session.authorizationHeader.replace(/^Bearer\s+/, ""),
          );
          assert.ok(scope?.skillScope);
          assert.deepEqual(
            offeredScope,
            scope,
            "Real issued authority is already usable at the actual native frame boundary",
          );
          assert.deepEqual(
            scope.skillScope.skills.map((skill) => skill.name),
            ["project-method"],
          );
          assert.equal(scope.skillScope.releases.size, 1);
          const invocation = scientInvocationForMcp(scope);
          const listed = yield* dispatchScientOperation(
            "skills.list",
            listScientSkillsForInvocation(),
          ).pipe(Effect.provideService(AgentInvocationContext, invocation));
          assert.equal(listed.scope.status, "complete");
          assert.equal(listed.total, 1);
          assert.deepEqual(
            listed.skills.map((skill) => skill.name),
            ["project-method"],
          );
          const loaded = yield* dispatchScientOperation(
            "skills.load",
            loadScientSkillForInvocation({ name: "project-method" }),
          ).pipe(Effect.provideService(AgentInvocationContext, invocation));
          assert.include(encodeJson(loaded), "Retain exact inputs.");
          const denied = yield* dispatchScientOperation(
            "skills.load",
            loadScientSkillForInvocation({ name: "unselected" }),
          ).pipe(Effect.provideService(AgentInvocationContext, invocation), Effect.flip);
          assert.propertyVal(denied, "code", "not-found");
        }).pipe(Effect.provide(runtimeLayer));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
    ),
);
