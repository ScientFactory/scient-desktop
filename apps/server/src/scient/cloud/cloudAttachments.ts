// @effect-diagnostics nodeBuiltinImport:off -- Snapshot digests hash with Node's crypto.
import * as NodeCrypto from "node:crypto";

import {
  canonicalSnapshotContent,
  type ConversationSnapshotContent,
} from "@scientfactory/conversation";
import type { ConversationAttachment, ConversationSnapshotV1 } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

export const sha256Hex = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A regular file's size, or null when it is missing or unreadable. */
export const fileSize = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.stat(path).pipe(
    Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
    Effect.orElseSucceed(() => null),
  );

/** The file's bytes when it holds at most `maxBytes`; never reads past that. */
export const readBounded = Effect.fn("CloudAttachments.readBounded")(
  function* (fileSystem: FileSystem.FileSystem, path: string, maxBytes: number) {
    const size = yield* fileSize(fileSystem, path);
    if (size === null || size > maxBytes) return null;
    const chunks = yield* fileSystem
      .stream(path, { bytesToRead: maxBytes + 1 })
      .pipe(Stream.runCollect);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    if (total > maxBytes) return null;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  },
  Effect.orElseSucceed(() => null),
);

/** Every attachment a snapshot names: on messages and on submitted answers. */
export const snapshotAttachments = (
  snapshot: Pick<ConversationSnapshotV1, "messages" | "questionAnswers">,
): ReadonlyArray<ConversationAttachment> => [
  ...snapshot.messages.flatMap((message) => message.attachments),
  ...snapshot.questionAnswers.flatMap((answer) => answer.items.flatMap((item) => item.attachments)),
];

/** Marks unavailable every attachment whose bytes do not travel with the document. */
export const markAttachments = <S extends ConversationSnapshotContent>(
  snapshot: S,
  travels: (localId: string) => boolean,
): S => {
  let changed = false;
  const mark = (attachments: ReadonlyArray<ConversationAttachment>) =>
    attachments.map((attachment) => {
      if (!attachment.available || travels(attachment.localId)) return attachment;
      changed = true;
      return { ...attachment, available: false };
    });
  const messages = snapshot.messages.map((message) => ({
    ...message,
    attachments: mark(message.attachments),
  }));
  const questionAnswers = snapshot.questionAnswers.map((answer) => ({
    ...answer,
    items: answer.items.map((item) => ({ ...item, attachments: mark(item.attachments) })),
  }));
  return changed ? { ...snapshot, messages, questionAnswers } : snapshot;
};

export const withContentDigest = (
  content: Omit<ConversationSnapshotV1, "contentDigest">,
): ConversationSnapshotV1 => ({
  ...content,
  contentDigest: `sha256:${sha256Hex(canonicalSnapshotContent(content))}`,
});
