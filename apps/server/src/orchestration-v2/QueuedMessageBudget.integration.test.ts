import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  WsRpcGroup,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as CodexReplay from "effect-codex-app-server/replay";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { readQueue, writeQueue } from "./legacy/LegacyQueueLedger.ts";
import {
  CodexOrchestratorReplayHarness,
  layer as makeCodexProviderAdapterRegistryReplayLayer,
} from "./Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { dispatchCommandRpcError } from "./DispatchCommandRpcError.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { cutOverLegacyQueue } from "./legacy/LegacyQueueCutover.ts";
import { makeLegacyQueueCompatibility } from "./legacy/LegacyQueueCompatibility.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import { THREAD_FORK_NATIVE_SOURCE_PROMPT } from "./testkit/fixtures/shared.ts";

const dispatchRpc = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
if (!dispatchRpc) throw new Error("Missing registered dispatch RPC");
const encodeDispatchRpcError = Schema.encodeEffect(dispatchRpc.errorSchema);
const decodeDispatchRpcError = Schema.decodeEffect(dispatchRpc.errorSchema);

const MiB = 1024 * 1024;
const threadId = ThreadId.make("native-queue-bounds");
const projectId = ProjectId.make("native-queue-bounds-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const encodeComposerSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const withBusyNative = <A, E, R>(name: string, body: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const recorded = yield* readProviderReplayTranscript(
        new URL("./testkit/fixtures/thread_fork_native/codex_transcript.ndjson", import.meta.url),
      );
      const full = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(recorded, cwd),
      );
      // Stop only the external native completion stream. The actual adapter,
      // worker, SQL stores, command executor, intake and importer remain active.
      const end = full.entries.findIndex(
        (entry) => entry.type === "emit_inbound" && entry.label === "turn/started/source",
      );
      assert.ok(end > 0);
      const transcript = { ...full, entries: full.entries.slice(0, end + 1) };
      const driver = yield* CodexReplay.makeReplayDriver(transcript);
      const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
        { name, runtimePolicyOverride: { cwd } },
        makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
        { configureMcp: false },
      );
      const clones = ProjectCloneTracker.layer.pipe(
        Layer.provide(Layer.mock(SourceControlRepositoryService)({})),
      );
      const services = Layer.mergeAll(
        runtime,
        clones,
        SqlitePersistenceMemory,
        CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
      );
      const layer = ThreadManagement.layerWithLegacyImporter.pipe(Layer.provideMerge(services));
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const now = yield* DateTime.now;
        yield* sink.commitProjectCommand({
          commandId: CommandId.make("native-queue-project-create"),
          projectId,
          commandType: "project.create",
          acceptedAt: now,
          event: {
            eventId: EventId.make("native-queue-project-created"),
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
              title: "Queue bounds",
              workspaceRoot: cwd,
              scripts: [],
              defaultModelSelection: modelSelection,
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("native-queue-create"),
          threadId,
          projectId,
          title: "Queue bounds",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* ThreadMessageIntake.dispatchCommand(
          message("active", [], THREAD_FORK_NATIVE_SOURCE_PROMPT),
        );
        const cursor = yield* orchestrator.getThreadEventSequence(threadId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
        );
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const running = yield* Stream.concat(
          Stream.succeed(initial),
          Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
          ),
        ).pipe(
          Stream.filter((projection) =>
            projection.providerTurns.some(
              (turn) => turn.nativeTurnRef?.nativeId === "native-source-turn",
            ),
          ),
          Stream.runHead,
          Effect.timeout("15 seconds"),
        );
        assert.ok(Option.isSome(running));
        assert.equal(running.value.runs[0]?.status, "running");
        const result = yield* body;
        assert.isNull(
          (yield* Ref.get(driver.state)).failure,
          "Queued work must not reach the native provider while its turn remains active",
        );
        return result;
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

function message(
  key: string,
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = `Queued ${key}`,
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> {
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`native-queue:${key}`),
    threadId,
    messageId: MessageId.make(`native-queue-message:${key}`),
    text,
    attachments,
    modelSelection,
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
  };
}

const stage = Effect.fn("NativeQueue.stage")(function* (sizeBytes: number) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const pendingId = createPendingAttachmentId();
  assert.ok(pendingId);
  const attachment: ChatAttachment = {
    type: "file",
    id: ChatAttachmentId.make(pendingId),
    name: "evidence.bin",
    mimeType: "application/octet-stream",
    sizeBytes,
  };
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  assert.ok(path);
  yield* fs.writeFile(path, new Uint8Array(sizeBytes).fill(73));
  return { attachment, pendingPath: path };
});

const attachmentPath = Effect.fn("NativeQueue.attachmentPath")(function* (
  attachment: ChatAttachment,
) {
  const config = yield* ServerConfig;
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  assert.ok(path);
  return path;
});
const files = Effect.fn("NativeQueue.files")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  return (yield* fs.readDirectory(config.attachmentsDir)).toSorted();
});

const queued = Effect.fn("NativeQueue.queued")(function* () {
  const orchestrator = yield* OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const ids = new Set(
    projection.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
  );
  return { projection, messages: projection.messages.filter((candidate) => ids.has(candidate.id)) };
});

it.live(
  "concurrent native admission accepts exactly the twentieth queued message and releases the rejected claim",
  () =>
    withBusyNative(
      "queue-count-concurrent",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (let index = 0; index < 19; index++)
          yield* ThreadMessageIntake.dispatchCommand(message(`prior-${index}`));
        const candidates = yield* Effect.forEach(["twenty", "twenty-one"], (key) =>
          stage(1).pipe(Effect.map((upload) => ({ key, upload }))),
        );
        const beforeFiles = yield* files();
        const results = yield* Effect.forEach(
          candidates,
          ({ key, upload }) =>
            Effect.result(ThreadMessageIntake.dispatchCommand(message(key, [upload.attachment]))),
          { concurrency: 2 },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
        assert.lengthOf((yield* queued()).messages, 20);
        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index]!;
          assert.equal(yield* fs.exists(candidate.upload.pendingPath), true);
          if (results[index]?._tag === "Success") {
            yield* ThreadMessageIntake.dispatchCommand(
              message(candidate.key, [candidate.upload.attachment]),
            );
            assert.lengthOf(
              (yield* queued()).messages,
              20,
              "Replaying the accepted receipt must not consume another queue slot",
            );
            const accepted = (yield* queued()).messages.find(
              (item) => item.id === message(candidate.key).messageId,
            )?.attachments[0];
            assert.ok(accepted);
            assert.deepEqual(Array.from(yield* fs.readFile(yield* attachmentPath(accepted))), [73]);
          }
        }
        assert.equal(
          (yield* files()).length,
          beforeFiles.length + 1,
          "Only the accepted receipt's attachment copy survives both admission and replay",
        );
      }),
    ),
);

it.live(
  "ordinary and imported held runs share the same twenty-message limit without losing rejected migration staging",
  () =>
    withBusyNative(
      "queue-count-mixed",
      Effect.gen(function* () {
        for (let index = 0; index < 19; index++)
          yield* ThreadMessageIntake.dispatchCommand(message(`native-${index}`));
        const now = "2026-10-04T00:00:00.000Z";
        yield* writeQueue(threadId, {
          ...(yield* readQueue(threadId)),
          migrated: true,
          items: [
            {
              queueItemId: "qitem_first",
              threadId,
              text: "Held first",
              attachments: [],
              modelSelection,
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
        assert.equal(yield* cutOverLegacyQueue(threadId), 1);
        const before = yield* queued();
        assert.lengthOf(before.messages, 20);
        assert.equal(
          before.projection.runs.find((run) => run.legacyQueue?.queueItemId === "qitem_first")
            ?.queueHeld,
          true,
        );
        yield* writeQueue(threadId, {
          ...(yield* readQueue(threadId)),
          migrated: true,
          items: [
            {
              queueItemId: "qitem_second",
              threadId,
              text: "Retain rejected source",
              attachments: [],
              modelSelection,
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
        assert.equal((yield* Effect.result(cutOverLegacyQueue(threadId)))._tag, "Failure");
        assert.deepEqual(
          (yield* readQueue(threadId)).items.map((item) => item.queueItemId),
          ["qitem_second"],
        );
        assert.equal(
          (yield* Effect.result(ThreadMessageIntake.dispatchCommand(message("native-overflow"))))
            ._tag,
          "Failure",
        );
        assert.lengthOf((yield* queued()).messages, 20);
      }),
    ),
);

it.live(
  "aggregate queued attachment bytes use the actual stored files, including changed files and shared references",
  () =>
    withBusyNative(
      "queue-bytes-native",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = yield* stage(32 * MiB);
        yield* ThreadMessageIntake.dispatchCommand(message("large-first", [first.attachment]));
        const ownedFirst = (yield* queued()).messages.find(
          (item) => item.id === message("large-first").messageId,
        )?.attachments[0];
        assert.ok(ownedFirst);
        const firstPath = yield* attachmentPath(ownedFirst);
        assert.equal(Number((yield* fs.stat(firstPath)).size), 32 * MiB);
        // An already delivered file can grow after admission. Its persisted metadata
        // is no longer a byte count; the next atomic admission must inspect the file.
        yield* fs.truncate(firstPath, 33 * MiB);
        const second = yield* stage(31 * MiB);
        const beforeRejected = yield* files();
        assert.equal(
          (yield* Effect.result(
            ThreadMessageIntake.dispatchCommand(message("large-second", [second.attachment])),
          ))._tag,
          "Failure",
        );
        assert.deepEqual(yield* files(), beforeRejected);
        assert.equal(yield* fs.exists(second.pendingPath), true);
        yield* fs.truncate(firstPath, 32 * MiB);
        yield* ThreadMessageIntake.dispatchCommand(message("below-limit", [second.attachment]));
        const ownedSecond = (yield* queued()).messages.find(
          (item) => item.id === message("below-limit").messageId,
        )?.attachments[0];
        assert.ok(ownedSecond);
        assert.equal(Number((yield* fs.stat(yield* attachmentPath(ownedSecond))).size), 31 * MiB);
        const retained = (yield* queued()).messages.find(
          (candidate) => candidate.id === message("large-first").messageId,
        )?.attachments[0];
        assert.ok(retained);
        assert.equal(
          (yield* Effect.result(
            ThreadMessageIntake.dispatchCommand(message("shared-overflow", [retained])),
          ))._tag,
          "Failure",
          "Each queued message spends its attachment bytes, including shared references, as protected MAIN does",
        );
        assert.lengthOf((yield* queued()).messages, 2);
      }),
    ),
);

it.live(
  "queued edits reject excess replacement bytes atomically and clear only an accepted stale composer snapshot",
  () =>
    withBusyNative(
      "queue-edit-budget-snapshot",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const orchestrator = yield* OrchestratorV2;
        const now = "2026-10-04T00:00:00.000Z";
        const small = yield* stage(1 * MiB);
        const snapshot = yield* encodeComposerSnapshot({
          version: 2,
          prompt: "$analysis original",
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
        });
        yield* writeQueue(threadId, {
          ...(yield* readQueue(threadId)),
          migrated: true,
          items: [
            {
              queueItemId: "qitem_edit",
              threadId,
              text: "$analysis original",
              attachments: [small.attachment],
              composerSnapshot: snapshot,
              selectedScientSkillNames: ["analysis"],
              context: { version: 1 as const, records: [] },
              modelSelection,
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
        assert.equal(yield* cutOverLegacyQueue(threadId), 1);
        const heavy = yield* stage(40 * MiB);
        yield* ThreadMessageIntake.dispatchCommand({
          ...message("heavy-neighbor", [heavy.attachment], "$analysis neighboring work"),
          context: { version: 1 as const, records: [] },
          selectedScientSkillNames: ["analysis"],
        });
        const before = yield* queued();
        const run = before.projection.runs.find(
          (candidate) => candidate.legacyQueue?.queueItemId === "qitem_edit",
        );
        const original = before.messages.find((candidate) => candidate.id === run?.userMessageId);
        assert.ok(run && original);
        assert.equal(original.composerSnapshot, snapshot);
        const excessive = yield* stage(24 * MiB);
        const beforeRejected = yield* files();
        const rejected = yield* Effect.result(
          ThreadMessageIntake.dispatchCommand({
            type: "queued-run.edit",
            commandId: CommandId.make("edit-excessive"),
            threadId,
            runId: run.id,
            text: "Rejected replacement",
            attachments: [excessive.attachment],
            context: null,
            selectedScientSkillNames: [],
          }),
        );
        assert.equal(rejected._tag, "Failure");
        assert.deepEqual(
          (yield* queued()).messages.find((candidate) => candidate.id === original.id),
          original,
        );
        assert.deepEqual(yield* files(), beforeRejected);
        assert.equal(yield* fs.exists(excessive.pendingPath), true);
        assert.ok(original.attachments[0]);
        assert.equal(
          Number((yield* fs.stat(yield* attachmentPath(original.attachments[0]))).size),
          MiB,
        );
        yield* ThreadMessageIntake.dispatchCommand({
          type: "queued-run.edit",
          commandId: CommandId.make("edit-text-only"),
          threadId,
          runId: run.id,
          text: "$analysis edited",
        });
        const edited = (yield* queued()).messages.find((candidate) => candidate.id === original.id);
        assert.ok(edited);
        assert.isUndefined(edited.composerSnapshot);
        assert.deepEqual(edited.context, original.context);
        assert.deepEqual(edited.selectedScientSkillNames, ["analysis"]);
        assert.deepEqual(edited.attachments, original.attachments);
        const accepted = yield* stage(2 * MiB);
        yield* ThreadMessageIntake.dispatchCommand({
          type: "queued-run.edit",
          commandId: CommandId.make("edit-clear"),
          threadId,
          runId: run.id,
          text: "Cleared selections",
          attachments: [accepted.attachment],
          context: null,
          selectedScientSkillNames: [],
        });
        const neighbor = (yield* queued()).projection.runs.find(
          (candidate) => candidate.userMessageId === message("heavy-neighbor").messageId,
        );
        assert.ok(neighbor);
        yield* ThreadMessageIntake.dispatchCommand({
          type: "queued-run.edit",
          commandId: CommandId.make("edit-native-clear"),
          threadId,
          runId: neighbor.id,
          text: "Neighbor cleared",
          context: null,
          selectedScientSkillNames: [],
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        const neighborMessage = after.messages.find(
          (candidate) => candidate.id === neighbor.userMessageId,
        );
        const neighborItem = after.turnItems.find(
          (candidate) =>
            candidate.type === "user_message" && candidate.messageId === neighbor.userMessageId,
        );
        assert.ok(neighborMessage);
        assert.isUndefined(
          neighborItem,
          "Queued native messages stay outside the conversation timeline",
        );
        assert.isUndefined(neighborMessage.context);
        assert.deepEqual(neighborMessage.selectedScientSkillNames, []);
        assert.equal(neighborMessage.text, "Neighbor cleared");
        const cleared = after.messages.find((candidate) => candidate.id === original.id);
        assert.ok(cleared);
        assert.isUndefined(cleared.context);
        assert.isUndefined(cleared.composerSnapshot);
        assert.deepEqual(cleared.selectedScientSkillNames, []);
        assert.ok(cleared.attachments[0]);
        assert.equal(
          Number((yield* fs.stat(yield* attachmentPath(cleared.attachments[0]))).size),
          2 * MiB,
        );
        const compatibility = yield* makeLegacyQueueCompatibility;
        const listed = yield* compatibility.execute({ method: "list", payload: { threadId } });
        assert.isUndefined(
          listed.items.find((item) => item.queueItemId === "qitem_edit")?.composerSnapshot,
        );
        assert.equal(after.runs.find((candidate) => candidate.id === run.id)?.queueHeld, true);
        const stored = yield* EventSinkV2;
        const originalEvents = yield* stored
          .readByCommandId({ commandId: CommandId.make(`legacy-queue:${threadId}:qitem_edit`) })
          .pipe(Stream.runCollect);
        const acceptedEvent = Array.from(originalEvents).find(
          ({ event }) => event.type === "message.updated",
        )?.event;
        assert.ok(acceptedEvent?.type === "message.updated");
        assert.equal(
          acceptedEvent.payload.composerSnapshot,
          snapshot,
          "Edits never rewrite the original accepted event",
        );
        assert.deepEqual(acceptedEvent.payload.attachments, original.attachments);
      }),
    ),
);

it.live(
  "an accepted held queued edit removes the obsolete composer snapshot from the actual compatibility list",
  () =>
    withBusyNative(
      "queue-edit-snapshot",
      Effect.gen(function* () {
        const now = "2026-10-04T00:00:00.000Z";
        const snapshot = yield* encodeComposerSnapshot({
          version: 2,
          prompt: "$analysis original",
          terminalContexts: [],
          previewAnnotations: [],
          reviewComments: [],
        });
        yield* writeQueue(threadId, {
          ...(yield* readQueue(threadId)),
          migrated: true,
          items: [
            {
              queueItemId: "qitem_snapshot",
              threadId,
              text: "$analysis original",
              attachments: [],
              composerSnapshot: snapshot,
              selectedScientSkillNames: ["analysis"],
              context: { version: 1 as const, records: [] },
              modelSelection,
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
        assert.equal(yield* cutOverLegacyQueue(threadId), 1);
        const before = yield* queued();
        const run = before.projection.runs.find(
          (candidate) => candidate.legacyQueue?.queueItemId === "qitem_snapshot",
        );
        assert.ok(run);
        const original = before.messages.find((candidate) => candidate.id === run.userMessageId);
        assert.equal(original?.composerSnapshot, snapshot);
        yield* ThreadMessageIntake.dispatchCommand({
          type: "queued-run.edit",
          commandId: CommandId.make("snapshot-edit"),
          threadId,
          runId: run.id,
          text: "Edited prompt",
          context: null,
          selectedScientSkillNames: [],
        });
        const edited = (yield* queued()).messages.find(
          (candidate) => candidate.id === run.userMessageId,
        );
        assert.isUndefined(edited?.composerSnapshot);
        assert.isUndefined(edited?.context);
        assert.deepEqual(edited?.selectedScientSkillNames, []);
        const compatibility = yield* makeLegacyQueueCompatibility;
        const listed = yield* compatibility.execute({ method: "list", payload: { threadId } });
        assert.equal(
          listed.items.find((item) => item.queueItemId === "qitem_snapshot")?.text,
          "Edited prompt",
        );
        assert.isUndefined(
          listed.items.find((item) => item.queueItemId === "qitem_snapshot")?.composerSnapshot,
        );
      }),
    ),
);

it.live(
  "native queue admission cannot measure or borrow another thread's already claimed attachment",
  () =>
    withBusyNative(
      "queue-foreign-attachment",
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const id = createAttachmentId("different-thread", "bin");
        assert.ok(id);
        const foreign: ChatAttachment = {
          type: "file",
          id: ChatAttachmentId.make(id),
          name: "evidence.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        };
        const path = yield* attachmentPath(foreign);
        yield* fs.writeFile(path, new Uint8Array([73]));
        const before = yield* queued();
        assert.equal(
          (yield* Effect.result(ThreadMessageIntake.dispatchCommand(message("foreign", [foreign]))))
            ._tag,
          "Failure",
        );
        assert.deepEqual((yield* queued()).messages, before.messages);
        assert.deepEqual(
          Array.from(yield* fs.readFile(path)),
          [73],
          "Rejected foreign references never delete the original owner's bytes",
        );
      }),
    ),
);

it.live(
  "native extraction records a durable refusal after the captured message has reached the provider",
  () =>
    withBusyNative(
      "queue-delivered-extraction",
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const before = yield* orchestrator.getThreadProjection(threadId);
        const active = before.runs.find((run) => run.status === "running");
        assert.ok(active);
        const captured = before.messages.find((message) => message.id === active.userMessageId);
        assert.ok(captured);
        const command = {
          type: "queued-run.cancel" as const,
          commandId: CommandId.make("native-queue:delivered-extraction"),
          threadId,
          runId: active.id,
          expectedUpdatedAt: captured.updatedAt,
        };
        const first = yield* orchestrator.dispatch(command).pipe(Effect.flip);
        const replay = yield* orchestrator.dispatch(command).pipe(Effect.flip);
        assert.equal(first._tag, "OrchestratorCommandRejectedError");
        assert.equal(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
        for (const cause of [first, replay]) {
          const transport = dispatchCommandRpcError(command, cause);
          const encoded = yield* encodeDispatchRpcError(transport);
          const decoded = yield* decodeDispatchRpcError(encoded);
          assert.equal(decoded._tag, "OrchestrationV2DispatchCommandError");
          if (decoded._tag === "OrchestrationV2DispatchCommandError")
            assert.equal(decoded.commandDisposition, "rejected");
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(after.runs, before.runs);
        assert.deepEqual(after.providerThreads, before.providerThreads);
        assert.deepEqual(after.providerTurns, before.providerTurns);
      }),
    ),
);
