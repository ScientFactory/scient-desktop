import * as Base64 from "effect/encoding/Base64";
import {
  ChatAttachmentId,
  PersistChatAttachmentsError,
  type ThreadId,
  type MessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "./config.ts";
import { attachmentRelativePath, createDeterministicAttachmentId } from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { reserveAttachment } from "./orchestration-v2/AttachmentFileUse.ts";

export const persistChatAttachments = Effect.fn("AttachmentPersistence.persistChatAttachments")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly attachments: ReadonlyArray<{
      readonly type: "image";
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly dataUrl: string;
    }>;
  }) {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.forEach(
      input.attachments.map((attachment, index) => ({ attachment, index })),
      Effect.fn("AttachmentPersistence.persistChatAttachment")(function* ({ attachment, index }) {
        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
          return yield* new PersistChatAttachmentsError({
            message: `Attachment ${attachment.name} has an invalid image payload.`,
          });
        }
        const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Attachment ${attachment.name} is not valid base64.`,
                cause,
              }),
          ),
        );
        if (bytes.byteLength !== attachment.sizeBytes) {
          return yield* new PersistChatAttachmentsError({
            message: `Attachment ${attachment.name} size does not match its payload.`,
          });
        }
        const rawId = createDeterministicAttachmentId(
          input.threadId,
          `${input.messageId}:${index}`,
        );
        if (rawId === null) {
          return yield* new PersistChatAttachmentsError({
            message: "Could not allocate an attachment identifier.",
          });
        }
        const persisted = {
          type: "image" as const,
          id: ChatAttachmentId.make(rawId),
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        };
        // This API publishes before client admission. Keep its durable reservation
        // until an explicit receipt owner can reconcile the separate operation.
        const reservation = yield* reserveAttachment(persisted, { publication: true }).pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: "Could not reserve attachment publication.",
                cause,
              }),
          ),
        );
        const destination = path.join(config.attachmentsDir, attachmentRelativePath(persisted)!);
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Publication is exclusive and atomic: an interrupted write leaves
            // only a private temporary file, never a partial attachment identity.
            const temporary = yield* fileSystem.makeTempFileScoped({
              directory: config.attachmentsDir,
              prefix: ".attachment-upload-",
            });
            yield* fileSystem.writeFile(temporary, bytes);
            const handle = yield* fileSystem.open(temporary, { flag: "r+" });
            yield* handle.sync;
            yield* fileSystem.link(temporary, destination).pipe(
              Effect.catch((error) =>
                error.reason._tag !== "AlreadyExists"
                  ? Effect.fail(error)
                  : fileSystem.readFile(destination).pipe(
                      Effect.flatMap((existing) =>
                        existing.byteLength === bytes.byteLength &&
                        existing.every((byte, index) => byte === bytes[index])
                          ? Effect.void
                          : Effect.fail(
                              new PersistChatAttachmentsError({
                                message: `Attachment ${attachment.name} conflicts with previously stored bytes.`,
                              }),
                            ),
                      ),
                    ),
              ),
            );
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Could not persist attachment ${attachment.name}.`,
                cause,
              }),
          ),
        );
        yield* reservation
          .ready({
            kind: "message-publication",
            threadId: input.threadId,
            messageId: input.messageId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PersistChatAttachmentsError({
                  message: "Could not record attachment publication.",
                  cause,
                }),
            ),
          );
        return persisted;
      }),
      { concurrency: 2 },
    );
  },
);
