import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { AttachmentFileArbitration, attachmentHasReservations } from "../AttachmentFileUse.ts";
import { AttachmentReservationReconciliation } from "../AttachmentReservationReconciliation.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";

export class ForkFileReleaseDeferred extends Schema.TaggedError<ForkFileReleaseDeferred>()(
  "ForkFileReleaseDeferred",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Releases the files a committed deletion in a fork lineage left unnamed
 * (`ProjectionStoreV2.getReleasableForkFiles`). Like rollback pruning, it
 * decides and unlinks under attachment arbitration, and defers a file an
 * admission still holds a reservation on; a deferred release is retried.
 */
export class ForkFileRelease extends Context.Reference<{
  readonly release: (threadId: ThreadId) => Effect.Effect<void, ForkFileReleaseDeferred>;
}>("t3/orchestration-v2/scient-fork/ForkFileRelease", {
  defaultValue: () => ({
    release: () =>
      Effect.fail(new ForkFileReleaseDeferred({ reason: "Fork file release is not composed." })),
  }),
}) {}

export const layer = Layer.effect(
  ForkFileRelease,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const arbitration = yield* AttachmentFileArbitration;
    const reconciliation = yield* AttachmentReservationReconciliation;
    const release = Effect.fn("ForkFileRelease.release")(function* (threadId: ThreadId) {
      const candidates = yield* projections.getReleasableForkFiles(threadId);
      if (candidates.length === 0) return;
      yield* reconciliation.reconcile(candidates);
      yield* arbitration.withPermit(
        Effect.gen(function* () {
          // Decide again under arbitration: an admission may have named a file since.
          const releasable = yield* projections.getReleasableForkFiles(threadId);
          let reserved = false;
          for (const id of releasable) {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: id,
            });
            if (path === null || !(yield* fs.exists(path))) continue;
            if (
              yield* attachmentHasReservations(id).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(ServerConfig, config),
              )
            ) {
              reserved = true;
              continue;
            }
            yield* fs.remove(path, { force: true });
          }
          if (reserved)
            return yield* new ForkFileReleaseDeferred({
              reason: "A file is reserved by an admission in progress.",
            });
        }).pipe(Effect.uninterruptible),
      );
    });
    return {
      release: (threadId) =>
        release(threadId).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ForkFileReleaseDeferred"
              ? cause
              : new ForkFileReleaseDeferred({ reason: "File release failed.", cause }),
          ),
        ),
    };
  }),
);
