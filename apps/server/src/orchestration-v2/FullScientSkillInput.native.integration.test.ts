// Native and issued-token evidence uses digests, never bearer values.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous wire observation records digests without exposing bearer tokens.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
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
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import {
  issueAttachmentUploadUrl,
  validateAttachmentUploadToken,
  storeAttachmentUpload,
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
} from "../assets/AttachmentUpload.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath, parseThreadSegmentFromAttachmentId } from "../attachmentStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { requireThreadScope, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { scientInvocationForMcp } from "../mcp/ScientMcpInvocation.ts";
import {
  listScientSkillsForInvocation,
  loadScientSkillForInvocation,
} from "../mcp/toolkits/skills/handlers.ts";
import { AgentInvocationContext } from "../scient/operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../scient/operations/AgentOperationDispatcher.ts";
import * as ScientSkillSession from "../scient/skills/ScientSkillSession.ts";
import * as ScientSkillPolicy from "../scient/skills/ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "../scient/skills/ScientSkillRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { makeCodexAdapterV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectStoreV2 } from "./ProjectStore.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

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
const decodeResume = Schema.decodeUnknownEffect(
  Schema.Struct({
    threadId: Schema.String,
    excludeTurns: Schema.Boolean,
  }),
);
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
const runConjunction = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "full-scient-skill-input-conjunction";
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
      const automaticPath = path.join(cwd, ".scient/skills/automatic-method");
      yield* fs.makeDirectory(automaticPath, { recursive: true });
      yield* fs.writeFileString(
        path.join(automaticPath, "SKILL.md"),
        "---\nname: automatic-method\ndescription: Controlled automatic method.\n---\n\n# Automatic\n\nReview the original request.\n",
      );
      const projectIdentity = yield* Effect.promise(() => readScientProjectIdentity(cwd));
      const config = yield* makeReplayServerConfig(name);
      const configLayer = Layer.succeed(ServerConfig.ServerConfig, config);
      const policyLayer = ScientSkillPolicy.layer.pipe(Layer.provide(configLayer));
      const skillPlannerLayer = ScientSkillSession.layer.pipe(
        Layer.provideMerge(policyLayer),
        Layer.provide(ScientSkillRegistry.layerFromCatalog({ releases: [], diagnostics: [] })),
      );
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
      const offered = yield* Queue.unbounded<{
        params: typeof CodexSchema.V2TurnStartParams.Type;
        scope: McpInvocationScope;
        token: string;
      }>();
      const peerInput = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffered = "";
      const methods: string[] = [];
      const nativeOffers: Array<typeof CodexSchema.V2TurnStartParams.Type> = [];
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
            case "thread/resume":
              if (frame.method === "thread/resume") {
                const resumed = yield* decodeResume(frame.params);
                assert.equal(resumed.threadId, nativeThread);
                assert.isTrue(resumed.excludeTurns);
              }
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
              nativeOffers.push(params);
              const session = McpProviderSession.readMcpProviderSession(threadId);
              assert.ok(session);
              const token = session.authorizationHeader.replace(/^Bearer\s+/, "");
              const scope = yield* registry.resolve(token);
              assert.ok(scope?.skillScope);
              yield* Queue.offer(offered, { params, scope, token });
              result = {
                turn: {
                  ...nativeTurn,
                  id:
                    nativeOffers.length === 1
                      ? nativeTurn.id
                      : `${nativeTurn.id}:${nativeOffers.length}`,
                },
              };
              break;
            }
            default:
              return yield* Effect.die(`Unexpected actual Codex protocol method: ${frame.method}`);
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
        crypto: yield* Crypto.Crypto,
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
      const uploadFiles = () =>
        Effect.forEach(
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
      const uploaded = yield* uploadFiles();
      const runtimeLayer = ThreadManagement.layer.pipe(
        Layer.provideMerge(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name, runtimePolicyOverride: { cwd } },
            makeLayer([adapter]),
            {
              layerServerConfig: configLayer,
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
        const waitFor = Effect.fnUntraced(function* (
          predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
        ) {
          const cursor = yield* orchestrator.getThreadEventSequence(threadId);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({
              threadId,
              afterSequence: cursor,
            }),
          );
          const found = yield* Stream.concat(
            Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
            Stream.fromPull(Effect.succeed(pull)).pipe(
              Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
            ),
          ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
          assert.isTrue(Option.isSome(found));
          if (Option.isNone(found))
            return yield* Effect.die("Canonical native state did not converge");
          return found.value;
        });
        const finish = Effect.fnUntraced(function* (turnId: string, ordinal: number) {
          yield* Queue.offer(
            peerInput,
            encoder.encode(
              `${encodeJson({
                method: "turn/completed",
                params: {
                  threadId: nativeThread,
                  turn: {
                    ...nativeTurn,
                    id: turnId,
                    status: "completed",
                    completedAt: 1782622442,
                  },
                },
              })}\n`,
            ),
          );
          yield* waitFor(
            (current) =>
              current.runs.find((run) => run.ordinal === ordinal)?.status === "completed",
          );
        });
        const policy = yield* ScientSkillPolicy.ScientSkillPolicy;
        yield* policy.setProjectSkillPreference(
          projectIdentity.projectId,
          "project-method",
          true,
          "explicit",
        );
        yield* ThreadMessageIntake.dispatchCommand({
          type: "message.dispatch",
          threadId,
          commandId: CommandId.make(`${name}:automatic`),
          messageId: MessageId.make(`${name}:automatic`),
          text: "Review this workspace automatically.",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const automatic = yield* Queue.take(offered).pipe(Effect.timeout("15 seconds"));
        assert.deepEqual(
          automatic.scope.skillScope?.skills.map((skill) => skill.name),
          ["automatic-method"],
        );
        assert.equal(automatic.scope.skillScope?.catalog?.status, "complete");
        assert.equal(automatic.scope.skillScope?.releases.size, 1);
        const automaticText = automatic.params.input.find((part) => part.type === "text");
        assert.ok(automaticText?.type === "text");
        assert.include(automaticText.text, "Review this workspace automatically.");
        assert.include(automaticText.text, `digest ${automatic.scope.skillScope?.catalog?.digest}`);
        assert.notInclude(automaticText.text, "Scient selected skills");
        const automaticInvocation = scientInvocationForMcp(
          yield* requireThreadScope(automatic.scope, "skills.list"),
        );
        const automaticListing = yield* dispatchScientOperation(
          "skills.list",
          listScientSkillsForInvocation(),
        ).pipe(Effect.provideService(AgentInvocationContext, automaticInvocation));
        assert.equal(automaticListing.scope.status, "complete");
        assert.deepEqual(
          automaticListing.skills.map((skill) => skill.name),
          ["automatic-method"],
        );
        const automaticLoaded = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: "automatic-method" }),
        ).pipe(Effect.provideService(AgentInvocationContext, automaticInvocation));
        assert.include(encodeJson(automaticLoaded), "Review the original request.");
        yield* finish(nativeTurn.id, 1);
        yield* policy.setProjectSkillPreference(
          projectIdentity.projectId,
          "automatic-method",
          false,
          "automatic",
        );
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
        const explicit = yield* Queue.take(offered).pipe(Effect.timeout("15 seconds"));
        const params = explicit.params;
        assert.equal(explicit.token, automatic.token);
        assert.deepEqual(methods, [
          "initialize",
          "initialized",
          "thread/start",
          "turn/start",
          "thread/resume",
          "turn/start",
        ]);
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
          explicit.scope,
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
        assert.notEqual(
          scope.skillScope.catalog?.digest,
          automatic.scope.skillScope?.catalog?.digest,
        );
        assert.deepEqual(
          scope.skillScope.skills.map((skill) => skill.invocationPolicy),
          ["explicit"],
        );
        assert.isFalse(
          [...scope.skillScope.releases.keys()].some((key) =>
            automatic.scope.skillScope?.releases.has(key),
          ),
        );
        yield* finish(`${nativeTurn.id}:2`, 2);
        const emptyCommand = CommandId.make(`${name}:empty`);
        const emptyMessageId = MessageId.make(`${name}:empty`);
        yield* ThreadMessageIntake.dispatchCommand({
          type: "message.dispatch",
          threadId,
          commandId: emptyCommand,
          messageId: emptyMessageId,
          text: currentText,
          selectedScientSkillNames: [],
          attachments: claimedAttachments,
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const empty = yield* Queue.take(offered).pipe(Effect.timeout("15 seconds"));
        assert.equal(empty.token, automatic.token);
        assert.deepEqual(
          yield* registry.resolve(empty.token),
          empty.scope,
          "The same real issued token now resolves only the new empty authority",
        );
        assert.equal(empty.scope.skillScope?.catalog?.status, "complete");
        assert.notEqual(empty.scope.skillScope?.catalog?.digest, scope.skillScope.catalog?.digest);
        assert.deepEqual(empty.scope.skillScope?.skills, []);
        assert.deepEqual(empty.scope.skillScope?.releases, new Map());
        const emptyText = empty.params.input.find((part) => part.type === "text");
        assert.ok(emptyText?.type === "text");
        assert.include(emptyText.text, "complete and empty (0 skills)");
        assert.notInclude(emptyText.text, "Scient selected skills");
        assert.include(emptyText.text, "$unselected is captured data.");
        assert.include(emptyText.text, "$project-method inspect these results.");
        const emptyInvocation = scientInvocationForMcp(
          yield* requireThreadScope(empty.scope, "skills.list"),
        );
        const emptyListing = yield* dispatchScientOperation(
          "skills.list",
          listScientSkillsForInvocation(),
        ).pipe(Effect.provideService(AgentInvocationContext, emptyInvocation));
        assert.equal(emptyListing.scope.status, "complete");
        assert.deepEqual(emptyListing.skills, []);
        const removed = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: "project-method" }),
        ).pipe(Effect.provideService(AgentInvocationContext, emptyInvocation), Effect.flip);
        assert.propertyVal(removed, "code", "not-found");
        yield* finish(`${nativeTurn.id}:3`, 3);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(final.providerTurns.length, 3);
        assert.isTrue(final.runs.every((run) => run.status === "completed"));
        assert.deepEqual(
          final.messages
            .filter((item) => item.role === "user")
            .map((item) => ({
              text: item.text,
              selection: item.selectedScientSkillNames,
            })),
          [
            { text: "Review this workspace automatically.", selection: undefined },
            { text: currentText, selection: ["project-method"] },
            { text: currentText, selection: [] },
          ],
        );
        assert.equal(methods.filter((method) => method === "thread/start").length, 1);
        assert.equal(methods.filter((method) => method === "turn/start").length, 3);
        const orderedSections = [
          "<terminal_context>",
          "<element_context>",
          "<preview_annotation>",
          "<review_comment>",
          '[Attached file "measurements.csv"',
          '[Attached image "capture.png"',
          "Untrusted captured-window data",
          "Scient selected skills",
        ];
        const positions = orderedSections.map((section) => text.indexOf(section));
        const evidenceDir = process.env.SCIENT_C718_EVIDENCE_DIR;
        if (evidenceDir) {
          const evidenceRoot =
            "/Users/yaacov/REPOs/ScientFactory/reviews/v1-removal-20261004/control/";
          assert.isTrue(
            evidenceDir.startsWith(evidenceRoot) &&
              !evidenceDir.slice(evidenceRoot.length).includes("/"),
          );
          const hash = (value: string | Uint8Array) =>
            NodeCrypto.createHash("sha256").update(value).digest("hex");
          const fileEvidence = yield* Effect.forEach(
            claimedAttachments,
            Effect.fnUntraced(function* (attachment) {
              const location = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              assert.ok(location);
              const bytes = yield* fs.readFile(location);
              const relativePath =
                attachment.type === "image" ? "owned-capture.png" : "owned-measurements.csv";
              yield* fs.writeFile(path.join(evidenceDir, relativePath), bytes);
              return { attachment, sizeBytes: bytes.length, sha256: hash(bytes), relativePath };
            }),
          );
          const scopeEvidence = [automatic, explicit, empty].map((offer) => ({
            tokenSha256: hash(offer.token),
            status: offer.scope.skillScope?.catalog?.status,
            digest: offer.scope.skillScope?.catalog?.digest,
            skills: offer.scope.skillScope?.skills.map((skill) => ({
              name: skill.name,
              invocationPolicy: skill.invocationPolicy,
            })),
            releaseKeys: [...(offer.scope.skillScope?.releases.keys() ?? [])],
          }));
          yield* fs.writeFileString(
            path.join(evidenceDir, "actual-native-input.json"),
            encodeJson({
              methods,
              offers: nativeOffers,
              sectionNames: orderedSections,
              sectionPositions: positions,
            }),
          );
          yield* fs.writeFileString(
            path.join(evidenceDir, "actual-issued-scope.json"),
            encodeJson(scopeEvidence),
          );
          yield* fs.writeFileString(
            path.join(evidenceDir, "actual-sql-projection.json"),
            encodeJson({
              threadId: final.thread.id,
              runs: final.runs.map((run) => ({
                id: run.id,
                ordinal: run.ordinal,
                status: run.status,
                activeAttemptId: run.activeAttemptId,
                rootNodeId: run.rootNodeId,
              })),
              providerTurns: final.providerTurns.map((turn) => ({
                id: turn.id,
                providerThreadId: turn.providerThreadId,
                runAttemptId: turn.runAttemptId,
                nodeId: turn.nodeId,
                status: turn.status,
                nativeTurnRef: turn.nativeTurnRef,
              })),
              messages: final.messages.map((item) => ({
                id: item.id,
                role: item.role,
                text: item.text,
                selectedScientSkillNames: item.selectedScientSkillNames,
                attachments: item.attachments,
              })),
            }),
          );
          yield* fs.writeFileString(
            path.join(evidenceDir, "actual-owned-files.json"),
            encodeJson(fileEvidence),
          );
        }
        yield* Effect.logInfo({
          fixture: name,
          nativeTurns: 3,
          scopeStatuses: [
            automatic.scope.skillScope?.catalog?.status,
            scope.skillScope.catalog?.status,
            empty.scope.skillScope?.catalog?.status,
          ],
          sectionNames: orderedSections,
          sectionPositions: positions,
        });
        assert.isTrue(
          positions.every(
            (position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!),
          ),
          "The complete owned current input precedes exactly one selected-skill block",
        );
      }).pipe(Effect.provide(runtimeLayer));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
  );

it.live(
  "replaces automatic, explicit full-input and empty skill authority on three actual Codex turns",
  runConjunction,
);
