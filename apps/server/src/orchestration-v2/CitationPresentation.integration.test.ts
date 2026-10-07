import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderReplayTranscript,
  ThreadId,
  TurnId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CodexOrchestratorReplayHarness,
  makeReplayServerConfig,
} from "./Adapters/CodexAdapterV2.testkit.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeProviderReplayGate } from "./testkit/ProviderReplayGate.testkit.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./testkit/ReplayTranscriptNdjson.ts";
import { WEB_SEARCH_PROMPT } from "./testkit/fixtures/shared.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";
import * as Snapshot from "../scient/conversationExport/ConversationSnapshotService.ts";
import { prepareScicPackage, sha256Digest } from "../scient/conversationFile/ScicWriter.ts";
import { zipBytesPromise } from "../scient/conversationFile/scic.test-fixtures.ts";
import * as Staging from "../scient/conversationImport/ConversationImportStaging.ts";
import {
  createNativeProjects,
  nativeImportTestLayer,
} from "../scient/conversationImport/conversationImport.native-test-harness.ts";
import {
  destination,
  principal,
} from "../scient/conversationImport/conversationImport.test-fixtures.ts";

const transcriptJson = Schema.fromJsonString(ProviderReplayTranscript);
const encodeTranscriptJson = Schema.encodeEffect(transcriptJson);
const decodeTranscriptJson = Schema.decodeUnknownEffect(transcriptJson);
const encodeStringJson = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const raw =
  "Evidence 😀 שלום \uE200cite\uE202known\uE202missing\uE201; absent \uE200cite\uE202unknown\uE201.";
const display =
  'Evidence 😀 שלום [1](<https://example.test/study> "Study"); absent [citation unavailable].';
const selection = { workLog: false, reasoning: false, throughMessageId: null };
const assistant = (projection: OrchestrationV2ThreadProjection) => {
  const item = projection.turnItems.findLast(
    (entry) => entry.type === "assistant_message" && !entry.streaming,
  );
  assert.ok(item?.type === "assistant_message");
  return item;
};

type ClientMessageEntry = {
  readonly kind?: string;
  readonly type?: string;
  readonly message: { readonly role: string; readonly text: string };
};
type ClientPresenters = {
  readonly web: (input: {
    visibleTurnItems: OrchestrationV2ThreadProjection["visibleTurnItems"];
    optimisticMessages: readonly [];
  }) => ReadonlyArray<ClientMessageEntry>;
  readonly mobile: (
    items: OrchestrationV2ThreadProjection["visibleTurnItems"],
  ) => ReadonlyArray<ClientMessageEntry>;
};
// Load the actual client presenters under the test runner's client module resolution,
// without compiling mobile/web sources as part of the server's NodeNext program.
const loadClients = Effect.promise(async (): Promise<ClientPresenters> => {
  const webUrl = new URL("../../../web/src/session-logic.ts", import.meta.url).href;
  const mobileUrl = new URL("../../../mobile/src/lib/threadActivity.ts", import.meta.url).href;
  const web: unknown = await import(webUrl);
  const mobile: unknown = await import(mobileUrl);
  assert.ok(
    Predicate.isObject(web) && typeof web.deriveTimelineEntriesFromVisibleTurnItems === "function",
  );
  assert.ok(Predicate.isObject(mobile) && typeof mobile.buildThreadFeed === "function");
  return {
    web: web.deriveTimelineEntriesFromVisibleTurnItems as ClientPresenters["web"],
    mobile: mobile.buildThreadFeed as ClientPresenters["mobile"],
  };
});

const assertClients = (clients: ClientPresenters, projection: OrchestrationV2ThreadProjection) => {
  const wire = projectThreadProjectionForWire(projection);
  const web = clients.web({
    visibleTurnItems: wire.visibleTurnItems,
    optimisticMessages: [],
  });
  const mobile = clients.mobile(wire.visibleTurnItems);
  assert.isTrue(
    web.some(
      (entry) =>
        entry.kind === "message" &&
        entry.message.role === "assistant" &&
        entry.message.text === display,
    ),
  );
  assert.isTrue(
    mobile.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.text === display,
    ),
  );
};

it.live(
  "retains raw native citations across SQL restart, frozen reforks and a real SCIC import while presenting safe wire text",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* loadClients;
        const cwd = yield* checkpointWorkspace("citation-presentation");
        const config = yield* makeReplayServerConfig("citation-presentation");
        const recorded = yield* readProviderReplayTranscript(
          new URL("./testkit/fixtures/web_search/codex_transcript.ndjson", import.meta.url),
        );
        // Keep the recorded native request/acknowledgement and delivery protocol;
        // only the controlled answer and search result catalog are changed.
        const recordedJson = yield* encodeTranscriptJson(recorded);
        const rawJson = yield* encodeStringJson(raw);
        const answerFrames = yield* decodeTranscriptJson(
          recordedJson.replaceAll('"web search fixture complete"', rawJson),
        );
        const controlled = {
          ...answerFrames,
          entries: answerFrames.entries.map((entry) => {
            if (entry.type !== "emit_inbound" || !Predicate.isObject(entry.frame)) return entry;
            const frame = entry.frame;
            if (frame.method === "turn/completed") return { ...entry, label: "citation-terminal" };
            if (
              frame.method !== "item/completed" ||
              !Predicate.isObject(frame.params) ||
              !Predicate.isObject(frame.params.item) ||
              frame.params.item.type !== "webSearch"
            )
              return entry;
            return {
              ...entry,
              frame: {
                ...frame,
                params: {
                  ...frame.params,
                  item: {
                    ...frame.params.item,
                    results: [
                      ["known", { url: "https://example.test/study", title: "Study" }],
                      ["unsafe", { url: "javascript:alert(1)" }],
                    ],
                  },
                },
              },
            };
          }),
        };
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(controlled, cwd),
        );
        const gate = makeProviderReplayGate(["citation-terminal"]);
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
        const database = makeSqlitePersistenceLive(config.dbPath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const base = makeOrchestratorV2ReplayLayerWithRegistry(
          {
            name: "citation-presentation",
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: { type: "dangerFullAccess" },
            },
          },
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, {
            replayGate: gate,
          }),
          {
            serverConfigLayer: Layer.succeed(ServerConfig, config),
            databaseLayer: database,
            configureMcp: false,
            runEffectWorker: true,
          },
        );
        const native = Layer.merge(Snapshot.layer, ProjectionMaintenance.layer).pipe(
          Layer.provideMerge(base.pipe(Layer.provideMerge(database))),
        );
        const threadId = ThreadId.make("citation-source");
        const forkId = ThreadId.make("citation-fork");
        const reforkId = ThreadId.make("citation-refork");
        const frozen = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const sink = yield* EventSinkV2;
            const forks = yield* ConversationForkService;
            const now = yield* DateTime.now;
            const projectId = ProjectId.make("citation-project");
            const modelSelection = {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-6-luna",
            };
            yield* sink.commitProjectCommand({
              commandId: CommandId.make("citation-project"),
              projectId,
              commandType: "project.created",
              acceptedAt: now,
              event: {
                eventId: EventId.make("citation-project"),
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
                  title: "Citations",
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
              commandId: CommandId.make("citation-thread"),
              threadId,
              projectId,
              title: "Citations",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            const waitFor = Effect.fnUntraced(function* (
              id: ThreadId,
              predicate: (p: OrchestrationV2ThreadProjection) => boolean,
            ) {
              const cursor = yield* orchestrator.getThreadEventSequence(id);
              const pull = yield* Stream.toPull(
                orchestrator.streamStoredEventsFrom({ threadId: id, afterSequence: cursor }),
              );
              const initial = yield* orchestrator.getThreadProjection(id);
              const found = yield* Stream.concat(
                Stream.succeed(initial),
                Stream.fromPull(Effect.succeed(pull)).pipe(
                  Stream.mapEffect(() => orchestrator.getThreadProjection(id)),
                ),
              ).pipe(
                Stream.filter(predicate),
                Stream.runHead,
                Effect.timeout("15 seconds"),
                Effect.catchTag("TimeoutError", () =>
                  Effect.die(`Citation projection predicate did not settle: ${id}`),
                ),
              );
              assert.ok(Option.isSome(found));
              return found.value;
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("citation-prompt"),
              threadId,
              messageId: MessageId.make("citation-prompt"),
              text: WEB_SEARCH_PROMPT,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            assert.isTrue(
              yield* Effect.promise(() => gate.waitForReached("citation-terminal")).pipe(
                Effect.timeout("15 seconds"),
                Effect.catchTag("TimeoutError", () =>
                  Effect.die("Native citation terminal gate was not reached"),
                ),
              ),
            );
            const received = yield* waitFor(threadId, (p) =>
              p.turnItems.some(
                (item) => item.type === "assistant_message" && !item.streaming && item.text === raw,
              ),
            );
            assert.equal(received.runs[0]?.status, "running");
            const item = assistant(received);
            assert.equal(item.text, raw);
            assert.equal(received.messages.find((m) => m.id === item.messageId)?.text, raw);
            assert.equal(assistant(projectThreadProjectionForWire(received)).text, display);
            assertClients(clients, received);
            const rawEvents = yield* (yield* EventStore.EventStoreV2)
              .read({ threadId })
              .pipe(Stream.runCollect);
            const wireEvents = yield* sink
              .stream({ threadId, afterSequence: 0, bounded: true })
              .pipe(
                Stream.take(rawEvents.length),
                Stream.runCollect,
                Effect.timeout("15 seconds"),
                Effect.catchTag("TimeoutError", () =>
                  Effect.die("Bounded citation event replay did not finish"),
                ),
              );
            assert.isTrue(
              rawEvents.some(
                ({ event }) =>
                  event.type === "message.updated" &&
                  event.payload.role === "assistant" &&
                  event.payload.text === raw,
              ),
            );
            assert.isTrue(
              wireEvents.some(
                ({ event }) =>
                  event.type === "message.updated" &&
                  event.payload.role === "assistant" &&
                  event.payload.text === display,
              ),
            );
            assert.isTrue(
              wireEvents.some(
                ({ event }) =>
                  event.type === "turn-item.updated" &&
                  event.payload.type === "assistant_message" &&
                  event.payload.text === display,
              ),
            );
            yield* forks.dispatch({
              type: "thread.fork",
              commandId: CommandId.make("citation-fork"),
              originThreadId: threadId,
              newThreadId: forkId,
              sourceRunningTurnId: TurnId.make(received.runs[0]!.id),
              workspaceMode: "local",
            });
            const child = yield* orchestrator.getThreadProjection(forkId);
            assert.isNull(assistant(child).nativeItemRef);
            assert.equal(assistant(child).text, raw);
            assert.deepEqual(assistant(child).citationPresentation, item.citationPresentation);
            assert.equal(assistant(projectThreadProjectionForWire(child)).text, display);
            assertClients(clients, child);
            yield* forks.dispatch({
              type: "thread.fork",
              commandId: CommandId.make("citation-refork"),
              originThreadId: forkId,
              newThreadId: reforkId,
              sourceAssistantMessageId: assistant(child).messageId,
              workspaceMode: "local",
            });
            const reforked = yield* orchestrator.getThreadProjection(reforkId);
            assert.equal(assistant(reforked).text, raw);
            assert.isNull(assistant(reforked).nativeItemRef);
            assert.equal(assistant(projectThreadProjectionForWire(reforked)).text, display);
            assertClients(clients, reforked);
            gate.release("citation-terminal");
            yield* waitFor(threadId, (p) => p.runs[0]?.status === "completed");
            yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
            assert.equal(assistant(yield* orchestrator.getThreadProjection(threadId)).text, raw);
            assert.equal(
              assistant(
                projectThreadProjectionForWire(yield* orchestrator.getThreadProjection(reforkId)),
              ).text,
              display,
            );
            return yield* (yield* Snapshot.ConversationSnapshotService).capture({
              threadId: reforkId,
              selection,
            });
          }).pipe(Effect.provide(native)),
        );
        // Dispose every native runtime and SQL owner, then reopen the actual same database.
        const reopened = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
          Layer.provideMerge(database),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ProjectionStore.ProjectionStoreV2;
            const source = yield* store.getThreadProjection(threadId);
            const child = yield* store.getThreadProjection(reforkId);
            assert.equal(assistant(source).text, raw);
            assert.equal(assistant(child).text, raw);
            assert.deepEqual(
              assistant(source).citationPresentation,
              assistant(child).citationPresentation,
            );
            assert.equal(assistant(projectThreadProjectionForWire(child)).text, display);
            assertClients(clients, child);
          }).pipe(Effect.provide(reopened)),
        );
        assert.equal(frozen.snapshot.messages.findLast((m) => m.role === "assistant")?.text, raw);
        const prepared = prepareScicPackage({
          snapshot: frozen.snapshot,
          attachments: new Map(),
          exportValue: "citation-export",
          exportedAt: DateTime.formatIso(yield* DateTime.now),
          exporter: { name: "Scient fixture", version: "1" },
          timeZone: "UTC",
          redact: (text) => text,
        });
        assert.equal(prepared._tag, "ok");
        if (prepared._tag !== "ok") return yield* Effect.die("Citation package rejected");
        assert.equal(
          prepared.value.snapshot.messages.findLast((m) => m.role === "assistant")?.text,
          raw,
        );
        const bytes = yield* Effect.promise(() => zipBytesPromise(prepared.value.files));
        // Public upload/preview/confirm drives the reader and native import transaction.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createNativeProjects;
            const staging = yield* Staging.make({ sweepOnTimer: false });
            const upload = yield* staging.createUpload({
              fileName: "Citations.scic",
              sizeBytes: bytes.length,
            });
            const token = upload.relativeUrl.slice(
              Staging.CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX.length + 1,
            );
            const claims = yield* staging.validateUploadToken(token);
            assert.ok(claims);
            assert.deepEqual(yield* staging.receiveUpload(claims, Stream.make(bytes)), {
              ok: true,
            });
            yield* staging.preview(upload.importId);
            const imported = yield* staging.confirm(
              {
                importId: upload.importId,
                packageSha256: sha256Digest(bytes),
                destination: destination(),
              },
              principal(),
            );
            const projection =
              yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
                imported.threadId,
              );
            assert.equal(assistant(projection).text, raw);
            assert.isNull(assistant(projection).nativeItemRef);
            assert.lengthOf(projection.providerSessions, 0);
            assert.deepEqual(
              assistant(projection).citationPresentation,
              frozen.snapshot.messages.findLast((m) => m.role === "assistant")
                ?.citationPresentation,
            );
            assert.equal(assistant(projectThreadProjectionForWire(projection)).text, display);
            assertClients(clients, projection);
            assert.equal(
              projectThreadProjectionForWire(projection).messages.findLast(
                (m) => m.role === "assistant",
              )?.text,
              display,
            );
          }).pipe(
            Effect.provide(
              ServerSecretStore.layer.pipe(
                Layer.provideMerge(nativeImportTestLayer({ persistence: "file" })),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
