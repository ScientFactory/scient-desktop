// @effect-diagnostics nodeBuiltinImport:off -- local preview reads one explicitly selected regular file.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  ConversationExternalExportId,
  ConversationExternalId,
  ConversationImportFormatVersion,
  ConversationImportResourceId,
  ConversationSnapshotV1,
  DocumentWarning,
  IsoDateTime,
  NonNegativeInt,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  SCIC_FORMAT,
  SCIC_FORMAT_MAJOR_VERSION,
  SCIC_MEDIA_TYPE,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES,
  Sha256Digest,
  TrimmedNonEmptyString,
  type ConversationSnapshotV1 as ConversationSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Yauzl from "yauzl";

const MIMETYPE = "mimetype";
const MANIFEST = "manifest.json";
const SNAPSHOT = "conversation.json";
const MARKDOWN = "conversation.md";
const MAX_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;
const MAX_UNCOMPRESSED_BYTES =
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES +
  MAX_ARCHIVE_SNAPSHOT_BYTES +
  MAX_MARKDOWN_BYTES +
  MAX_MANIFEST_BYTES +
  1024;
const MAX_PREVIEW_MESSAGES = 100;
const MAX_PREVIEW_TEXT_CHARS = 200_000;
const MAX_MESSAGE_TEXT_CHARS = 20_000;

const ShortText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));
const ManifestEntry = Schema.Struct({
  path: ShortText(512),
  mediaType: ShortText(100),
  byteLength: NonNegativeInt,
  sha256: Sha256Digest,
});
const ManifestResource = Schema.Union([
  Schema.TaggedStruct("included", {
    id: ConversationImportResourceId,
    path: ShortText(512),
    name: ShortText(255),
    kind: Schema.Literals(["image", "file"]),
    mediaType: ShortText(100),
    byteLength: NonNegativeInt,
    sha256: Sha256Digest,
  }),
  Schema.TaggedStruct("unavailable", {
    id: ConversationImportResourceId,
    name: ShortText(255),
    reason: Schema.Literals(["missing", "unreadable", "unsupported", "too-large"]),
  }),
]);
const ManifestHeader = Schema.Struct({
  format: Schema.Literal(SCIC_FORMAT),
  formatVersion: ConversationImportFormatVersion,
});
const Manifest = Schema.Struct({
  ...ManifestHeader.fields,
  exporter: Schema.Struct({ name: ShortText(64), version: ShortText(64) }),
  exportId: ConversationExternalExportId,
  exportedAt: IsoDateTime,
  sourceThreadId: ConversationExternalId,
  contentDigest: Sha256Digest,
  entries: Schema.Array(ManifestEntry),
  resources: Schema.Array(ManifestResource),
  warnings: Schema.Array(DocumentWarning),
});
const decodeManifestHeader = Schema.decodeUnknownOption(ManifestHeader);
const decodeManifest = Schema.decodeUnknownOption(Manifest);
const decodeSnapshot = Schema.decodeUnknownOption(ConversationSnapshotV1);

export interface LocalConversationFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
}

export interface LocalConversationPreview {
  readonly title: string;
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  readonly messageCount: number;
  readonly attachmentCount: number;
  readonly truncated: boolean;
  /** Identity of the held descriptor, represented losslessly for a later import recheck. */
  readonly identity: LocalConversationFileIdentity;
}

/** A readable local preview failure. `unsupported-too-large` is intentionally distinct. */
export class LocalConversationPreviewError extends Error {
  readonly reason: "invalid" | "unsupported-too-large" | "file-changed" | "cancelled";
  /** Set only when structural checks passed but the snapshot exceeded the preview cap. */
  readonly identity: LocalConversationFileIdentity | undefined;
  constructor(
    reason: "invalid" | "unsupported-too-large" | "file-changed" | "cancelled",
    message: string,
    identity?: LocalConversationFileIdentity,
  ) {
    super(message);
    this.name = "LocalConversationPreviewError";
    this.reason = reason;
    this.identity = identity;
  }
}

const invalid = (message: string): never => {
  throw new LocalConversationPreviewError("invalid", message);
};
const cancelled = () => new LocalConversationPreviewError("cancelled", "Preview cancelled.");
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw cancelled();
};
const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("The archive contains invalid UTF-8.");
  }
};
const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (cause) {
    if (cause instanceof LocalConversationPreviewError) throw cause;
    return invalid("The archive contains invalid JSON.");
  }
};
const isSafePath = (name: string) =>
  name.length > 0 &&
  name.length <= 512 &&
  !name.startsWith("/") &&
  !name.includes("\\") &&
  !/^[a-zA-Z]:/u.test(name) &&
  // oxlint-disable-next-line no-control-regex -- ZIP paths must exclude control bytes.
  !/[\u0000-\u001f\u007f]/u.test(name) &&
  name.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const attachmentPathDigest = (name: string) => {
  const match = /^attachments\/([0-9a-f]{64})-([\p{L}\p{N}._-]{1,100})$/u.exec(name);
  return match && !match[2]!.startsWith(".") ? `sha256:${match[1]}` : null;
};

const entryLimit = (name: string) => {
  if (name === MIMETYPE) return SCIC_MEDIA_TYPE.length;
  if (name === MANIFEST) return MAX_MANIFEST_BYTES;
  if (name === SNAPSHOT) return MAX_ARCHIVE_SNAPSHOT_BYTES;
  if (name === MARKDOWN) return MAX_MARKDOWN_BYTES;
  return MAX_ENTRY_BYTES;
};

function checkEntries(entries: readonly Yauzl.Entry[]): Map<string, Yauzl.Entry> {
  if (entries.length === 0 || entries.length > MAX_ENTRIES)
    invalid("The archive has an invalid number of entries.");
  const result = new Map<string, Yauzl.Entry>();
  const folded = new Set<string>();
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const name = decodeUtf8(entry.fileNameRaw);
    if (!isSafePath(name)) invalid("The archive contains an unsafe path.");
    if ((index === 0) !== (name === MIMETYPE)) invalid("The first entry must be the mimetype.");
    if (
      index === 0 &&
      (entry.compressionMethod !== 0 ||
        entry.relativeOffsetOfLocalHeader !== 0 ||
        entry.uncompressedSize !== SCIC_MEDIA_TYPE.length)
    )
      invalid("The mimetype must be first and uncompressed.");
    if ((entry.generalPurposeBitFlag & 0x41) !== 0) invalid("Encrypted entries are unsupported.");
    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (
      (entry.externalFileAttributes & 0x10) !== 0 ||
      (entry.versionMadeBy >>> 8 === 3 && unixType !== 0 && unixType !== 0o100000)
    )
      invalid("The archive contains a link, directory, or special entry.");
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      invalid("The archive uses unsupported compression.");
    }
    const key = name.normalize("NFC").toLowerCase();
    if (result.has(name) || folded.has(key)) invalid("The archive contains duplicate paths.");
    result.set(name, entry);
    folded.add(key);
    if (entry.uncompressedSize > entryLimit(name)) invalid("An archive entry is too large.");
    total += entry.uncompressedSize;
    if (total > MAX_UNCOMPRESSED_BYTES) invalid("The archive expands beyond its size limit.");
    if (
      entry.uncompressedSize > 1024 * 1024 &&
      entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 500
    )
      invalid("The archive contains an implausible compression ratio.");
  }
  return result;
}

function checkManifest(manifest: typeof Manifest.Type, archive: ReadonlyMap<string, Yauzl.Entry>) {
  const declared = new Map<string, typeof ManifestEntry.Type>();
  for (const entry of manifest.entries) {
    if (declared.has(entry.path)) invalid("The manifest contains duplicate entries.");
    if (
      entry.path !== SNAPSHOT &&
      entry.path !== MARKDOWN &&
      attachmentPathDigest(entry.path) !== entry.sha256
    ) {
      invalid("The manifest contains an unknown entry.");
    }
    declared.set(entry.path, entry);
  }
  if (!declared.has(SNAPSHOT) || !declared.has(MARKDOWN))
    invalid("The manifest omits a conversation document.");
  for (const [name, entry] of archive) {
    if (name === MIMETYPE || name === MANIFEST) continue;
    const listing = declared.get(name);
    if (!listing || listing.byteLength !== entry.uncompressedSize)
      invalid("The archive disagrees with its manifest.");
  }
  for (const name of declared.keys())
    if (!archive.has(name)) invalid("The manifest lists a missing entry.");
  const resources = new Set<string>();
  const usedPaths = new Set<string>();
  for (const resource of manifest.resources) {
    if (resources.has(resource.id)) invalid("The manifest contains duplicate resources.");
    resources.add(resource.id);
    if (resource._tag !== "included") continue;
    const listing = declared.get(resource.path);
    if (
      !resource.path.startsWith("attachments/") ||
      !listing ||
      listing.sha256 !== resource.sha256 ||
      listing.byteLength !== resource.byteLength ||
      listing.mediaType !== resource.mediaType
    )
      invalid("A resource disagrees with its manifest entry.");
    usedPaths.add(resource.path);
  }
  for (const name of declared.keys()) {
    if (name.startsWith("attachments/") && !usedPaths.has(name))
      invalid("An attachment has no resource.");
  }
  return declared;
}

function checkResources(snapshot: ConversationSnapshot, manifest: typeof Manifest.Type) {
  const resources = new Map(manifest.resources.map((resource) => [resource.id, resource]));
  const attachments = [
    ...snapshot.messages.flatMap((message) => message.attachments),
    ...snapshot.questionAnswers.flatMap((answer) =>
      answer.items.flatMap((item) => item.attachments),
    ),
  ];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const resource = resources.get(attachment.localId);
    if (!resource || resource.name !== attachment.name)
      return invalid("An attachment disagrees with the manifest.");
    if (resource._tag === "included") {
      if (
        !attachment.available ||
        resource.kind !== attachment.kind ||
        resource.mediaType !== attachment.mimeType ||
        resource.byteLength !== attachment.sizeBytes
      ) {
        invalid("An attachment disagrees with the manifest.");
      }
    } else if (attachment.available) invalid("An attachment is marked available without bytes.");
    seen.add(attachment.localId);
  }
  for (const id of resources.keys())
    if (!seen.has(id)) invalid("The manifest has an unreferenced resource.");
  return attachments.length;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    );
  }
  return left === right;
}

function contentDigest(snapshot: ConversationSnapshot): string {
  const { captured: _captured, contentDigest: _digest, ...content } = snapshot;
  const hash = NodeCrypto.createHash("sha256");
  const write = (value: unknown): void => {
    if (Array.isArray(value)) {
      hash.update("[");
      value.forEach((item, index) => {
        if (index) hash.update(",");
        write(item);
      });
      hash.update("]");
    } else if (value !== null && typeof value === "object") {
      hash.update("{");
      Object.keys(value)
        .sort()
        .forEach((key, index) => {
          if (index) hash.update(",");
          hash.update(`${JSON.stringify(key)}:`);
          write((value as Record<string, unknown>)[key]);
        });
      hash.update("}");
    } else hash.update(JSON.stringify(value));
  };
  write(content);
  return `sha256:${hash.digest("hex")}`;
}

function previewMessages(snapshot: ConversationSnapshot) {
  const messages: { role: string; text: string }[] = [];
  let remaining = MAX_PREVIEW_TEXT_CHARS;
  let truncated = snapshot.messages.length > MAX_PREVIEW_MESSAGES;
  for (const message of snapshot.messages.slice(0, MAX_PREVIEW_MESSAGES)) {
    const placeholders = message.attachments
      .map(
        (attachment) =>
          `[Attachment: ${attachment.name}${attachment.available ? "" : " (unavailable)"}]`,
      )
      .join("\n");
    const full = placeholders ? `${message.text}\n${placeholders}` : message.text;
    const capacity = Math.min(MAX_MESSAGE_TEXT_CHARS, remaining);
    const suffix = placeholders ? `\n${placeholders}` : "";
    const text =
      suffix.length >= capacity
        ? suffix.slice(0, capacity)
        : `${message.text.slice(0, capacity - suffix.length)}${suffix}`;
    messages.push({ role: message.role, text });
    if (text.length < full.length) truncated = true;
    remaining -= text.length;
    if (remaining === 0) {
      truncated = true;
      break;
    }
  }
  return { messages, truncated };
}

async function openZip(fd: number, signal?: AbortSignal): Promise<Yauzl.ZipFile> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    Yauzl.fromFd(
      fd,
      {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: true,
        decodeStrings: false,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("Unreadable ZIP."));
        else resolve(zip);
      },
    );
  });
}

function openDescriptor(path: string, flags: number): Promise<number> {
  return new Promise((resolve, reject) => {
    NodeFS.open(path, flags, (error, fd) => {
      if (error) reject(error);
      else resolve(fd);
    });
  });
}

function descriptorStat(fd: number): Promise<NodeFS.BigIntStats> {
  return new Promise((resolve, reject) => {
    NodeFS.fstat(fd, { bigint: true }, (error, stat) => {
      if (error) reject(error);
      else resolve(stat);
    });
  });
}

function closeDescriptor(fd: number): Promise<void> {
  return new Promise((resolve) => {
    NodeFS.close(fd, () => resolve());
  });
}

function closeZip(zip: Yauzl.ZipFile): Promise<void> {
  return new Promise((resolve) => {
    if (!zip.isOpen) return resolve();
    // fd-slicer owns the descriptor after fromFd succeeds; it closes asynchronously.
    // Keep an error listener until that close completes so no close failure escapes.
    zip.once("close", resolve);
    zip.once("error", resolve);
    zip.close();
  });
}

async function listEntries(zip: Yauzl.ZipFile, signal?: AbortSignal): Promise<Yauzl.Entry[]> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const entries: Yauzl.Entry[] = [];
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) {
        cleanup();
        reject(new LocalConversationPreviewError("invalid", "The archive has too many entries."));
      } else zip.readEntry();
    };
    const onEnd = () => {
      cleanup();
      resolve(entries);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(cancelled());
    };
    zip.on("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else zip.readEntry();
  });
}

async function readEntry(
  zip: Yauzl.ZipFile,
  entry: Yauzl.Entry,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  checkAbort(signal);
  if (entry.uncompressedSize > limit) {
    throw new LocalConversationPreviewError(
      "unsupported-too-large",
      "This conversation is too large for a local preview. Import it to read it.",
    );
  }
  const stream = await new Promise<NodeStream.Readable>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    zip.openReadStream(entry, (error, readable) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        readable?.destroy();
        reject(cancelled());
      } else if (error || !readable) reject(error ?? new Error("Unreadable ZIP entry."));
      else resolve(readable);
    });
  });
  const result = Buffer.allocUnsafe(entry.uncompressedSize);
  let length = 0;
  let crc = 0;
  const abort = () => stream.destroy(cancelled());
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      length += chunk.length;
      if (length > entry.uncompressedSize || length > limit)
        invalid("A ZIP entry exceeds its declared length.");
      result.set(chunk, length - chunk.length);
      crc = NodeZlib.crc32(chunk, crc);
    }
    if (length !== entry.uncompressedSize || crc >>> 0 !== entry.crc32 >>> 0)
      invalid("A ZIP entry failed its checksum.");
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}

/**
 * Preview only the authoritative snapshot. ZIP structure, manifest metadata,
 * and snapshot digests are checked against the server's limits. Markdown and
 * attachment bytes remain unopened and unverified until import.
 */
export async function readLocalConversationPreview(
  path: string,
  signal?: AbortSignal,
): Promise<LocalConversationPreview> {
  checkAbort(signal);
  let fd: number | undefined;
  let zip: Yauzl.ZipFile | undefined;
  try {
    const before = await NodeFS.promises.lstat(path, { bigint: true });
    checkAbort(signal);
    if (!before.isFile()) invalid("Select a regular .scic file.");
    const flags =
      NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NONBLOCK ?? 0) |
      (NodeFS.constants.O_NOFOLLOW ?? 0);
    fd = await openDescriptor(path, flags);
    const stat = await descriptorStat(fd);
    checkAbort(signal);
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== before.size ||
      stat.mtimeNs !== before.mtimeNs
    ) {
      throw new LocalConversationPreviewError(
        "file-changed",
        "The selected file changed before preview opened it.",
      );
    }
    if (stat.size > BigInt(SCIENT_CONVERSATION_IMPORT_MAX_PACKAGE_BYTES))
      invalid("The selected archive is too large.");
    const identity = {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
    };
    zip = await openZip(fd, signal);
    checkAbort(signal);
    if (zip.entryCount > MAX_ENTRIES) invalid("The archive has too many entries.");
    const archive = checkEntries(await listEntries(zip, signal));
    const mimetypeEntry = archive.get(MIMETYPE) ?? invalid("The archive has no mimetype.");
    const mimetype = await readEntry(zip, mimetypeEntry, SCIC_MEDIA_TYPE.length, signal);
    if (decodeUtf8(mimetype) !== SCIC_MEDIA_TYPE)
      invalid("This is not a Scient conversation file.");
    const manifestEntry = archive.get(MANIFEST) ?? invalid("The archive has no manifest.");
    const manifestJson = parseJson(await readEntry(zip, manifestEntry, MAX_MANIFEST_BYTES, signal));
    const headerResult = decodeManifestHeader(manifestJson);
    const header = Option.isSome(headerResult)
      ? headerResult.value
      : invalid("The manifest header is malformed.");
    if (header.formatVersion.major !== SCIC_FORMAT_MAJOR_VERSION)
      invalid("This conversation format version is unsupported.");
    const manifestResult = decodeManifest(manifestJson);
    const manifest = Option.isSome(manifestResult)
      ? manifestResult.value
      : invalid("The manifest is malformed.");
    const declared = checkManifest(manifest, archive);
    const snapshotEntry = archive.get(SNAPSHOT)!;
    if (snapshotEntry.uncompressedSize > MAX_PREVIEW_SNAPSHOT_BYTES) {
      const after = await descriptorStat(fd);
      checkAbort(signal);
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeNs !== stat.mtimeNs
      ) {
        throw new LocalConversationPreviewError(
          "file-changed",
          "The selected file changed during preview.",
        );
      }
      throw new LocalConversationPreviewError(
        "unsupported-too-large",
        "This conversation is too large for a local preview. Import it to read it.",
        identity,
      );
    }
    const bytes = await readEntry(zip, snapshotEntry, MAX_PREVIEW_SNAPSHOT_BYTES, signal);
    const digest = `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
    if (declared.get(SNAPSHOT)!.sha256 !== digest)
      invalid("The snapshot does not match the manifest.");
    const raw = parseJson(bytes);
    const snapshotResult = decodeSnapshot(raw);
    const snapshot = Option.isSome(snapshotResult)
      ? snapshotResult.value
      : invalid("The conversation snapshot is malformed.");
    if (!sameJson(raw, snapshot)) invalid("The snapshot contains unsupported fields.");
    if (
      contentDigest(snapshot) !== snapshot.contentDigest ||
      manifest.contentDigest !== snapshot.contentDigest ||
      manifest.sourceThreadId !== snapshot.captured.threadId
    )
      invalid("The snapshot content digest does not match.");
    const attachmentCount = checkResources(snapshot, manifest);
    const preview = previewMessages(snapshot);
    const after = await descriptorStat(fd);
    checkAbort(signal);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs
    ) {
      throw new LocalConversationPreviewError(
        "file-changed",
        "The selected file changed during preview.",
      );
    }
    return {
      title: snapshot.thread.title,
      ...preview,
      messageCount: snapshot.messages.length,
      attachmentCount,
      identity,
    };
  } catch (cause) {
    if (signal?.aborted) throw cancelled();
    if (cause instanceof LocalConversationPreviewError) throw cause;
    throw new LocalConversationPreviewError(
      "invalid",
      "The selected .scic file could not be read.",
    );
  } finally {
    if (zip) await closeZip(zip);
    else if (fd !== undefined) await closeDescriptor(fd);
  }
}
