// @effect-diagnostics nodeBuiltinImport:off -- the reader streams ZIP members through Node streams and hashes.
/**
 * Reads and validates an untrusted portable conversation file, staging its
 * attachments, and either returns a `ValidatedConversationImport` or fails
 * closed with a typed rejection. Nothing outside the given staging directory
 * is written, and nothing is written there before the archive's structure and
 * manifest have been checked.
 *
 * yauzl reads the archive with `lazyEntries`, `validateEntrySizes`, and
 * `strictFileNames`, as elsewhere in Scient. Entry names are read raw
 * (`decodeStrings: false`) and validated here, strictly, so an unsafe name is
 * reported as such instead of as an unreadable archive. Checks, in order:
 *
 * 1. Structure, from the central directory alone: entry count; a `mimetype`
 *    first entry, stored, at offset 0; safe relative paths; regular files only;
 *    no encryption; stored or deflated only; no duplicate or case-colliding
 *    paths; per-entry, total, and compression-ratio limits.
 * 2. `mimetype` content, then the manifest: format, supported major version,
 *    schema, and an entry list that matches the archive exactly.
 * 3. Every declared entry's size, SHA-256, and CRC-32 while it is read; the
 *    snapshot's schema, canonical form, and content digest; resources against
 *    the snapshot; attachment types and the chat attachment media policy.
 * 4. The whole result against `ValidatedConversationImport`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";
import { waitForWritableDrain } from "./waitForWritableDrain.ts";

import {
  ConversationImportRejectionReason,
  ConversationSnapshotV1,
  SCIC_FORMAT_MAJOR_VERSION,
  SCIC_FORMAT_MINOR_VERSION,
  SCIC_MEDIA_TYPE,
  type ConversationAttachment,
  type ConversationImportId,
  type ConversationImportWarning,
  type Sha256Digest,
} from "@t3tools/contracts";
import { canonicalSnapshotContent } from "@scientfactory/conversation";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Yauzl from "yauzl";

import {
  conversationContentDigest,
  conversationImportOmissions,
  ValidatedConversationImport,
  type StagedConversationImportAttachment,
} from "../conversationImport/ConversationImporter.ts";
import {
  SCIC_ATTACHMENTS_DIRECTORY,
  SCIC_COMPRESSION_RATIO_FLOOR_BYTES,
  SCIC_MANIFEST_ENTRY,
  SCIC_MARKDOWN_ENTRY,
  SCIC_MAX_ATTACHMENT_BYTES,
  SCIC_MAX_COMPRESSION_RATIO,
  SCIC_MAX_ENTRIES,
  SCIC_MAX_MANIFEST_BYTES,
  SCIC_MAX_MARKDOWN_BYTES,
  SCIC_MAX_SNAPSHOT_BYTES,
  SCIC_MAX_UNCOMPRESSED_BYTES,
  SCIC_MIMETYPE_ENTRY,
  SCIC_SNAPSHOT_ENTRY,
  SNIFF_BYTES,
  ScicManifest,
  ScicManifestHeader,
  contradictsDeclaredType,
  scicAttachmentPathDigest,
  withinAttachmentPolicy,
  type ScicManifestEntry,
} from "./scicFormat.ts";

export class ScicRejection extends Schema.TaggedError<ScicRejection>()("ScicRejection", {
  reason: ConversationImportRejectionReason,
  /** The offending entry path, bounded, when one entry is at fault. */
  entry: Schema.NullOr(Schema.String),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const isScicRejection = Schema.is(ScicRejection);

export class ScicReadError extends Schema.TaggedError<ScicReadError>()("ScicReadError", {
  detail: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface ScicReadInput {
  readonly importId: ConversationImportId;
  readonly packagePath: string;
  /** SHA-256 and size of the package file as received. */
  readonly packageSha256: Sha256Digest;
  readonly packageBytes: number;
  /** An existing, empty directory; staged attachments are written here, named by their SHA-256. */
  readonly attachmentsDirectory: string;
  /** Admission reservation from this archive's central directory. */
  readonly maxExpandedBytes?: number;
}

/** Where a staged attachment with this digest lives inside the staging directory. */
export function stagedAttachmentFile(attachmentsDirectory: string, sha256: Sha256Digest): string {
  return NodePath.join(attachmentsDirectory, sha256.slice("sha256:".length));
}

const MAX_REPORTED_ENTRY_CHARS = 512;

function reject(
  reason: ConversationImportRejectionReason,
  detail: string,
  entry: string | null = null,
): never {
  throw new ScicRejection({
    reason,
    entry: entry === null ? null : entry.slice(0, MAX_REPORTED_ENTRY_CHARS),
    detail,
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** A relative POSIX path of non-empty, non-dot segments without control characters. */
function isSafeEntryPath(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false;
  if (name.startsWith("/") || name.includes("\\") || /^[a-zA-Z]:/.test(name)) return false;
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused.
  if (/[\u0000-\u001f\u007f]/u.test(name)) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const MSDOS_DIRECTORY = 0x10;
const HOST_UNIX = 3;

function isRegularFile(entry: Yauzl.Entry): boolean {
  if ((entry.externalFileAttributes & MSDOS_DIRECTORY) !== 0) return false;
  if (entry.versionMadeBy >>> 8 === HOST_UNIX) {
    const type = (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
    return type === 0 || type === UNIX_REGULAR_FILE;
  }
  return true;
}

function entryLimit(name: string): number {
  if (name === SCIC_MIMETYPE_ENTRY) return SCIC_MEDIA_TYPE.length;
  if (name === SCIC_MANIFEST_ENTRY) return SCIC_MAX_MANIFEST_BYTES;
  if (name === SCIC_SNAPSHOT_ENTRY) return SCIC_MAX_SNAPSHOT_BYTES;
  if (name === SCIC_MARKDOWN_ENTRY) return SCIC_MAX_MARKDOWN_BYTES;
  return SCIC_MAX_ATTACHMENT_BYTES;
}

interface ArchiveEntry {
  readonly name: string;
  readonly entry: Yauzl.Entry;
}

function openZip(path: string): Promise<Yauzl.ZipFile> {
  return new Promise((resolve, failure) => {
    Yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: true,
        decodeStrings: false,
      },
      (cause, zip) => {
        if (cause || !zip) failure(cause ?? new Error("The archive could not be opened."));
        else resolve(zip);
      },
    );
  });
}

function listEntries(zip: Yauzl.ZipFile): Promise<ReadonlyArray<Yauzl.Entry>> {
  return new Promise((resolve, failure) => {
    const entries: Yauzl.Entry[] = [];
    const cleanup = () => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    };
    const onEnd = () => {
      cleanup();
      resolve(entries);
    };
    const onError = (cause: unknown) => {
      cleanup();
      failure(cause);
    };
    zip.on("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function openEntry(zip: Yauzl.ZipFile, entry: Yauzl.Entry): Promise<NodeStream.Readable> {
  return new Promise((resolve, failure) => {
    zip.openReadStream(entry, (cause, readable) => {
      if (cause || !readable) failure(cause ?? new Error("The entry could not be read."));
      else resolve(readable);
    });
  });
}

interface ReadEntryResult {
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly head: Uint8Array;
  readonly bytes: Uint8Array | null;
}

/**
 * Streams one entry, counting, hashing, and checking its CRC-32, and either
 * keeps its bytes or writes them to `target` through a temporary file.
 */
async function readEntry(
  zip: Yauzl.ZipFile,
  archiveEntry: ArchiveEntry,
  output: { readonly keep: true } | { readonly keep: false; readonly target: string | null },
  signal: AbortSignal,
): Promise<ReadEntryResult> {
  const { entry, name } = archiveEntry;
  let readable: NodeStream.Readable;
  try {
    readable = await openEntry(zip, entry);
  } catch {
    return reject("corrupt-archive", "An entry could not be read.", name);
  }
  const hash = NodeCrypto.createHash("sha256");
  const chunks: Uint8Array[] = [];
  const head = new Uint8Array(SNIFF_BYTES);
  let headLength = 0;
  let byteLength = 0;
  let crc = 0;
  const temporary =
    !output.keep && output.target !== null
      ? `${output.target}.${NodeCrypto.randomUUID()}.part`
      : null;
  const sink = temporary === null ? null : NodeFS.createWriteStream(temporary, { flags: "wx" });
  let sinkError: Error | null = null;
  sink?.on("error", (error: Error) => {
    sinkError = error;
    readable.destroy(error);
  });
  const sinkFinished = sink === null ? null : NodeStreamPromises.finished(sink);
  // The stream can fail while the readable is still being consumed.
  void sinkFinished?.catch(() => {});
  const sinkClosed =
    sink === null
      ? null
      : new Promise<void>((resolve) => {
          sink.once("close", resolve);
        });
  const abort = () => readable.destroy(new Error("Reading was interrupted."));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    try {
      for await (const chunk of readable as AsyncIterable<Buffer>) {
        byteLength += chunk.byteLength;
        if (byteLength > entry.uncompressedSize) {
          return reject("corrupt-archive", "An entry is longer than it declares.", name);
        }
        hash.update(chunk);
        crc = NodeZlib.crc32(chunk, crc);
        if (headLength < SNIFF_BYTES) {
          const take = chunk.subarray(0, SNIFF_BYTES - headLength);
          head.set(take, headLength);
          headLength += take.byteLength;
        }
        if (output.keep) chunks.push(chunk);
        if (sink !== null && !sink.write(chunk)) {
          if (sinkError !== null) throw sinkError;
          await waitForWritableDrain(sink);
        }
      }
    } catch (cause) {
      if (sinkError !== null) throw sinkError;
      if (isScicRejection(cause)) throw cause;
      if (signal.aborted) throw cause;
      return reject("corrupt-archive", "An entry is damaged.", name);
    }
    if (byteLength !== entry.uncompressedSize || crc >>> 0 !== entry.crc32 >>> 0) {
      return reject("corrupt-archive", "An entry does not match its checksum.", name);
    }
    if (sink !== null && temporary !== null && !output.keep && output.target !== null) {
      if (sinkError !== null) throw sinkError;
      sink.end();
      await sinkFinished;
      await NodeFS.promises.rename(temporary, output.target);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    readable.destroy();
    if (sink !== null && !sink.closed) sink.destroy();
    if (sinkClosed !== null) await sinkClosed;
    if (temporary !== null) await NodeFS.promises.rm(temporary, { force: true });
  }
  return {
    sha256: `sha256:${hash.digest("hex")}`,
    byteLength,
    head: head.subarray(0, headLength),
    bytes: output.keep ? Buffer.concat(chunks) : null,
  };
}

function parseJson(bytes: Uint8Array): unknown {
  const text = decodeUtf8(bytes);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const decodeManifestHeader = Schema.decodeUnknownOption(ScicManifestHeader);
const decodeManifest = Schema.decodeUnknownOption(ScicManifest);
const decodeSnapshot = Schema.decodeUnknownOption(ConversationSnapshotV1);
const encodeSnapshot = Schema.encodeSync(ConversationSnapshotV1);
const decodeValidated = Schema.decodeUnknownExit(ValidatedConversationImport);

/** Checks the archive's structure from its central directory, before reading any content. */
function checkStructure(entries: ReadonlyArray<Yauzl.Entry>): ReadonlyArray<ArchiveEntry> {
  if (entries.length === 0) reject("mimetype-invalid", "The file has no mimetype entry.");
  if (entries.length > SCIC_MAX_ENTRIES) {
    reject("too-many-entries", `The file has more than ${SCIC_MAX_ENTRIES} entries.`);
  }
  const exact = new Set<string>();
  const folded = new Set<string>();
  const checked: ArchiveEntry[] = [];
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const name = decodeUtf8(entry.fileNameRaw);
    if (name === null || !isSafeEntryPath(name)) {
      reject("unsafe-path", "The file contains an unsafe path.", name ?? "(undecodable name)");
    }
    if ((index === 0) !== (name === SCIC_MIMETYPE_ENTRY)) {
      reject("mimetype-invalid", "The first entry must be the mimetype entry.", name);
    }
    if (
      index === 0 &&
      (entry.compressionMethod !== 0 ||
        entry.relativeOffsetOfLocalHeader !== 0 ||
        entry.uncompressedSize !== SCIC_MEDIA_TYPE.length)
    ) {
      reject("mimetype-invalid", "The mimetype entry must be stored uncompressed first.", name);
    }
    if ((entry.generalPurposeBitFlag & 0x41) !== 0) {
      reject("encrypted-entry", "The file contains an encrypted entry.", name);
    }
    if (!isRegularFile(entry)) {
      reject("special-entry", "The file contains a link, folder, or special file.", name);
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      reject("corrupt-archive", "The file uses an unsupported compression method.", name);
    }
    if (exact.has(name)) reject("duplicate-path", "The file contains a path twice.", name);
    const key = name.normalize("NFC").toLowerCase();
    if (folded.has(key)) {
      reject("duplicate-path", "The file contains paths that differ only in case.", name);
    }
    exact.add(name);
    folded.add(key);
    if (entry.uncompressedSize > entryLimit(name)) {
      reject("entry-too-large", "An entry is larger than Scient allows.", name);
    }
    total += entry.uncompressedSize;
    checked.push({ name, entry });
  }
  if (total > SCIC_MAX_UNCOMPRESSED_BYTES) {
    reject("package-too-large", "The file expands beyond what Scient allows.");
  }
  for (const { name, entry } of checked) {
    if (
      entry.uncompressedSize > SCIC_COMPRESSION_RATIO_FLOOR_BYTES &&
      entry.uncompressedSize / Math.max(entry.compressedSize, 1) > SCIC_MAX_COMPRESSION_RATIO
    ) {
      reject("compression-ratio", "An entry is compressed beyond a plausible ratio.", name);
    }
  }
  return checked;
}

function checkDeclaredEntries(
  manifest: ScicManifest,
  archive: ReadonlyMap<string, ArchiveEntry>,
): ReadonlyMap<string, ScicManifestEntry> {
  const declared = new Map<string, ScicManifestEntry>();
  for (const entry of manifest.entries) {
    if (declared.has(entry.path)) {
      reject("manifest-invalid", "The manifest lists an entry twice.", entry.path);
    }
    const isDocument = entry.path === SCIC_SNAPSHOT_ENTRY || entry.path === SCIC_MARKDOWN_ENTRY;
    if (!isDocument && scicAttachmentPathDigest(entry.path) !== entry.sha256) {
      reject("manifest-invalid", "The manifest lists an entry Scient does not know.", entry.path);
    }
    declared.set(entry.path, entry);
  }
  for (const required of [SCIC_SNAPSHOT_ENTRY, SCIC_MARKDOWN_ENTRY]) {
    if (!declared.has(required)) {
      reject("manifest-invalid", "The manifest does not list the conversation.", required);
    }
  }
  for (const name of archive.keys()) {
    if (name === SCIC_MIMETYPE_ENTRY || name === SCIC_MANIFEST_ENTRY) continue;
    if (!declared.has(name))
      reject("undeclared-entry", "The file contains an undeclared entry.", name);
  }
  for (const [path, entry] of declared) {
    const present = archive.get(path);
    if (!present) reject("manifest-mismatch", "A declared entry is missing.", path);
    if (present.entry.uncompressedSize !== entry.byteLength) {
      reject("manifest-mismatch", "An entry's size differs from the manifest.", path);
    }
  }
  return declared;
}

function checkEntryDigest(read: ReadEntryResult, declared: ScicManifestEntry): void {
  if (read.byteLength !== declared.byteLength || read.sha256 !== declared.sha256) {
    reject("manifest-mismatch", "An entry's content differs from the manifest.", declared.path);
  }
}

function snapshotAttachmentOccurrences(
  snapshot: ConversationSnapshotV1,
): ReadonlyArray<ConversationAttachment> {
  return [
    ...snapshot.messages.flatMap((message) => message.attachments),
    ...snapshot.questionAnswers.flatMap((answer) =>
      answer.items.flatMap((item) => item.attachments),
    ),
  ];
}

async function readPackage(
  input: ScicReadInput,
  signal: AbortSignal,
): Promise<ValidatedConversationImport> {
  let zip: Yauzl.ZipFile;
  try {
    zip = await openZip(input.packagePath);
  } catch {
    return reject("corrupt-archive", "The file is not a readable ZIP archive.");
  }
  try {
    // yauzl reads the (possibly ZIP64) central-directory count when opening.
    // It emits at most that many entries, so fail before retaining any of them.
    if (zip.entryCount > SCIC_MAX_ENTRIES) {
      reject("too-many-entries", `The file has more than ${SCIC_MAX_ENTRIES} entries.`);
    }
    let listed: ReadonlyArray<Yauzl.Entry>;
    try {
      listed = await listEntries(zip);
    } catch {
      return reject("corrupt-archive", "The file's directory is damaged.");
    }
    const checked = checkStructure(listed);
    if (
      input.maxExpandedBytes !== undefined &&
      checked.reduce((total, item) => total + item.entry.uncompressedSize, 0) >
        input.maxExpandedBytes
    ) {
      return reject("package-too-large", "The archive expanded beyond its staging reservation.");
    }
    const archive = new Map(checked.map((entry) => [entry.name, entry]));

    const mimetype = await readEntry(
      zip,
      archive.get(SCIC_MIMETYPE_ENTRY)!,
      { keep: true },
      signal,
    );
    if (decodeUtf8(mimetype.bytes!) !== SCIC_MEDIA_TYPE) {
      reject(
        "mimetype-invalid",
        "The file is not a Scient conversation file.",
        SCIC_MIMETYPE_ENTRY,
      );
    }

    const manifestEntry = archive.get(SCIC_MANIFEST_ENTRY);
    if (!manifestEntry) return reject("manifest-invalid", "The file has no manifest.");
    const manifestRead = await readEntry(zip, manifestEntry, { keep: true }, signal);
    const manifestJson = parseJson(manifestRead.bytes!);
    const header = decodeManifestHeader(manifestJson);
    if (Option.isNone(header)) {
      return reject(
        "manifest-invalid",
        "The manifest is not a Scient manifest.",
        SCIC_MANIFEST_ENTRY,
      );
    }
    const { formatVersion } = header.value;
    if (formatVersion.major !== SCIC_FORMAT_MAJOR_VERSION) {
      return reject(
        "unsupported-version",
        `The file uses format version ${formatVersion.major}, which this Scient cannot read.`,
      );
    }
    const newerMinor = formatVersion.minor > SCIC_FORMAT_MINOR_VERSION;
    const decodedManifest = decodeManifest(manifestJson);
    if (Option.isNone(decodedManifest)) {
      return reject("manifest-invalid", "The manifest is malformed.", SCIC_MANIFEST_ENTRY);
    }
    const manifest = decodedManifest.value;
    const declared = checkDeclaredEntries(manifest, archive);

    // The snapshot: schema, canonical form, digest.
    const snapshotRead = await readEntry(
      zip,
      archive.get(SCIC_SNAPSHOT_ENTRY)!,
      { keep: true },
      signal,
    );
    checkEntryDigest(snapshotRead, declared.get(SCIC_SNAPSHOT_ENTRY)!);
    const snapshotJson = parseJson(snapshotRead.bytes!);
    const decodedSnapshot = decodeSnapshot(snapshotJson);
    if (Option.isNone(decodedSnapshot)) {
      return reject(
        "snapshot-invalid",
        "The conversation is not a valid snapshot.",
        SCIC_SNAPSHOT_ENTRY,
      );
    }
    const snapshot = decodedSnapshot.value;
    const { contentDigest: _rawDigest, ...rawContent } = snapshotJson as Record<string, unknown>;
    const { contentDigest: _decodedDigest, ...decodedContent } = snapshot;
    if (
      canonicalSnapshotContent(rawContent as typeof decodedContent) !==
      canonicalSnapshotContent(decodedContent)
    ) {
      return newerMinor
        ? reject(
            "unsupported-version",
            "The conversation uses content this Scient does not know. Update Scient to import it.",
            SCIC_SNAPSHOT_ENTRY,
          )
        : reject(
            "snapshot-invalid",
            "The conversation contains fields Scient does not know.",
            SCIC_SNAPSHOT_ENTRY,
          );
    }
    if (conversationContentDigest(snapshot) !== snapshot.contentDigest) {
      return reject(
        "snapshot-invalid",
        "The conversation does not match its content digest.",
        SCIC_SNAPSHOT_ENTRY,
      );
    }
    if (
      manifest.contentDigest !== snapshot.contentDigest ||
      manifest.sourceThreadId !== snapshot.captured.threadId
    ) {
      return reject(
        "snapshot-invalid",
        "The conversation does not match its manifest.",
        SCIC_SNAPSHOT_ENTRY,
      );
    }

    const markdownRead = await readEntry(
      zip,
      archive.get(SCIC_MARKDOWN_ENTRY)!,
      { keep: false, target: null },
      signal,
    );
    checkEntryDigest(markdownRead, declared.get(SCIC_MARKDOWN_ENTRY)!);

    // Resources against the manifest's entries and the snapshot's attachments.
    const resources = new Map(manifest.resources.map((resource) => [resource.id, resource]));
    if (resources.size !== manifest.resources.length) {
      return reject("manifest-invalid", "The manifest lists a resource twice.");
    }
    const usedPaths = new Set<string>();
    for (const resource of manifest.resources) {
      if (resource._tag !== "included") continue;
      const entry = declared.get(resource.path);
      if (
        !entry ||
        !resource.path.startsWith(SCIC_ATTACHMENTS_DIRECTORY) ||
        entry.sha256 !== resource.sha256 ||
        entry.byteLength !== resource.byteLength ||
        entry.mediaType !== resource.mediaType
      ) {
        return reject("manifest-invalid", "A resource does not match its entry.", resource.path);
      }
      usedPaths.add(resource.path);
    }
    for (const path of declared.keys()) {
      if (path.startsWith(SCIC_ATTACHMENTS_DIRECTORY) && !usedPaths.has(path)) {
        return reject("manifest-invalid", "An attachment entry belongs to no resource.", path);
      }
    }
    const referenced = new Set<string>();
    const pastedText = new Map<string, boolean>();
    for (const attachment of snapshotAttachmentOccurrences(snapshot)) {
      const resource = resources.get(attachment.localId);
      if (
        !resource ||
        (resource._tag === "included") !== attachment.available ||
        resource.name !== attachment.name ||
        (resource._tag === "included" &&
          (resource.kind !== attachment.kind ||
            resource.mediaType !== attachment.mimeType ||
            resource.byteLength !== attachment.sizeBytes))
      ) {
        return reject(
          "snapshot-invalid",
          "An attachment in the conversation does not match the manifest.",
          SCIC_SNAPSHOT_ENTRY,
        );
      }
      referenced.add(resource.id);
      if (resource._tag === "included") pastedText.set(resource.id, attachment.pastedText);
    }
    if (referenced.size !== resources.size) {
      return reject(
        "manifest-invalid",
        "The manifest lists a resource the conversation does not use.",
      );
    }

    // Attachments: policy first, then bytes, staged by digest.
    const staged: StagedConversationImportAttachment[] = [];
    const stagedDigests = new Set<string>();
    for (const resource of manifest.resources) {
      if (resource._tag !== "included") continue;
      if (
        !withinAttachmentPolicy({
          kind: resource.kind,
          mediaType: resource.mediaType,
          byteLength: resource.byteLength,
        })
      ) {
        return reject(
          "attachment-policy",
          "An attachment is not a type or size Scient accepts.",
          resource.path,
        );
      }
      if (!stagedDigests.has(resource.sha256)) {
        const read = await readEntry(
          zip,
          archive.get(resource.path)!,
          {
            keep: false,
            target: stagedAttachmentFile(input.attachmentsDirectory, resource.sha256),
          },
          signal,
        );
        checkEntryDigest(read, declared.get(resource.path)!);
        if (contradictsDeclaredType(resource.mediaType, read.head)) {
          return reject(
            "attachment-type-mismatch",
            "An attachment's content contradicts its declared type.",
            resource.path,
          );
        }
        stagedDigests.add(resource.sha256);
      }
      staged.push({
        resourceId: resource.id,
        kind: resource.kind,
        name: resource.name,
        mediaType: resource.mediaType,
        byteLength: resource.byteLength,
        sha256: resource.sha256,
        pastedText: pastedText.get(resource.id) ?? false,
      } as StagedConversationImportAttachment);
    }

    const warnings: ConversationImportWarning[] = [
      ...manifest.warnings.map((warning) => ({ _tag: "export-warning" as const, warning })),
      ...(newerMinor ? [{ _tag: "newer-minor-version" as const, formatVersion }] : []),
    ];
    const validated = decodeValidated({
      importId: input.importId,
      package: {
        format: manifest.format,
        formatVersion,
        exporter: manifest.exporter,
        exportId: manifest.exportId,
        exportedAt: manifest.exportedAt,
        sourceThreadId: manifest.sourceThreadId,
        contentDigest: manifest.contentDigest,
        packageSha256: input.packageSha256,
        packageBytes: input.packageBytes,
      },
      snapshot: encodeSnapshot(snapshot),
      attachments: staged,
      omissions: conversationImportOmissions(snapshot),
      warnings,
    });
    if (validated._tag === "Failure") {
      return reject(
        "snapshot-invalid",
        "The conversation's records are inconsistent.",
        SCIC_SNAPSHOT_ENTRY,
      );
    }
    return validated.value;
  } finally {
    zip.close();
  }
}

/**
 * Validates the package at `packagePath` and stages its attachments into
 * `attachmentsDirectory`. On failure the directory may hold partial output;
 * the caller removes it with the rest of the staging area.
 */
const readFailure = (cause: unknown) =>
  isScicRejection(cause)
    ? cause
    : new ScicReadError({ detail: "The file could not be read.", cause });

/** Central-directory expansion size, checked before staging writes a single member. */
export const inspectScicExpandedBytes = (
  packagePath: string,
): Effect.Effect<number, ScicRejection | ScicReadError> =>
  Effect.tryPromise({
    try: async () => {
      let zip: Yauzl.ZipFile;
      try {
        zip = await openZip(packagePath);
      } catch {
        return reject("corrupt-archive", "The file is not a readable ZIP archive.");
      }
      try {
        if (zip.entryCount > SCIC_MAX_ENTRIES) {
          reject("too-many-entries", `The file has more than ${SCIC_MAX_ENTRIES} entries.`);
        }
        let listed: ReadonlyArray<Yauzl.Entry>;
        try {
          listed = await listEntries(zip);
        } catch {
          return reject("corrupt-archive", "The file's directory is damaged.");
        }
        const checked = checkStructure(listed);
        return checked.reduce((total, item) => total + item.entry.uncompressedSize, 0);
      } finally {
        zip.close();
      }
    },
    catch: readFailure,
  });

export const readScicPackage = (
  input: ScicReadInput,
): Effect.Effect<ValidatedConversationImport, ScicRejection | ScicReadError> =>
  Effect.gen(function* () {
    let active: Promise<ValidatedConversationImport> | null = null;
    return yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.tryPromise({
          try: (signal) => {
            active = readPackage(input, signal);
            return active;
          },
          catch: readFailure,
        }),
      () =>
        Effect.promise(
          () =>
            active?.then(
              () => {},
              () => {},
            ) ?? Promise.resolve(),
        ),
    );
  });
