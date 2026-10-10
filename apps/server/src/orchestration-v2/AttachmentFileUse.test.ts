import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ChatAttachmentId, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  AttachmentFileArbitration,
  attachmentHasReservations,
  reserveAttachment,
} from "./AttachmentFileUse.ts";
import { claimPendingAttachments } from "./AttachmentClaims.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "attachment-file-use-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const stored = Effect.fn("test.storedAttachment")(function* (threadId: string, pending = false) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const attachment: ChatAttachment = {
    type: "file",
    id: ChatAttachmentId.make(
      pending ? createPendingAttachmentId("txt") : createAttachmentId(threadId, "txt")!,
    ),
    name: "proof.txt",
    mimeType: "text/plain",
    sizeBytes: 8,
  };
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
  yield* fs.writeFileString(path, "evidence");
  return { attachment, path };
});

it.effect("pins claimed private bytes and pass-through reuse until receipt reconciliation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const pending = yield* stored("pending", true);
    const claimed = yield* claimPendingAttachments({
      threadId: "owner",
      attachments: [pending.attachment],
    });
    const attachment = claimed.attachments[0]!;
    expect(yield* attachmentHasReservations(attachment.id)).toBe(true);
    const claimedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    })!;
    yield* fs.writeFileString(claimedPath, "modified delivered bytes");
    expect(yield* fs.readFileString(pending.path)).toBe("evidence");
    expect((yield* fs.stat(claimedPath)).type).toBe("File");
    const reused = yield* claimPendingAttachments({ threadId: "owner", attachments: [attachment] });
    yield* claimed.releasePins;
    expect(yield* attachmentHasReservations(attachment.id)).toBe(true);
    yield* reused.releasePins;
    expect(yield* attachmentHasReservations(attachment.id)).toBe(false);
    yield* fs.remove(claimedPath);
    const refused = yield* Effect.exit(
      claimPendingAttachments({ threadId: "owner", attachments: [attachment] }),
    );
    expect(refused._tag).toBe("Failure");
    expect(yield* attachmentHasReservations(attachment.id)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps an ambiguous durable pin across a fresh process-local arbitration context", () =>
  Effect.gen(function* () {
    const { attachment } = yield* stored("owner");
    const pin = yield* reserveAttachment(attachment);
    expect(
      yield* attachmentHasReservations(attachment.id).pipe(
        Effect.provideService(AttachmentFileArbitration, Semaphore.makeUnsafe(1)),
      ),
    ).toBe(true);
    yield* pin.release;
    yield* pin.release;
    expect(yield* attachmentHasReservations(attachment.id)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("shares arbitration reservations for case aliases of a managed file ID", () =>
  Effect.gen(function* () {
    const { attachment } = yield* stored("alias-owner");
    const pin = yield* reserveAttachment(
      { ...attachment, id: ChatAttachmentId.make(attachment.id.toUpperCase()) },
      { publication: true },
    );
    expect(yield* attachmentHasReservations(attachment.id)).toBe(true);
    yield* pin.release;
    expect(yield* attachmentHasReservations(attachment.id)).toBe(false);
  }).pipe(Effect.provide(layer)),
);
