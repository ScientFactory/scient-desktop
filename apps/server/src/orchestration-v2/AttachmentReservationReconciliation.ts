// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import {
  AttachmentFileArbitration,
  ReadyAttachmentReservation,
  reservationDirectory,
} from "./AttachmentFileUse.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EventStoreV2 } from "./EventStore.ts";

export class AttachmentReservationReconciliationError extends Schema.TaggedError<AttachmentReservationReconciliationError>()(
  "AttachmentReservationReconciliationError",
  { cause: Schema.Defect() },
) {}

/** Uncomposed callers retain pins; this service never supplies native reader-release evidence. */
interface ReconciliationOperations {
  readonly reconcile: (
    attachmentIds?: ReadonlyArray<string>,
  ) => Effect.Effect<void, AttachmentReservationReconciliationError>;
}
export class AttachmentReservationReconciliation extends Context.Reference<ReconciliationOperations>(
  "t3/orchestration-v2/AttachmentReservationReconciliation",
  {
    defaultValue: () => ({ reconcile: () => Effect.void }),
  },
) {}

const decodeReservation = Schema.decodeEffect(Schema.fromJsonString(ReadyAttachmentReservation));
export const reconcileReservationsBestEffort = Effect.fn(
  "AttachmentReservations.reconcileBestEffort",
)(function* (ids?: ReadonlyArray<string>, captured?: ReconciliationOperations) {
  const service = captured ?? (yield* AttachmentReservationReconciliation);
  yield* service
    .reconcile(ids)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Attachment reservation reconciliation deferred", { cause }),
      ),
    );
});

export const layer = Layer.effect(
  AttachmentReservationReconciliation,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const arbitration = yield* AttachmentFileArbitration;
    const events = yield* EventStoreV2;
    const receipts = yield* CommandReceiptStoreV2;
    const readDirectory = (path: string) =>
      fs
        .readDirectory(path)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
          ),
        );
    const reconcile = Effect.fn("AttachmentReservations.reconcile")(function* (
      ids?: ReadonlyArray<string>,
    ) {
      if (ids?.length === 0) return;
      yield* Effect.gen(function* () {
        const root = NodePath.join(config.stateDir, "attachment-file-use");
        const directories =
          ids === undefined
            ? (yield* readDirectory(root)).map((name) => NodePath.join(root, name))
            : [...new Set(ids.map((id) => reservationDirectory(config.stateDir, id)))];
        for (const directory of directories) {
          for (const token of yield* readDirectory(directory)) {
            // Anonymous historical pins, incomplete copies and partial metadata writes
            // cannot establish operation disposition, even after a server restart.
            const path = NodePath.join(directory, token);
            const text = yield* arbitration.withPermit(fs.readFileString(path).pipe(Effect.option));
            if (Option.isNone(text)) continue;
            const record = yield* decodeReservation(text.value).pipe(Effect.option);
            if (Option.isNone(record) || token.endsWith(".ready")) continue;
            const { attachment, owner } = record.value;
            if (reservationDirectory(config.stateDir, attachment.id) !== directory) continue;
            let proven = false;
            if (owner.kind === "command") {
              const receipt = yield* receipts.getByCommandId(owner.commandId);
              if (
                Option.isNone(receipt) ||
                receipt.value.threadId !== owner.threadId ||
                receipt.value.commandType !== owner.commandType
              )
                continue;
              if (receipt.value.status === "rejected") proven = true;
              else
                proven = yield* events.commandPublicationProven(
                  owner,
                  receipt.value.resultSequence,
                );
            } else {
              proven = yield* events.attachmentPublicationProven(owner, attachment);
            }
            // This operation's token only. Durable canonical owners, other tokens,
            // actual native readers and selective unlink retain their own guards.
            if (proven)
              yield* arbitration.withPermit(
                fs.readFileString(path).pipe(
                  Effect.flatMap((current) =>
                    current === text.value ? fs.remove(path, { force: true }) : Effect.void,
                  ),
                  Effect.catch((error) =>
                    error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
                  ),
                  Effect.uninterruptible,
                ),
              );
          }
        }
      });
    });
    const service = {
      reconcile: (ids?: ReadonlyArray<string>) =>
        reconcile(ids).pipe(
          Effect.mapError((cause) => new AttachmentReservationReconciliationError({ cause })),
        ),
    };
    // Recover only proven ready operations. Missing/partial projections play no role.
    yield* service
      .reconcile()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Attachment reservation recovery deferred", { cause }),
        ),
      );
    return service;
  }),
);
