/** Scient-owned durable file ownership transfer for retained fork attachments. */
import { ThreadForkAttachmentCopy, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";

export class ScientForkAttachmentCopyError extends Schema.TaggedErrorClass<ScientForkAttachmentCopyError>()(
  "ScientForkAttachmentCopyError",
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      "unsafe-mapping",
      "source-unavailable",
      "target-write-failed",
      "verification-failed",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScientForkAttachmentCopierShape {
  readonly copyAll: (input: {
    readonly threadId: ThreadId;
    readonly copies: ReadonlyArray<ThreadForkAttachmentCopy>;
  }) => Effect.Effect<void, ScientForkAttachmentCopyError>;
}

export class ScientForkAttachmentCopier extends Context.Service<
  ScientForkAttachmentCopier,
  ScientForkAttachmentCopierShape
>()("t3/orchestration/scient-fork/ForkAttachmentCopier/ScientForkAttachmentCopier") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;

  const copyAll: ScientForkAttachmentCopierShape["copyAll"] = Effect.fn(
    "copyScientForkAttachments",
  )(function* (input) {
    if (input.copies.length === 0) return;
    yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ScientForkAttachmentCopyError({
            threadId: input.threadId,
            reason: "target-write-failed",
            detail: "Unable to prepare Scient's attachment directory for the fork.",
            cause,
          }),
      ),
    );

    yield* Effect.forEach(
      input.copies,
      (copy) =>
        Effect.gen(function* () {
          const expectedThreadSegment = toSafeThreadAttachmentSegment(input.threadId);
          if (
            expectedThreadSegment === null ||
            parseThreadSegmentFromAttachmentId(copy.target.id) !== expectedThreadSegment
          ) {
            return yield* new ScientForkAttachmentCopyError({
              threadId: input.threadId,
              reason: "unsafe-mapping",
              detail: `Retained attachment '${copy.source.name}' is not owned by the fork.`,
            });
          }
          const sourcePath = resolveAttachmentPath({
            attachmentsDir,
            attachment: copy.source,
          });
          const targetPath = resolveAttachmentPath({
            attachmentsDir,
            attachment: copy.target,
          });
          if (sourcePath === null || targetPath === null || sourcePath === targetPath) {
            return yield* new ScientForkAttachmentCopyError({
              threadId: input.threadId,
              reason: "unsafe-mapping",
              detail: `Unsafe retained attachment mapping for '${copy.source.name}'.`,
            });
          }

          const sourceInfo = yield* fileSystem.stat(sourcePath).pipe(
            Effect.mapError(
              (cause) =>
                new ScientForkAttachmentCopyError({
                  threadId: input.threadId,
                  reason: "source-unavailable",
                  detail: `Retained attachment '${copy.source.name}' is no longer available in the origin conversation.`,
                  cause,
                }),
            ),
          );
          if (sourceInfo.type !== "File") {
            return yield* new ScientForkAttachmentCopyError({
              threadId: input.threadId,
              reason: "source-unavailable",
              detail: `Retained attachment '${copy.source.name}' is no longer available in the origin conversation.`,
            });
          }

          yield* fileSystem.copyFile(sourcePath, targetPath).pipe(
            Effect.mapError(
              (cause) =>
                new ScientForkAttachmentCopyError({
                  threadId: input.threadId,
                  reason: "target-write-failed",
                  detail: `Unable to retain attachment '${copy.source.name}' in the fork.`,
                  cause,
                }),
            ),
          );
          const targetInfo = yield* fileSystem.stat(targetPath).pipe(
            Effect.mapError(
              (cause) =>
                new ScientForkAttachmentCopyError({
                  threadId: input.threadId,
                  reason: "target-write-failed",
                  detail: `Unable to verify retained attachment '${copy.source.name}'.`,
                  cause,
                }),
            ),
          );
          if (
            sourceInfo.type !== "File" ||
            targetInfo.type !== "File" ||
            sourceInfo.size !== targetInfo.size
          ) {
            return yield* new ScientForkAttachmentCopyError({
              threadId: input.threadId,
              reason: "verification-failed",
              detail: `Retained attachment '${copy.source.name}' did not copy completely.`,
            });
          }
        }),
      { concurrency: 1, discard: true },
    );
  });

  return { copyAll } satisfies ScientForkAttachmentCopierShape;
});

export const ScientForkAttachmentCopierLive = Layer.effect(ScientForkAttachmentCopier, make);

export const testLayer = (
  overrides?: Partial<ScientForkAttachmentCopierShape>,
): Layer.Layer<ScientForkAttachmentCopier> =>
  Layer.succeed(ScientForkAttachmentCopier, {
    copyAll: () => Effect.void,
    ...overrides,
  });
