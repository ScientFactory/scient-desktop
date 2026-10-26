import * as FileSystem from "effect/FileSystem";
import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isSvgAttachment } from "@t3tools/shared/image";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { reserveAttachment, type AttachmentReservationOwner } from "./AttachmentFileUse.ts";
import * as DocumentText from "../provider/DocumentText.ts";

export class AttachmentClaimError extends Schema.TaggedError<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isAttachmentClaimError = Schema.is(AttachmentClaimError);

export const validateAttachmentLimits = Effect.fn("AttachmentClaims.validateAttachmentLimits")(
  function* (attachments: ReadonlyArray<ChatAttachment>) {
    const error = getProviderAttachmentLimitError(attachments);
    if (error) return yield* new AttachmentClaimError({ message: error });
  },
);

export interface ClaimedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
  readonly releasePins: Effect.Effect<void>;
  readonly bindReceipt: (
    owner: Extract<AttachmentReservationOwner, { kind: "command" }>,
  ) => Effect.Effect<void, AttachmentClaimError>;
}

export function attachmentIsPendingUpload(attachment: ChatAttachment): boolean {
  return parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;
}

/** Remove partial claims only before dispatch, or after proving they were not accepted. */
export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      claimedPaths,
      (path) =>
        fileSystem
          .remove(path)
          .pipe(
            Effect.ignore,
            Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true }).pipe(Effect.ignore)),
          ),
      {
        concurrency: 1,
        discard: true,
      },
    ).pipe(Effect.uninterruptible);
  },
);

/** Copies preserve the pending retry source after failed bootstrap; the pending sweep reclaims it.
 * Already-claimed attachments retain receipt pins and verify managed bytes before admission. */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    yield* validateAttachmentLimits(input.attachments);
    if (input.attachments.length === 0)
      return {
        attachments: [],
        claimedPaths: [],
        releasePins: Effect.void,
        bindReceipt: () => Effect.void,
      } satisfies ClaimedAttachments;
    if (
      new Set(input.attachments.map((attachment) => attachment.id)).size !==
      input.attachments.length
    ) {
      return yield* new AttachmentClaimError({
        message: "Duplicate attachment ids are not allowed.",
      });
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: string[] = [];
    const releases: Array<Effect.Effect<void>> = [];
    const ready: Array<
      (
        owner: AttachmentReservationOwner,
      ) => Effect.Effect<void, import("effect/PlatformError").PlatformError>
    > = [];
    const releasePins = Effect.suspend(() =>
      Effect.forEach(releases, (release) => release, { discard: true }),
    );
    const documents = yield* DocumentText.DocumentText;
    const attachments = yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!attachmentIsPendingUpload(attachment)) {
            const pin = yield* reserveAttachment(attachment);
            releases.push(pin.release);
            ready.push(pin.ready);
            return attachment;
          }
          const claim = planAttachmentClaim({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
            attachmentId: attachment.id,
          });
          if (!claim.ok) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
            });
          }
          const pin = yield* reserveAttachment(
            { ...attachment, id: ChatAttachmentId.make(claim.finalId) },
            { publication: true },
          );
          releases.push(pin.release);
          ready.push(pin.ready);
          const info = yield* fileSystem.stat(claim.currentPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                  cause,
                }),
            ),
          );
          if (Number(info.size) !== attachment.sizeBytes) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
            });
          }
          const normalized: ChatAttachment = {
            ...attachment,
            id: ChatAttachmentId.make(claim.finalId),
            name:
              attachment.type === "file" &&
              isSvgAttachment(attachment) &&
              !/\.svg$/i.test(attachment.name)
                ? `${attachment.name}.svg`
                : attachment.name,
            mimeType: attachment.mimeType.toLowerCase(),
          };
          const expectedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: normalized,
          });
          if (expectedPath !== claim.finalPath) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
            });
          }
          // Copies isolate edits from the retry source. Keep the uncancellable copy and rollback registration
          // uninterruptible so cleanup always sees completed writes.
          yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                  cause,
                }),
            ),
            Effect.andThen(Effect.sync(() => claimedPaths.push(claim.finalPath))),
            Effect.uninterruptible,
          );
          const sidecar = `${claim.currentPath}.txt`;
          if (yield* fileSystem.exists(sidecar).pipe(Effect.orElseSucceed(() => false))) {
            yield* fileSystem.copyFile(sidecar, `${claim.finalPath}.txt`).pipe(
              Effect.andThen(Effect.sync(() => claimedPaths.push(`${claim.finalPath}.txt`))),
              Effect.onError(() =>
                fileSystem.remove(`${claim.finalPath}.txt`, { force: true }).pipe(Effect.ignore),
              ),
              Effect.uninterruptible,
              Effect.ignore,
            );
          } else {
            const extracted = yield* documents.ensure(claim.finalPath);
            if (extracted) claimedPaths.push(extracted);
          }
          return normalized;
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.mapError((cause) =>
        isAttachmentClaimError(cause)
          ? cause
          : new AttachmentClaimError({
              message: "Attachment bytes are unavailable before admission.",
              cause,
            }),
      ),
      Effect.onError(() =>
        releaseClaimedAttachments(claimedPaths).pipe(Effect.andThen(releasePins)),
      ),
    );
    return {
      attachments,
      claimedPaths,
      releasePins,
      bindReceipt: (owner) =>
        Effect.forEach(ready, (publish) => publish(owner), { discard: true }).pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentClaimError({
                message: "Could not record attachment receipt ownership.",
                cause,
              }),
          ),
          Effect.onError(() =>
            releaseClaimedAttachments(claimedPaths).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.andThen(releasePins),
            ),
          ),
        ),
    } satisfies ClaimedAttachments;
  },
);
