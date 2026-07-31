// FILE: generatedImageAttachments.ts
// Purpose: Materializes trusted provider-generated image files as durable chat attachments.
// Layer: Server provider utility
// Exports: validated, replay-safe generated-image attachment persistence

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ChatImageAttachment } from "@synara/contracts";

import {
  resolveAttachmentPath,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "./attachmentStore.ts";
import { syncDirectoryEntry } from "./privatePathPermissions.ts";

const GENERATED_IMAGE_MIME_TYPES = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
} as const;
const GENERATED_IMAGE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const GENERATED_IMAGE_TEMP_FILE_PATTERN =
  /^[a-z0-9_-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:gif|jpg|png|webp)\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type GeneratedImageMimeType = keyof typeof GENERATED_IMAGE_MIME_TYPES;

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveAuthorizedSourceRoot(root: string): Promise<string | null> {
  try {
    const before = await fs.lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    const realRoot = await fs.realpath(root);
    const [canonical, after] = await Promise.all([fs.stat(realRoot), fs.lstat(root)]);
    if (
      !canonical.isDirectory() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== canonical.dev ||
      before.ino !== canonical.ino ||
      after.dev !== canonical.dev ||
      after.ino !== canonical.ino
    ) {
      return null;
    }
    return realRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

async function readValidatedGeneratedImage(
  pathname: string,
  authorizedRoots?: ReadonlyArray<string>,
): Promise<{
  readonly bytes: Buffer;
  readonly mimeType: GeneratedImageMimeType;
}> {
  const handle = await fs.open(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Generated image is not a regular file.");
    }
    if (stat.size <= 0 || stat.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error("Generated image is empty or exceeds the chat image size limit.");
    }
    if (authorizedRoots) {
      const [postOpenRealPath, pathStat] = await Promise.all([
        fs.realpath(pathname),
        fs.stat(pathname),
      ]);
      if (!authorizedRoots.some((root) => isPathInside(postOpenRealPath, root))) {
        throw new Error("Provider image escaped its authorized generated-image root.");
      }
      if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
        throw new Error("Generated image path identity changed while it was being opened.");
      }
    }
    bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const finalStat = await handle.stat();
    if (
      offset !== bytes.length ||
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ino !== stat.ino
    ) {
      throw new Error("Generated image changed while it was being read.");
    }
  } finally {
    await handle.close();
  }

  const mimeType = detectGeneratedImageMimeType(bytes);
  if (!mimeType) {
    throw new Error("Generated image format is unsupported or does not match its file contents.");
  }
  return { bytes, mimeType };
}

async function recoverDurableGeneratedImageAttachment(input: {
  readonly threadId: string;
  readonly provenanceKey: string;
  readonly attachmentsDir: string;
}): Promise<{
  readonly attachment: ChatImageAttachment;
  readonly bytes: Buffer;
} | null> {
  const id = generatedImageAttachmentId(input);
  const pathname = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: id,
  });
  if (!pathname) return null;

  const validated = await readValidatedGeneratedImage(pathname).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!validated) return null;
  const { bytes, mimeType } = validated;
  const extension = GENERATED_IMAGE_MIME_TYPES[mimeType];
  if (path.extname(pathname).toLowerCase() !== extension) {
    throw new Error("Persisted generated image extension does not match its file contents.");
  }
  return {
    attachment: {
      type: "image",
      id,
      name: `generated-image${extension}`,
      mimeType,
      sizeBytes: bytes.byteLength,
    },
    bytes,
  };
}

async function persistAtomically(input: {
  readonly destinationPath: string;
  readonly bytes: Buffer;
}): Promise<void> {
  const destinationDirectory = path.dirname(input.destinationPath);
  await fs.mkdir(destinationDirectory, {
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
    await syncDirectoryEntry(destinationDirectory);
  } finally {
    await fs.rm(temporaryPath, { force: true });
    await syncDirectoryEntry(destinationDirectory);
  }
}

export async function cleanupStaleGeneratedImageAttachmentTemps(input: {
  readonly attachmentsDir: string;
  readonly now?: number;
}): Promise<number> {
  const entries = await fs.readdir(input.attachmentsDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const cutoff = (input.now ?? Date.now()) - GENERATED_IMAGE_TEMP_MAX_AGE_MS;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !GENERATED_IMAGE_TEMP_FILE_PATTERN.test(entry.name)) continue;
    const pathname = path.join(input.attachmentsDir, entry.name);
    const stat = await fs.lstat(pathname).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue;
    await fs.rm(pathname, { force: true });
    removed += 1;
  }
  if (removed > 0) await syncDirectoryEntry(input.attachmentsDir);
  return removed;
}

export async function materializeGeneratedImageAttachment(input: {
  readonly threadId: string;
  readonly sourcePath: string;
  readonly provenanceKey: string;
  readonly allowedSourceRoots: ReadonlyArray<string>;
  readonly attachmentsDir: string;
  readonly allowDurableFallbackWhenSourceUnavailable?: boolean;
}): Promise<ChatImageAttachment> {
  const durableAttachment = await recoverDurableGeneratedImageAttachment(input);
  const [realSourceResult, realRoots] = await Promise.all([
    fs.realpath(input.sourcePath).then(
      (pathname) => ({ pathname, error: null }),
      (error: unknown) => ({ pathname: null, error }),
    ),
    Promise.all(input.allowedSourceRoots.map(resolveAuthorizedSourceRoot)),
  ]);
  if (!realSourceResult.pathname) {
    const sourceCode = (realSourceResult.error as NodeJS.ErrnoException).code;
    if (
      durableAttachment &&
      input.allowDurableFallbackWhenSourceUnavailable === true &&
      (sourceCode === "ENOENT" || sourceCode === "ENOTDIR")
    ) {
      return durableAttachment.attachment;
    }
    throw realSourceResult.error;
  }
  const realSourcePath = realSourceResult.pathname;
  if (!realRoots.some((root) => root !== null && isPathInside(realSourcePath, root))) {
    throw new Error("Provider image is outside the authorized generated-image roots.");
  }

  // Refuse a final-component symlink if the source is swapped between realpath
  // authorization and open. This closes the practical TOCTOU escape without
  // weakening the allowed-root policy.
  const { bytes, mimeType } = await readValidatedGeneratedImage(
    realSourcePath,
    realRoots.filter((root): root is string => root !== null),
  );
  if (
    durableAttachment &&
    (durableAttachment.attachment.mimeType !== mimeType || !durableAttachment.bytes.equals(bytes))
  ) {
    throw new Error("A generated-image replay resolved to different persisted bytes or format.");
  }
  if (durableAttachment) {
    return durableAttachment.attachment;
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
