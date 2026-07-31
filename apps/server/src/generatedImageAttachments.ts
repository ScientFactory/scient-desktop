// FILE: generatedImageAttachments.ts
// Purpose: Materializes trusted provider-generated image files as durable chat attachments.
// Layer: Server provider utility
// Exports: validated, replay-safe generated-image attachment persistence

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ChatImageAttachment } from "@synara/contracts";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "./attachmentStore.ts";

const GENERATED_IMAGE_MIME_TYPES = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
} as const;

type GeneratedImageMimeType = keyof typeof GENERATED_IMAGE_MIME_TYPES;

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function detectGeneratedImageMimeType(bytes: Uint8Array): GeneratedImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function deterministicAttachmentUuid(input: string): string {
  const digest = crypto.createHash("sha256").update(input).digest();
  // Format the digest as an RFC 4122-shaped UUID so the existing attachment
  // ownership and cleanup helpers can recover the thread segment. Version and
  // variant bits are fixed; this is an identifier, not a claim of randomness.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function generatedImageAttachmentId(input: {
  readonly threadId: string;
  readonly provenanceKey: string;
}): string {
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  if (!threadSegment) {
    throw new Error("Cannot create an attachment id for the provider image thread.");
  }
  return `${threadSegment}-${deterministicAttachmentUuid(`${input.threadId}\0${input.provenanceKey}`)}`;
}

async function readExistingAttachment(pathname: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function persistAtomically(input: {
  readonly destinationPath: string;
  readonly bytes: Buffer;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.destinationPath), {
    recursive: true,
    mode: 0o700,
  });
  const existing = await readExistingAttachment(input.destinationPath);
  if (existing) {
    if (existing.equals(input.bytes)) return;
    throw new Error("A generated-image replay resolved to different persisted bytes.");
  }

  const temporaryPath = `${input.destinationPath}.tmp-${crypto.randomUUID()}`;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // A hard link publishes the complete file without replacing an existing
      // deterministic target if a duplicate event wins the race.
      await fs.link(temporaryPath, input.destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readExistingAttachment(input.destinationPath);
      if (!raced?.equals(input.bytes)) {
        throw new Error("Concurrent generated-image replays produced different bytes.", {
          cause: error,
        });
      }
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function materializeGeneratedImageAttachment(input: {
  readonly threadId: string;
  readonly sourcePath: string;
  readonly provenanceKey: string;
  readonly allowedSourceRoots: ReadonlyArray<string>;
  readonly attachmentsDir: string;
}): Promise<ChatImageAttachment> {
  const [realSourcePath, realRoots] = await Promise.all([
    fs.realpath(input.sourcePath),
    Promise.all(input.allowedSourceRoots.map((root) => fs.realpath(root).catch(() => null))),
  ]);
  if (!realRoots.some((root) => root !== null && isPathInside(realSourcePath, root))) {
    throw new Error("Provider image is outside the authorized generated-image roots.");
  }

  // Refuse a final-component symlink if the source is swapped between realpath
  // authorization and open. This closes the practical TOCTOU escape without
  // weakening the allowed-root policy.
  const sourceHandle = await fs.open(realSourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await sourceHandle.stat();
    if (!stat.isFile()) {
      throw new Error("Provider image source is not a regular file.");
    }
    if (stat.size <= 0 || stat.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error("Provider image is empty or exceeds the chat image size limit.");
    }
    bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await sourceHandle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) {
      throw new Error("Provider image changed while it was being materialized.");
    }
    const finalStat = await sourceHandle.stat();
    if (
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ino !== stat.ino
    ) {
      throw new Error("Provider image changed while it was being materialized.");
    }
  } finally {
    await sourceHandle.close();
  }

  const mimeType = detectGeneratedImageMimeType(bytes);
  if (!mimeType) {
    throw new Error("Provider image format is unsupported or does not match its file contents.");
  }
  const extension = GENERATED_IMAGE_MIME_TYPES[mimeType];
  const attachmentId = generatedImageAttachmentId(input);
  const attachment: ChatImageAttachment = {
    type: "image",
    id: attachmentId,
    name: `generated-image${extension}`,
    mimeType,
    sizeBytes: bytes.byteLength,
  };
  const destinationPath = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment,
  });
  if (!destinationPath) {
    throw new Error("Cannot resolve the provider image attachment destination.");
  }
  await persistAtomically({ destinationPath, bytes });
  return attachment;
}

export async function removeMaterializedGeneratedImageAttachment(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatImageAttachment;
}): Promise<void> {
  const attachmentPath = resolveAttachmentPath(input);
  if (attachmentPath) {
    await fs.rm(attachmentPath, { force: true });
  }
}
