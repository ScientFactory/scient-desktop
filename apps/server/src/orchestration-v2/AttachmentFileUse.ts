// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ChatAttachment,
  CommandId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
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

export const reservationDirectory = (stateDir: string, id: string) =>
  NodePath.join(
    stateDir,
    "attachment-file-use",
    NodeCrypto.createHash("sha256").update(id.toLowerCase()).digest("hex"),
  );

export const AttachmentReservationOwner = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message-publication"),
    threadId: ThreadId,
    messageId: MessageId,
  }),
  Schema.Struct({ kind: Schema.Literal("generated-publication"), threadId: ThreadId }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    threadId: ThreadId,
    commandId: CommandId,
    commandType: Schema.Literals([
      "message.dispatch",
      "queued-run.edit",
      "runtime-request.respond",
      "legacy-queue.import",
    ]),
    target: Schema.Union([
      Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }),
      Schema.Struct({ type: Schema.Literal("run"), runId: RunId }),
      Schema.Struct({ type: Schema.Literal("question"), requestId: RuntimeRequestId }),
      Schema.Struct({ type: Schema.Literal("initial-message") }),
    ]),
  }),
]);
export type AttachmentReservationOwner = typeof AttachmentReservationOwner.Type;
export const ReadyAttachmentReservation = Schema.Struct({
  version: Schema.Literal(1),
  attachment: ChatAttachment,
  owner: AttachmentReservationOwner,
});
const encodeReservation = Schema.encodeSync(Schema.fromJsonString(ReadyAttachmentReservation));

/** Publish reconciliation metadata only after this operation's actual reads/copies finish. */
const readyReservation =
  (
    fs: FileSystem.FileSystem,
    arbitration: Semaphore.Semaphore,
    token: string,
    attachment: ChatAttachment,
  ) =>
  (owner: AttachmentReservationOwner) =>
    arbitration.withPermit(
      Effect.gen(function* () {
        const temporary = `${token}.ready`;
        yield* fs.writeFileString(temporary, encodeReservation({ version: 1, attachment, owner }));
        yield* fs.rename(temporary, token);
      }).pipe(Effect.uninterruptible),
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
  if (parseThreadSegmentFromAttachmentId(attachment.id) === null)
    return { release: Effect.void, ready: (_owner: AttachmentReservationOwner) => Effect.void };
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
    ready: readyReservation(fs, arbitration, token, attachment),
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

/** Each Promise publication retains its active token until all physical work finishes. */
export const reserveGeneratedImagePublication = (attachmentsDir: string, attachmentId: string) =>
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
      return {
        published: (attachment: ChatAttachment, threadId: ThreadId) =>
          Effect.runPromise(
            arbitration
              .withPermit(
                Effect.promise(async () => {
                  const token = NodePath.join(directory, path);
                  await NodeFSP.writeFile(
                    `${token}.ready`,
                    encodeReservation({
                      version: 1,
                      attachment,
                      owner: { kind: "generated-publication", threadId },
                    }),
                    { flag: "wx" },
                  );
                  await NodeFSP.rename(`${token}.ready`, token);
                }),
              )
              .pipe(Effect.uninterruptible),
          ),
      };
    }),
  );
