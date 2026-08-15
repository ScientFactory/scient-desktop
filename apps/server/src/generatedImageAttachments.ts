// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type ChatImageAttachment } from "@t3tools/contracts";

import {
  resolveAttachmentPath,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "./attachmentStore.ts";

const GENERATED_IMAGE_EXTENSIONS = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
} as const;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const TEMP_FILE_PATTERN =
  /^[a-z0-9_-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:gif|jpg|png|webp)\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type GeneratedImageMimeType = keyof typeof GENERATED_IMAGE_EXTENSIONS;

function isInside(candidate: string, root: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

async function canonicalDirectory(root: string): Promise<string | null> {
  try {
    const before = await NodeFSP.lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    const canonical = await NodeFSP.realpath(root);
    const [canonicalStat, after] = await Promise.all([
      NodeFSP.stat(canonical),
      NodeFSP.lstat(root),
    ]);
    if (
      !canonicalStat.isDirectory() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== canonicalStat.dev ||
      before.ino !== canonicalStat.ino ||
      after.dev !== canonicalStat.dev ||
      after.ino !== canonicalStat.ino
    ) {
      return null;
    }
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function detectMimeType(bytes: Uint8Array): GeneratedImageMimeType | null {
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
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
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

function deterministicUuid(value: string): string {
  const digest = NodeCrypto.createHash("sha256").update(value).digest();
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
  if (!threadSegment) throw new Error("Generated image has no valid owning thread.");
  return `${threadSegment}-${deterministicUuid(`${input.threadId}\0${input.provenanceKey}`)}`;
}

async function readExisting(pathname: string): Promise<Buffer | null> {
  try {
    return await NodeFSP.readFile(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectoryEntry(directory: string): Promise<void> {
  try {
    const handle = await NodeFSP.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Windows and some filesystems do not permit opening or syncing a
    // directory. The file itself was already fsynced before publication.
    if (
      ["EACCES", "EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return;
    }
    throw error;
  }
}

async function readValidatedImage(
  pathname: string,
  authorizedRoots?: ReadonlyArray<string>,
): Promise<{ readonly bytes: Buffer; readonly mimeType: GeneratedImageMimeType }> {
  const handle = await NodeFSP.open(
    pathname,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Generated image is not a regular file.");
    if (before.size <= 0 || before.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error("Generated image is empty or exceeds the chat image size limit.");
    }
    if (authorizedRoots) {
      const [realPath, pathStat] = await Promise.all([
        NodeFSP.realpath(pathname),
        NodeFSP.stat(pathname),
      ]);
      if (!authorizedRoots.some((root) => isInside(realPath, root))) {
        throw new Error("Generated image escaped its authorized provider-thread directory.");
      }
      if (pathStat.dev !== before.dev || pathStat.ino !== before.ino) {
        throw new Error("Generated image identity changed while it was being opened.");
      }
    }
    bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== bytes.length ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    ) {
      throw new Error("Generated image changed while it was being read.");
    }
  } finally {
    await handle.close();
  }
  const mimeType = detectMimeType(bytes);
  if (!mimeType) throw new Error("Generated image has an unsupported raster format.");
  return { bytes, mimeType };
}

async function recoverDurable(input: {
  readonly attachmentsDir: string;
  readonly provenanceKey: string;
  readonly threadId: string;
}): Promise<{ readonly attachment: ChatImageAttachment; readonly bytes: Buffer } | null> {
  const id = generatedImageAttachmentId(input);
  const pathname = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: id,
  });
  if (!pathname) return null;
  const { bytes, mimeType } = await readValidatedImage(pathname);
  const extension = GENERATED_IMAGE_EXTENSIONS[mimeType];
  if (NodePath.extname(pathname).toLowerCase() !== extension) {
    throw new Error("Persisted generated image extension does not match its bytes.");
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

async function persistAtomically(pathname: string, bytes: Buffer): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(pathname), { recursive: true, mode: 0o700 });
  const existing = await readExisting(pathname);
  if (existing) {
    if (existing.equals(bytes)) return;
    throw new Error("Generated-image replay resolved to different persisted bytes.");
  }
  const temporaryPath = `${pathname}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    const handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await NodeFSP.link(temporaryPath, pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readExisting(pathname);
      if (!raced?.equals(bytes)) {
        throw new Error("Concurrent generated-image replays produced different bytes.", {
          cause: error,
        });
      }
    }
    await syncDirectoryEntry(NodePath.dirname(pathname));
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true });
  }
}

export async function materializeGeneratedImageAttachment(input: {
  readonly threadId: string;
  readonly sourcePath: string;
  readonly provenanceKey: string;
  readonly allowedSourceRoots: ReadonlyArray<string>;
  readonly attachmentsDir: string;
  readonly allowDurableFallbackWhenSourceUnavailable?: boolean;
}): Promise<ChatImageAttachment> {
  const durable = await recoverDurable(input);
  const [sourceResult, roots] = await Promise.all([
    NodeFSP.realpath(input.sourcePath).then(
      (pathname) => ({ pathname, error: null }),
      (error: unknown) => ({ pathname: null, error }),
    ),
    Promise.all(input.allowedSourceRoots.map(canonicalDirectory)),
  ]);
  if (!sourceResult.pathname) {
    const code = (sourceResult.error as NodeJS.ErrnoException).code;
    if (
      durable &&
      input.allowDurableFallbackWhenSourceUnavailable === true &&
      (code === "ENOENT" || code === "ENOTDIR")
    ) {
      return durable.attachment;
    }
    throw sourceResult.error;
  }
  const realRoots = roots.filter((root): root is string => root !== null);
  if (!realRoots.some((root) => isInside(sourceResult.pathname!, root))) {
    throw new Error("Generated image is outside its authorized provider-thread directory.");
  }
  const { bytes, mimeType } = await readValidatedImage(sourceResult.pathname, realRoots);
  if (durable && (durable.attachment.mimeType !== mimeType || !durable.bytes.equals(bytes))) {
    throw new Error("Generated-image replay resolved to different persisted bytes or format.");
  }
  if (durable) return durable.attachment;

  const extension = GENERATED_IMAGE_EXTENSIONS[mimeType];
  const attachment: ChatImageAttachment = {
    type: "image",
    id: generatedImageAttachmentId(input),
    name: `generated-image${extension}`,
    mimeType,
    sizeBytes: bytes.byteLength,
  };
  const destination = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
  if (!destination) throw new Error("Cannot resolve the generated-image attachment path.");
  await persistAtomically(destination, bytes);
  return attachment;
}

export async function cleanupStaleGeneratedImageAttachmentTemps(input: {
  readonly attachmentsDir: string;
  readonly now: number;
}): Promise<number> {
  const entries = await NodeFSP.readdir(input.attachmentsDir, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  const cutoff = input.now - TEMP_MAX_AGE_MS;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) continue;
    const pathname = NodePath.join(input.attachmentsDir, entry.name);
    const stat = await NodeFSP.lstat(pathname).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue;
    await NodeFSP.rm(pathname, { force: true });
    removed += 1;
  }
  return removed;
}
