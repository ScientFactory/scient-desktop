// FILE: promptAttachments.ts
// Purpose: Shared helpers for turning persisted chat attachments into provider-native prompt inputs.
// Layer: Provider adapter utilities
// Depends on: shared chat attachment contracts.

import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ChatImageAttachment,
} from "@synara/contracts";
import { Effect, type FileSystem } from "effect";

// Assistant selections stay in history as attachments, but the composer serializes them into text.
export function filterProviderPromptImageAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ChatImageAttachment[] {
  return (attachments ?? []).filter(
    (attachment): attachment is ChatImageAttachment => attachment.type === "image",
  );
}

/**
 * Reads a persisted prompt image without trusting its stale attachment metadata
 * or allowing a replaced file to trigger an unbounded allocation.
 */
export function readProviderPromptImage(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
  readonly expectedBytes: number;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* input.fileSystem.open(input.path, { flag: "r" });
      const before = yield* file.stat;
      const expectedBytes = BigInt(input.expectedBytes);
      const maximumBytes = BigInt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);

      if (before.type !== "File") {
        return yield* Effect.fail(new Error("Attachment path is not a regular file."));
      }
      if (before.size <= 0n) {
        return yield* Effect.fail(new Error("Attachment file is empty."));
      }
      if (before.size > maximumBytes) {
        return yield* Effect.fail(new Error("Attachment file is larger than allowed."));
      }
      if (before.size !== expectedBytes) {
        return yield* Effect.fail(new Error("Attachment file size does not match its metadata."));
      }

      const bytes = yield* file.readAlloc(before.size);
      if (!bytes || BigInt(bytes.byteLength) !== before.size) {
        return yield* Effect.fail(new Error("Attachment file changed while it was read."));
      }

      const trailingBytes = yield* file.readAlloc(1);
      if (trailingBytes !== undefined) {
        return yield* Effect.fail(new Error("Attachment file changed while it was read."));
      }

      const after = yield* file.stat;
      if (
        after.type !== "File" ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        return yield* Effect.fail(new Error("Attachment file changed while it was read."));
      }

      return bytes;
    }),
  );
}
