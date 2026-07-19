// FILE: promptAttachments.ts
// Purpose: Shared helpers for turning persisted chat attachments into provider-native prompt inputs.
// Layer: Provider adapter utilities
// Depends on: shared chat attachment contracts.

import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ChatImageAttachment,
} from "@synara/contracts";
import { Effect, type FileSystem } from "effect";

const unstableAttachmentError = () =>
  new Error("Attachment path is not a stable regular file inside the attachment store.");

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertStableOpenedAttachment(input: {
  readonly attachmentPath: string;
  readonly lexicalRoot: string;
  readonly canonicalRoot: string;
  readonly rootStat: Stats;
  readonly handle: FileHandle;
}): Promise<Stats> {
  const [openedStat, pathStat, currentRootStat, currentCanonicalRoot, canonicalAttachmentPath] =
    await Promise.all([
      input.handle.stat(),
      lstat(input.attachmentPath),
      lstat(input.lexicalRoot),
      realpath(input.lexicalRoot),
      realpath(input.attachmentPath),
    ]);
  if (
    !openedStat.isFile() ||
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    !currentRootStat.isDirectory() ||
    currentRootStat.isSymbolicLink() ||
    !isSameFile(input.rootStat, currentRootStat) ||
    path.relative(input.canonicalRoot, currentCanonicalRoot) !== "" ||
    !isPathInside(input.canonicalRoot, canonicalAttachmentPath) ||
    !isSameFile(openedStat, pathStat)
  ) {
    throw unstableAttachmentError();
  }
  return openedStat;
}

async function readStableAttachment(input: {
  readonly attachmentsDir: string;
  readonly path: string;
  readonly expectedBytes: number;
}): Promise<Uint8Array> {
  const attachmentPath = path.resolve(input.path);
  const lexicalRoot = path.resolve(input.attachmentsDir);
  if (!isPathInside(lexicalRoot, attachmentPath)) {
    throw unstableAttachmentError();
  }
  const [initialPathStat, rootStat, canonicalRoot, canonicalAttachmentPath] = await Promise.all([
    lstat(attachmentPath),
    lstat(lexicalRoot),
    realpath(lexicalRoot),
    realpath(attachmentPath),
  ]);
  if (
    !initialPathStat.isFile() ||
    initialPathStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !isPathInside(canonicalRoot, canonicalAttachmentPath)
  ) {
    throw unstableAttachmentError();
  }

  const noFollowFlag = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(attachmentPath, fsConstants.O_RDONLY | noFollowFlag);
  } catch (cause) {
    if (["ELOOP", "EMLINK"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
      throw unstableAttachmentError();
    }
    throw cause;
  }

  try {
    const before = await assertStableOpenedAttachment({
      attachmentPath,
      lexicalRoot,
      canonicalRoot,
      rootStat,
      handle,
    });
    const expectedBytes = BigInt(input.expectedBytes);
    const maximumBytes = BigInt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);

    if (before.size <= 0) {
      throw new Error("Attachment file is empty.");
    }
    if (BigInt(before.size) > maximumBytes) {
      throw new Error("Attachment file is larger than allowed.");
    }
    if (BigInt(before.size) !== expectedBytes) {
      throw new Error("Attachment file size does not match its metadata.");
    }

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (bytesRead === 0) {
        throw new Error("Attachment file changed while it was read.");
      }
      offset += bytesRead;
    }

    const trailingByte = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytesRead } = await handle.read(trailingByte, 0, 1, null);
    if (trailingBytesRead !== 0) {
      throw new Error("Attachment file changed while it was read.");
    }

    const after = await assertStableOpenedAttachment({
      attachmentPath,
      lexicalRoot,
      canonicalRoot,
      rootStat,
      handle,
    });
    if (after.size !== before.size || !isSameFile(after, before)) {
      throw new Error("Attachment file changed while it was read.");
    }

    return bytes;
  } finally {
    await handle.close();
  }
}

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
  readonly attachmentsDir: string;
  readonly path: string;
  readonly expectedBytes: number;
}) {
  // Keep the injected service in this API for provider-layer consistency. Native descriptor flags
  // are required because Effect's portable open flags cannot express O_NOFOLLOW, and Windows needs
  // explicit lstat/realpath/descriptor identity validation instead.
  void input.fileSystem;
  return Effect.tryPromise({
    try: () => readStableAttachment(input),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}
