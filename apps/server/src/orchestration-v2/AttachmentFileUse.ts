// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { parseThreadSegmentFromAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { randomUuidV4 } from "./RandomUuid.ts";

/** Short arbitration only: never hold it across thread dispatch or native work. */
export class AttachmentFileArbitration extends Context.Reference<Semaphore.Semaphore>(
  "t3/orchestration-v2/AttachmentFileArbitration",
  { defaultValue: () => Semaphore.makeUnsafe(1) },
) {}

export class AttachmentFileUseError extends Schema.TaggedError<AttachmentFileUseError>()(
  "AttachmentFileUseError",
  { attachmentId: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const reservationDirectory = (stateDir: string, id: string) =>
  NodePath.join(
    stateDir,
    "attachment-file-use",
    NodeCrypto.createHash("sha256").update(id.toLowerCase()).digest("hex"),
  );

/**
 * Reservations survive process loss. Only the operation's proven receipt or
 * finished physical copy releases its token; startup never guesses abandonment.
 * This is arbitration within one server process, not a cross-process lease.
 */
export const reserveAttachment = Effect.fn("AttachmentFileUse.reserve")(function* (
  attachment: ChatAttachment,
  options?: { readonly publication?: boolean },
) {
  // Historical opaque IDs cannot be selective-prune candidates. Preserve their
  // pass-through compatibility without inventing a managed ownership identity.
  if (parseThreadSegmentFromAttachmentId(attachment.id) === null) return { release: Effect.void };
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const arbitration = yield* AttachmentFileArbitration;
  const directory = reservationDirectory(config.stateDir, attachment.id);
  const token = NodePath.join(directory, yield* randomUuidV4);
  yield* arbitration
    .withPermit(
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(token, options?.publication ? "publication" : "receipt-or-copy");
        if (!options?.publication) {
          const filename = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (filename === null)
            return yield* new AttachmentFileUseError({ attachmentId: attachment.id });
          const info = yield* fs.stat(filename);
          if (info.type !== "File")
            return yield* new AttachmentFileUseError({ attachmentId: attachment.id });
        }
      }).pipe(
        Effect.onError(() => fs.remove(token, { force: true }).pipe(Effect.ignore)),
        Effect.uninterruptible,
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) => new AttachmentFileUseError({ attachmentId: attachment.id, cause }),
      ),
    );
  return {
    release: arbitration
      .withPermit(fs.remove(token, { force: true }))
      .pipe(Effect.orDie, Effect.uninterruptible),
  };
});

/** Called while holding arbitration, through the final reference recheck/unlink. */
export const attachmentHasReservations = Effect.fn("AttachmentFileUse.hasReservations")(function* (
  attachmentId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  return yield* fs.readDirectory(reservationDirectory(config.stateDir, attachmentId)).pipe(
    Effect.map((entries) => entries.length > 0),
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
});

/** Promise publishers have no durable receipt owner; retain their reservation. */
export const reserveUnreconciledPublication = (attachmentsDir: string, attachmentId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const arbitration = yield* AttachmentFileArbitration;
      const path = yield* randomUuidV4;
      const directory = NodePath.join(
        NodePath.dirname(attachmentsDir),
        "attachment-file-use",
        NodeCrypto.createHash("sha256").update(attachmentId.toLowerCase()).digest("hex"),
      );
      yield* arbitration
        .withPermit(
          Effect.promise(async () => {
            await NodeFSP.mkdir(directory, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(directory, path), "publication", { flag: "wx" });
          }),
        )
        .pipe(Effect.uninterruptible);
    }),
  );
