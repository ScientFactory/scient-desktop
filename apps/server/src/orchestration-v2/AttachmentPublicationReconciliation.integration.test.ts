import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import { vi } from "vite-plus/test";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { persistChatAttachments } from "../AttachmentPersistence.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { materializeGeneratedImageAttachment } from "../generatedImageAttachments.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import {
  attachmentHasReservations,
  reservationDirectory,
  reserveAttachment,
} from "./AttachmentFileUse.ts";
import {
  AttachmentReservationReconciliation,
  layer as reconciliationLayer,
} from "./AttachmentReservationReconciliation.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import { makeReplayServerConfig } from "./testkit/ProviderReplayHarness.ts";

// The barrier delegates to Node's actual open/read/close operations. ESM namespace
// exports themselves are immutable, so only this fixture's open seam is replaceable.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const now = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
const threadId = ThreadId.make("publication-owner");
const foreignId = ThreadId.make("foreign-publication-owner");
const instanceId = ProviderInstanceId.make("publication-fixture");
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const thread = (id: ThreadId): OrchestrationV2AppThread => ({
  id,
  projectId: ProjectId.make("publication-project"),
  title: id,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "synthetic" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
});
const message = (
  owner: ThreadId,
  id: string,
  attachments: ReadonlyArray<ChatAttachment>,
  assistant = false,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId: owner,
  runId: null,
  nodeId: null,
  role: assistant ? "assistant" : "user",
  text: "Publication evidence",
  attachments,
  streaming: false,
  createdBy: assistant ? "agent" : "user",
  creationSource: assistant ? "provider" : "web",
  createdAt: now,
  updatedAt: now,
});
type Payloads = { [E in OrchestrationV2DomainEvent as E["type"]]: E["payload"] };
let ordinal = 0;
const event = <K extends keyof Payloads>(type: K, owner: ThreadId, payload: Payloads[K]) =>
  ({
    id: EventId.make(`publication:event:${++ordinal}`),
    threadId: owner,
    occurredAt: now,
    type,
    payload,
  }) as OrchestrationV2DomainEvent;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Effect.acquireRelease(
    makeReplayServerConfig("publication-reconciliation"),
    (config) => fs.remove(path.dirname(config.stateDir), { recursive: true }).pipe(Effect.orDie),
  );
  // Each acquisition closes and reopens the same actual database, not a snapshot.
  const services = () => {
    const stores = Layer.mergeAll(
      EventStore.layer,
      CommandReceiptStore.layer,
      ProjectionStore.layer,
    ).pipe(
      Layer.provideMerge(
        makeSqlitePersistenceLive(path.join(config.stateDir, "publications.sqlite")),
      ),
    );
    const sink = EventSink.layer.pipe(Layer.provide(stores));
    const reconciliation = reconciliationLayer.pipe(Layer.provide(stores));
    return Layer.mergeAll(
      stores,
      sink,
      reconciliation,
      ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
      ProviderEventIngestor.layer.pipe(
        Layer.provide(Layer.mergeAll(stores, sink, reconciliation, IdAllocator.layer)),
      ),
    ).pipe(
      Layer.provideMerge(Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer)),
      Layer.provideMerge(Layer.succeed(ServerConfig, config)),
    );
  };
  const upload = (id: string, data = bytes) =>
    persistChatAttachments({
      threadId,
      messageId: MessageId.make(id),
      attachments: [
        {
          type: "image",
          name: "proof.png",
          mimeType: "image/png",
          sizeBytes: data.length,
          dataUrl: `data:image/png;base64,${data.toString("base64")}`,
        },
      ],
    });
  return { fs, path, config, services, upload };
});

it.live(
  "settles only the direct publication's exact immutable owner while retaining shared bytes and independent pins across reopen",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, config, services, upload } = yield* fixture;
        let attachment: ChatAttachment | undefined;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            const reconciliation = yield* AttachmentReservationReconciliation;
            yield* sink.write({
              events: [
                event("thread.created", threadId, thread(threadId)),
                event("thread.created", foreignId, thread(foreignId)),
              ],
            });
            [attachment] = yield* upload("direct");
            const independent = yield* reserveAttachment(attachment!);
            yield* sink.write({
              events: [
                event("message.updated", foreignId, message(foreignId, "direct", [attachment!])),
              ],
            });
            yield* reconciliation.reconcile([attachment!.id]);
            expect(
              yield* fs.readDirectory(reservationDirectory(config.stateDir, attachment!.id)),
            ).toHaveLength(2);
            for (const invalid of [
              message(threadId, "wrong-message", [attachment!]),
              message(threadId, "direct", [
                { ...attachment!, sizeBytes: attachment!.sizeBytes + 1 },
              ]),
              message(threadId, "direct", [attachment!], true),
            ]) {
              yield* sink.write({ events: [event("message.updated", threadId, invalid)] });
              yield* reconciliation.reconcile([attachment!.id]);
              expect(
                yield* fs.readDirectory(reservationDirectory(config.stateDir, attachment!.id)),
              ).toHaveLength(2);
            }
            yield* sink.write({
              events: [
                event("message.updated", threadId, message(threadId, "direct", [attachment!])),
              ],
            });
            yield* reconciliation.reconcile([attachment!.id]);
            expect(
              yield* fs.readDirectory(reservationDirectory(config.stateDir, attachment!.id)),
            ).toHaveLength(1);
            yield* independent.release;
            expect(yield* attachmentHasReservations(attachment!.id)).toBe(false);
            // A replay becomes ready, then the process loses its reply before reconciliation.
            expect(yield* upload("direct")).toEqual([attachment]);
            yield* sink.write({
              events: [event("message.updated", threadId, message(threadId, "direct", []))],
            });
            expect(yield* attachmentHasReservations(attachment!.id)).toBe(true);
          }).pipe(Effect.provide(services())),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* AttachmentReservationReconciliation;
            const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
            yield* maintenance.rebuild;
            expect(yield* attachmentHasReservations(attachment!.id)).toBe(false);
            const projection = yield* ProjectionStore.ProjectionStoreV2;
            const retained = yield* projection.getRollbackAttachmentOwners({
              threadId,
              revertedRunIds: [],
              attachmentIds: [attachment!.id],
            });
            expect(retained).toContain(attachment!.id);
            expect(
              Buffer.from(
                yield* fs.readFile(
                  resolveAttachmentPath({
                    attachmentsDir: config.attachmentsDir,
                    attachment: attachment!,
                  })!,
                ),
              ),
            ).toEqual(bytes);
          }).pipe(Effect.provide(services())),
        );
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer))),
    ),
);

it.live(
  "reconciles generated provider publication only after commit and retains an actual recovery reader until its handle closes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, config, services } = yield* fixture;
        const sourcePath = path.join(config.stateDir, "generated.png");
        yield* fs.writeFile(sourcePath, bytes);
        const input = {
          threadId,
          sourcePath,
          provenanceKey: "native-thread\0call-1",
          allowedSourceRoots: [config.stateDir],
          attachmentsDir: config.attachmentsDir,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            const reconciliation = yield* AttachmentReservationReconciliation;
            const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
            yield* sink.write({ events: [event("thread.created", threadId, thread(threadId))] });
            const attachment = yield* Effect.promise(() =>
              materializeGeneratedImageAttachment(input),
            );
            const filename = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            })!;
            expect(yield* attachmentHasReservations(attachment.id)).toBe(true);
            const stored = yield* ingestor.ingestNormalized({
              providerSessionId: ProviderSessionId.make("publication-session"),
              providerInstanceId: instanceId,
              threadId,
              event: {
                type: "message.updated",
                driver: ProviderDriverKind.make("codex"),
                message: message(threadId, "generated", [attachment], true),
              },
            });
            expect(stored.some(({ event }) => event.type === "message.updated")).toBe(true);
            expect(yield* attachmentHasReservations(attachment.id)).toBe(false);
            yield* fs.remove(sourcePath);
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const originalOpen = (yield* Effect.promise(() =>
              vi.importActual<typeof NodeFSP>("node:fs/promises"),
            )).open;
            let gated = false;
            const spy = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
              const handle = await originalOpen(...args);
              if (!gated && args[0] === filename) {
                gated = true;
                const close = handle.close.bind(handle);
                vi.spyOn(handle, "close").mockImplementation(async () => {
                  entered.resolve();
                  await release.promise;
                  await close();
                });
              }
              return handle;
            });
            yield* Effect.gen(function* () {
              const recovery = yield* Effect.promise(() =>
                materializeGeneratedImageAttachment({
                  ...input,
                  allowDurableFallbackWhenSourceUnavailable: true,
                }),
              ).pipe(Effect.forkChild);
              yield* Effect.promise(() => entered.promise);
              yield* reconciliation.reconcile([attachment.id]);
              expect(yield* attachmentHasReservations(attachment.id)).toBe(true);
              expect(Buffer.from(yield* fs.readFile(filename))).toEqual(bytes);
              release.resolve();
              expect(yield* Fiber.join(recovery)).toEqual(attachment);
              yield* reconciliation.reconcile([attachment.id]);
              expect(yield* attachmentHasReservations(attachment.id)).toBe(false);
              expect(Buffer.from(yield* fs.readFile(filename))).toEqual(bytes);
            }).pipe(
              Effect.ensuring(Effect.sync(() => release.resolve())),
              Effect.ensuring(Effect.sync(() => spy.mockRestore())),
            );
          }).pipe(Effect.provide(services())),
        );
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer))),
    ),
);

it.live(
  "retains ambiguous failed publication and anonymous historical pins after reopen despite a prior canonical owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, config, services, upload } = yield* fixture;
        let attachment: ChatAttachment | undefined;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({ events: [event("thread.created", threadId, thread(threadId))] });
            [attachment] = yield* upload("conflict");
            yield* sink.write({
              events: [
                event("message.updated", threadId, message(threadId, "conflict", [attachment!])),
              ],
            });
            const reconciliation = yield* AttachmentReservationReconciliation;
            yield* reconciliation.reconcile([attachment!.id]);
            const conflict = yield* upload("conflict", Buffer.from("different-byte-payload")).pipe(
              Effect.result,
            );
            expect(conflict._tag).toBe("Failure");
            yield* reserveAttachment(attachment!);
            expect(
              yield* fs.readDirectory(reservationDirectory(config.stateDir, attachment!.id)),
            ).toHaveLength(2);
          }).pipe(Effect.provide(services())),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reconciliation = yield* AttachmentReservationReconciliation;
            yield* reconciliation.reconcile([attachment!.id]);
            expect(
              yield* fs.readDirectory(reservationDirectory(config.stateDir, attachment!.id)),
            ).toHaveLength(2);
            expect(
              Buffer.from(
                yield* fs.readFile(
                  resolveAttachmentPath({
                    attachmentsDir: config.attachmentsDir,
                    attachment: attachment!,
                  })!,
                ),
              ),
            ).toEqual(bytes);
          }).pipe(Effect.provide(services())),
        );
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer))),
    ),
);
