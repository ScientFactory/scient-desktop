import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderInstanceConfigMap,
  ThreadId,
  TurnId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { buildRuntimeInstructions } from "../provider/RuntimeInstructions.ts";
import { buildScientAwareness } from "../provider/ScientAwareness.ts";
import * as CodexAdapterV2 from "./Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "./Adapters/CodexAdapterV2.testkit.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { EventStoreV2 } from "./EventStore.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layer as allocatorLayer } from "./IdAllocator.ts";
import { layerFromDrivers as makeDriverLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderAdapterOpenSessionError } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProjectionStoreV2, layerMemory } from "./ProjectionStore.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "./testkit/ProviderReplayHarness.ts";
import { makeProviderReplayGate } from "./testkit/ProviderReplayGate.testkit.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const decodeInstanceConfigMap = Schema.decodeUnknownEffect(ProviderInstanceConfigMap);
const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
  readonly startRequestId?: number;
  readonly cwd?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      // Synthetic request expectation uses Scient's shared client identity;
      // native response/event frames retain their recorded protocol shapes.
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "t3code_desktop",
            title: "Scient Desktop",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
            optOutNotificationMethods: ["turn/diff/updated"],
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: input.startRequestId ?? 2,
        method: "thread/start",
        params: {
          config: CodexAdapterV2.CODEX_THREAD_CONFIG,
          model: "gpt-5.4",
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: input.startRequestId ?? 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: input.cwd ?? "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: input.cwd ?? "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: input.cwd ?? "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
          additionalContext: {
            t3_code_runtime: {
              kind: "application",
              value: buildRuntimeInstructions({
                harness: "Codex",
                model: "gpt-5.4",
                reasoningEffort: "medium",
              }),
            },
            scient_awareness: { kind: "application", value: buildScientAwareness() },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const found = yield* Stream.concat(
    Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  assert.ok(Option.isSome(found));
  return found.value;
});

it.live(
  "retains owned native generated PNG bytes through a running fork and empty completion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mode = "image";
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* checkpointWorkspace(`native-fork-${mode}`);
        const privateRoot = yield* fs.makeTempDirectoryScoped({
          prefix: `scient-native-fork-${mode}-`,
        });
        const home = path.join(privateRoot, "home");
        yield* fs.makeDirectory(home);
        const config = yield* makeReplayServerConfig(`native-fork-${mode}`);
        yield* Effect.addFinalizer(() =>
          fs.remove(config.baseDir, { recursive: true }).pipe(Effect.orDie),
        );
        const database = path.join(privateRoot, "state.sqlite");
        const nativeThreadId = `native-fork-${mode}`;
        const nativeTurnId = `native-turn-${mode}`;
        const nativeItemId = "image-call";
        const threadId = ThreadId.make(`native-fork-${mode}-source`);
        const forkId = ThreadId.make(`native-fork-${mode}-child`);
        const projectId = ProjectId.make(`native-fork-${mode}-project`);
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        const prompt = "Draw an image";
        const imageRoot = path.join(home, "generated_images", nativeThreadId);
        yield* fs.makeDirectory(imageRoot, { recursive: true });
        const sourcePath = path.join(imageRoot, `${nativeItemId}.png`);
        // The original V1 private native-image fixture's complete one-pixel PNG.
        const bytes = new Uint8Array(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        yield* fs.writeFile(sourcePath, bytes);
        const imageEvent: CodexReplay.CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: "native image",
          frame: {
            method: "item/completed",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              item: {
                type: "imageGeneration",
                id: nativeItemId,
                status: "completed",
                savedPath: sourcePath,
                result: "not-an-inline-attachment",
              },
            },
          },
        };
        const endEntries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> = [
          { ...imageEvent, label: "duplicate generated image" },
          {
            type: "emit_inbound" as const,
            label: "assistant completion",
            frame: {
              method: "item/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                item: { type: "agentMessage", id: "empty-answer", text: "", phase: "final_answer" },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn completion",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ];
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          makeCodexReplayTranscript({
            scenario: `running-fork-${mode}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt, cwd }),
              imageEvent,
              ...endEntries.map((entry, index) =>
                index === 0 && entry.type === "emit_inbound"
                  ? { ...entry, label: "after-running-fork" }
                  : entry,
              ),
            ],
          }),
        );
        const gate = makeProviderReplayGate(["after-running-fork"]);
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
        const receipts: Array<{ method: string; payload: unknown }> = [];
        const requests: Array<{ method: string; params: unknown }> = [];
        const driver = yield* CodexReplay.makeReplayDriver(transcript, {
          beforeEmitInbound: (entry) =>
            Effect.promise((signal) => gate.beforeEmit(entry.label, signal)),
        });
        const factoryLayer = Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
          open: (input) =>
            Effect.gen(function* () {
              const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterOpenSessionError({
                      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.provide(context),
              );
              return {
                ...client,
                request: (method, params) =>
                  Effect.sync(() => requests.push({ method, params })).pipe(
                    Effect.andThen(client.request(method, params)),
                  ),
                handleServerNotification: (method, handler) =>
                  client.handleServerNotification(method, (payload) =>
                    handler(payload).pipe(
                      Effect.tap(() => Effect.sync(() => receipts.push({ method, payload }))),
                    ),
                  ),
              } satisfies CodexClient.CodexAppServerClient["Service"];
            }),
        });
        const configMap = yield* decodeInstanceConfigMap({
          codex: {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            config: { homePath: home },
            environment: [
              { name: "HOME", value: home },
              { name: "CODEX_HOME", value: home },
            ],
          },
        });
        const registry = makeDriverLayer({
          drivers: [CodexAdapterV2.CodexAdapterV2Driver],
          configMap,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              factoryLayer,
              Layer.succeed(ServerConfig.ServerConfig, config),
              allocatorLayer,
              NodeServices.layer,
            ),
          ),
        );
        const runtime = () =>
          makeOrchestratorV2ReplayLayerWithRegistry(
            {
              name: `native-fork-${mode}`,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "dangerFullAccess" },
              },
            },
            registry,
            {
              configureMcp: false,
              runEffectWorker: false,
              layerServerConfig: Layer.succeed(ServerConfig.ServerConfig, config),
              layerDatabase: makeSqlitePersistenceLive(database).pipe(
                Layer.provide(NodeServices.layer),
              ),
            },
          );
        const evidence: Record<string, unknown> = {
          mode,
          transcript,
          receipts,
          requests,
          privateHome: home,
        };
        const evidenceDirectory = process.env.SCIENT_NATIVE_FORK_EVIDENCE_DIR;
        const capture = Effect.fnUntraced(function* (phase: string, value: unknown) {
          evidence[phase] = value;
          if (evidenceDirectory !== undefined) {
            yield* fs.makeDirectory(evidenceDirectory, { recursive: true });
            yield* fs.writeFileString(
              path.join(evidenceDirectory, `${mode}.json`),
              yield* encodeEvidence(evidence),
            );
          }
        });
        const main = Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const sink = yield* EventSinkV2;
            const now = yield* DateTime.now;
            yield* sink.commitProjectCommand({
              commandId: CommandId.make(`${mode}-project`),
              projectId,
              commandType: "project.created",
              acceptedAt: now,
              event: {
                eventId: EventId.make(`${mode}-project`),
                aggregateKind: "project",
                aggregateId: projectId,
                occurredAt: DateTime.formatIso(now),
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.created",
                payload: {
                  projectId,
                  title: "Native running fork",
                  workspaceRoot: cwd,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: DateTime.formatIso(now),
                  updatedAt: DateTime.formatIso(now),
                },
              },
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`${mode}-create`),
              threadId,
              projectId,
              title: "Native running fork",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${mode}-send`),
              threadId,
              messageId: MessageId.make(`${mode}-prompt`),
              text: prompt,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            const starting = yield* worker.drain(12).pipe(Effect.forkScoped);
            assert.isTrue(
              yield* Effect.promise(() => gate.waitForReached("after-running-fork")).pipe(
                Effect.timeout("15 seconds"),
              ),
            );

            const source = yield* waitFor(
              threadId,
              (p) =>
                p.runs[0]?.status === "running" &&
                p.providerTurns.some((turn) => turn.nativeAcceptance === "accepted") &&
                p.turnItems.some(
                  (item) => item.type === "assistant_message" && item.attachments?.length === 1,
                ),
            );
            const sourceItem = source.turnItems.find(
              (item) =>
                item.type === "assistant_message" && item.nativeItemRef?.nativeId === nativeItemId,
            );

            assert.ok(sourceItem?.type === "assistant_message");
            assert.equal(source.providerThreads[0]?.nativeThreadRef?.nativeId, nativeThreadId);
            assert.equal(source.providerTurns[0]?.nativeTurnRef?.nativeId, nativeTurnId);
            assert.equal(sourceItem.runId, source.runs[0]!.id);
            assert.equal(sourceItem.providerTurnId, source.providerTurns[0]!.id);
            assert.equal(sourceItem.status, "completed");
            assert.isFalse(sourceItem.streaming);
            assert.ok(sourceItem.attachments);
            const attachment = sourceItem.attachments[0]!;
            assert.equal(attachment.type, "image");
            assert.equal(attachment.name, "generated-image.png");
            assert.equal(attachment.mimeType, "image/png");
            assert.equal(attachment.sizeBytes, bytes.length);
            assert.deepEqual(
              source.messages.find((message) => message.id === sourceItem.messageId)?.attachments,
              sourceItem.attachments,
            );
            const sourceOwned = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            assert.ok(sourceOwned);
            assert.notEqual(sourceOwned, sourcePath);
            assert.deepEqual(yield* fs.readFile(sourceOwned), bytes);

            yield* capture("receivedRunning", source);
            const forkCommandId = CommandId.make(`${mode}-running-fork`);
            yield* (yield* ConversationForkService).dispatch({
              type: "thread.fork",
              commandId: forkCommandId,
              originThreadId: threadId,
              newThreadId: forkId,
              sourceRunningTurnId: TurnId.make(source.runs[0]!.id),
              workspaceMode: "local",
            });
            // A local fork needs no provisioning and is ready at once.
            assert.isFalse(
              (yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId)).some(
                (entry) => entry.request.type === "scient-fork.provision",
              ),
            );
            const frozen = yield* orchestrator.getThreadProjection(forkId);
            assert.equal(frozen.thread.conversationFork?.status, "ready");
            assert.isEmpty(frozen.runs);
            assert.isEmpty(frozen.providerTurns);
            assert.isEmpty(frozen.providerThreads);
            assert.equal(frozen.thread.lineage.parentThreadId, threadId);
            const stillRunning = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(stillRunning.runs[0]?.status, "running");
            assert.equal(stillRunning.runs[0]?.id, source.runs[0]!.id);
            assert.deepEqual(
              stillRunning.providerThreads[0]?.nativeThreadRef,
              source.providerThreads[0]?.nativeThreadRef,
            );
            yield* capture("frozenChild", frozen);
            yield* capture("sourceAfterFork", stillRunning);

            // The answer finished inside a run that is still going, which the source
            // may still touch, so the fork owns a frozen copy. Its file is shared.
            const copied = frozen.turnItems.find(
              (item) => item.inheritedFrom?.itemId === sourceItem!.id,
            );
            assert.ok(copied?.type === "assistant_message");
            assert.notEqual(copied.id, sourceItem.id);
            assert.equal(copied.threadId, forkId);
            assert.isTrue(
              frozen.visibleTurnItems.some(
                (row) => row.sourceThreadId === forkId && row.sourceItemId === copied.id,
              ),
            );
            assert.equal(copied.inheritedFrom?.runId, source.runs[0]!.id);
            assert.isNull(copied.runId);
            assert.isNull(copied.nativeItemRef);
            assert.isNull(copied.providerThreadId);
            assert.isNull(copied.providerTurnId);
            assert.equal(copied.status, "completed");
            assert.equal(copied.text, "");
            assert.notEqual(copied.messageId, sourceItem.messageId);
            assert.equal(copied.inheritedFrom?.threadId, threadId);
            assert.isFalse(copied.streaming);
            assert.deepEqual(copied.attachments, sourceItem.attachments);
            const inheritedMessage = frozen.messages.find(
              (message) => message.id === copied.messageId,
            );
            assert.deepEqual(inheritedMessage?.attachments, copied.attachments);
            assert.isNull(inheritedMessage?.runId);
            assert.isFalse(inheritedMessage?.streaming);
            const childOwned = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: copied.attachments![0]!,
            });
            assert.ok(childOwned);
            assert.equal(childOwned, sourceOwned);
            assert.deepEqual(yield* fs.readFile(childOwned), bytes);
            if (evidenceDirectory !== undefined) {
              yield* fs.copy(sourcePath, path.join(evidenceDirectory, "native-original.png"));
              yield* fs.copy(childOwned, path.join(evidenceDirectory, "child-owned.png"));
              yield* fs.copy(sourceOwned, path.join(evidenceDirectory, "source-owned.png"));
            }
            yield* fs.remove(sourcePath);

            gate.release("after-running-fork");
            yield* waitFor(threadId, (p) =>
              p.providerTurns.some((turn) => turn.status === "completed"),
            );
            yield* Fiber.join(starting);
            yield* worker.drain(12);
            const completed = yield* waitFor(threadId, (p) => p.runs[0]?.status === "completed");
            assert.lengthOf(completed.runs, 1);
            assert.lengthOf(completed.providerTurns, 1);
            assert.equal(completed.runs[0]?.id, source.runs[0]!.id);
            assert.deepEqual(
              completed.providerTurns[0]?.nativeTurnRef,
              source.providerTurns[0]?.nativeTurnRef,
            );
            assert.deepEqual(
              completed.providerThreads[0]?.nativeThreadRef,
              source.providerThreads[0]?.nativeThreadRef,
            );
            const answer = completed.turnItems.find(
              (item) =>
                item.type === "assistant_message" && item.nativeItemRef?.nativeId === nativeItemId,
            );
            assert.ok(answer?.type === "assistant_message");
            assert.equal(answer.status, "completed");
            assert.isFalse(answer.streaming);
            assert.equal(answer.runId, source.runs[0]!.id);
            assert.lengthOf(
              completed.messages.filter((message) => message.id === answer.messageId),
              1,
            );

            assert.equal(answer.text, "");
            assert.deepEqual(answer.attachments, sourceItem.attachments);
            assert.equal(completed.messages.flatMap((message) => message.attachments).length, 1);
            const retainedOwned = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: answer.attachments![0]!,
            });
            assert.ok(retainedOwned);
            assert.deepEqual(yield* fs.readFile(retainedOwned), bytes);

            const emptyAnswer = completed.turnItems.find(
              (item) =>
                item.type === "assistant_message" &&
                item.nativeItemRef?.nativeId === "empty-answer",
            );
            assert.ok(emptyAnswer?.type === "assistant_message");
            assert.equal(emptyAnswer.text, "");
            assert.equal(emptyAnswer.status, "completed");
            assert.isFalse(emptyAnswer.streaming);
            assert.equal(emptyAnswer.runId, source.runs[0]!.id);
            assert.isEmpty(emptyAnswer.attachments ?? []);
            assert.notEqual(emptyAnswer.messageId, answer.messageId);
            assert.deepEqual(yield* orchestrator.getThreadProjection(forkId), frozen);
            yield* capture("completedSource", completed);
            yield* capture("replayDriver", yield* Ref.get(driver.state));
            const replayState = yield* Ref.get(driver.state);
            assert.isNull(replayState.failure);
            assert.equal(replayState.cursor, transcript.entries.length);
            const stored = yield* (yield* EventStoreV2).read({}).pipe(Stream.runCollect);
            yield* capture("storedEvents", stored);
            const rebuilt = yield* Effect.gen(function* () {
              const store = yield* ProjectionStoreV2;
              for (const row of stored) yield* store.apply(row.event);
              return {
                source: yield* store.getThreadProjection(threadId),
                child: yield* store.getThreadProjection(forkId),
              };
            }).pipe(Effect.provide(layerMemory));
            assert.deepEqual(rebuilt.source.messages, completed.messages);
            assert.deepEqual(rebuilt.source.turnItems, completed.turnItems);
            // Inherited history lives in the SQL fork-history table, not the event log;
            // the event replay rebuilds the fork's own records.
            assert.deepEqual(
              rebuilt.child.messages,
              frozen.messages.filter((message) => message.threadId === forkId),
            );
            assert.deepEqual(rebuilt.child.turnItems, frozen.turnItems);
            yield* capture("rebuilt", rebuilt);
            yield* (yield* ProviderSessionManagerV2).closeInstance(modelSelection.instanceId);
            const closed = yield* orchestrator.getThreadProjection(threadId);
            yield* capture("closedSource", closed);
            return { frozen, completed: closed };
          }).pipe(Effect.provide(runtime())),
        );
        const finished = yield* main.pipe(Effect.exit);
        if (finished._tag === "Success") {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* ProjectionStoreV2;
              const source = yield* store.getThreadProjection(threadId);
              const child = yield* store.getThreadProjection(forkId);
              assert.deepEqual(source, finished.value.completed);
              assert.deepEqual(child, finished.value.frozen);
              yield* capture("reopenedSql", { source, child });
            }).pipe(Effect.provide(runtime())),
          );
        }
        yield* capture("runtimeExit", { tag: finished._tag });
        if (evidenceDirectory !== undefined && (yield* fs.exists(database))) {
          yield* fs.copy(database, path.join(evidenceDirectory, `${mode}.sqlite`));
        }
        if (finished._tag === "Failure") return yield* Effect.failCause(finished.cause);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
