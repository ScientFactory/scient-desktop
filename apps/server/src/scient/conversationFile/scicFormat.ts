/**
 * The portable conversation file (`.scic`), shared by its writer and reader.
 *
 * A `.scic` is a ZIP whose first entry, `mimetype`, is stored uncompressed and
 * holds exactly `SCIC_MEDIA_TYPE`, followed by:
 *
 *   manifest.json       ScicManifest: format, version, exporter, export ID and
 *                       time, source thread, content digest, the entry list
 *                       (path, media type, size, SHA-256), included and
 *                       unavailable resources, and export warnings
 *   conversation.json   ConversationSnapshotV1 — the only import authority
 *   conversation.md     the readable copy (Scient conversation Markdown v1)
 *   attachments/<sha256>-<safe-name>
 *
 * Every entry except `mimetype` and `manifest.json` is declared in the
 * manifest; nothing else may be present. See
 * docs/internals/scient-conversation-export.md.
 */
import {
  ConversationExternalExportId,
  ConversationExternalId,
  ConversationImportFormatVersion,
  ConversationImportResourceId,
  DocumentWarning,
  IsoDateTime,
  NonNegativeInt,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  SCIC_FORMAT,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  Sha256Digest,
  TrimmedNonEmptyString,
  type ConversationAttachmentKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SCIC_MIMETYPE_ENTRY = "mimetype";
export const SCIC_MANIFEST_ENTRY = "manifest.json";
export const SCIC_SNAPSHOT_ENTRY = "conversation.json";
export const SCIC_MARKDOWN_ENTRY = "conversation.md";
export const SCIC_ATTACHMENTS_DIRECTORY = "attachments/";

export const SCIC_SNAPSHOT_MEDIA_TYPE = "application/json";
export const SCIC_MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";

// ---------------------------------------------------------------------------
// Limits. The writer refuses to exceed them; the reader rejects anything that
// does. The per-import upload limit in the contracts covers all of them.
// ---------------------------------------------------------------------------

export const SCIC_MAX_ENTRIES = 10_000;
export const SCIC_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const SCIC_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const SCIC_MAX_MARKDOWN_BYTES = 64 * 1024 * 1024;
/** One attachment: the largest chat attachment. */
export const SCIC_MAX_ATTACHMENT_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;
export const SCIC_MAX_ATTACHMENT_TOTAL_BYTES = SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES;
/** Everything a package may expand to. */
export const SCIC_MAX_UNCOMPRESSED_BYTES =
  SCIC_MAX_ATTACHMENT_TOTAL_BYTES +
  SCIC_MAX_SNAPSHOT_BYTES +
  SCIC_MAX_MARKDOWN_BYTES +
  SCIC_MAX_MANIFEST_BYTES +
  1_024;
/**
 * Largest expansion one entry may claim once it is over
 * `SCIC_COMPRESSION_RATIO_FLOOR_BYTES`. Real transcripts compress about ten
 * to one; a much higher ratio is a decompression bomb.
 */
export const SCIC_MAX_COMPRESSION_RATIO = 500;
export const SCIC_COMPRESSION_RATIO_FLOOR_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SAFE_NAME_MAX_CHARS = 100;

/** A file name segment every file system accepts: letters, digits, `.`, `_`, `-`. */
export function scicSafeFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "");
  const extensionIndex = cleaned.lastIndexOf(".");
  const extension =
    extensionIndex > 0 && cleaned.length - extensionIndex <= 12
      ? cleaned.slice(extensionIndex)
      : "";
  const stem = (extension ? cleaned.slice(0, extensionIndex) : cleaned)
    .slice(0, SAFE_NAME_MAX_CHARS - extension.length)
    .replace(/[-.]+$/gu, "");
  return stem.length > 0 ? `${stem}${extension}` : `attachment${extension}`;
}

/** Where an attachment's bytes live: named by their SHA-256, so identical bytes share an entry. */
export function scicAttachmentPath(sha256: Sha256Digest, name: string): string {
  return `${SCIC_ATTACHMENTS_DIRECTORY}${sha256.slice("sha256:".length)}-${scicSafeFileName(name)}`;
}

const ATTACHMENT_PATH_PATTERN = /^attachments\/([0-9a-f]{64})-([\p{L}\p{N}._-]{1,100})$/u;

/** The SHA-256 an attachment path names, or null when the path is not an attachment path. */
export function scicAttachmentPathDigest(path: string): Sha256Digest | null {
  const match = ATTACHMENT_PATH_PATTERN.exec(path);
  return match && !match[2]!.startsWith(".") ? `sha256:${match[1]!}` : null;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const ShortText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const ScicManifestEntry = Schema.Struct({
  path: ShortText(512),
  mediaType: ShortText(100),
  byteLength: NonNegativeInt,
  sha256: Sha256Digest,
});
export type ScicManifestEntry = typeof ScicManifestEntry.Type;

export const ScicUnavailableReason = Schema.Literals([
  "missing",
  "unreadable",
  "unsupported",
  "too-large",
]);
export type ScicUnavailableReason = typeof ScicUnavailableReason.Type;

/** An attachment the snapshot names: its bytes in the package, or why they are not. */
export const ScicManifestResource = Schema.Union([
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
    reason: ScicUnavailableReason,
  }),
]);
export type ScicManifestResource = typeof ScicManifestResource.Type;

/** Read first, so an unsupported major version is reported before the rest is decoded. */
export const ScicManifestHeader = Schema.Struct({
  format: Schema.Literal(SCIC_FORMAT),
  formatVersion: ConversationImportFormatVersion,
});

export const ScicManifest = Schema.Struct({
  ...ScicManifestHeader.fields,
  exporter: Schema.Struct({ name: ShortText(64), version: ShortText(64) }),
  exportId: ConversationExternalExportId,
  exportedAt: IsoDateTime,
  sourceThreadId: ConversationExternalId,
  contentDigest: Sha256Digest,
  entries: Schema.Array(ScicManifestEntry),
  resources: Schema.Array(ScicManifestResource),
  warnings: Schema.Array(DocumentWarning),
});
export type ScicManifest = typeof ScicManifest.Type;

// ---------------------------------------------------------------------------
// Attachment media policy
// ---------------------------------------------------------------------------

/** Bytes needed to recognise every type `sniffMediaType` knows. */
export const SNIFF_BYTES = 16;

const startsWith = (head: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  head.length >= offset + signature.length &&
  signature.every((byte, index) => head[offset + index] === byte);

/** The media type a file's first bytes prove, for the types Scient checks. */
export function sniffMediaType(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

const SNIFFED_TYPES = new Set([
  ...PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  "application/pdf",
]);
const SUPPORTED_IMAGE_TYPES = new Set<string>(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES);

/**
 * Whether the bytes contradict their declared type. Only types with a
 * reliable signature are checked; any other declared type is taken as given.
 */
export function contradictsDeclaredType(mediaType: string, head: Uint8Array): boolean {
  const declared = mediaType.split(";")[0]!.trim().toLowerCase();
  return SNIFFED_TYPES.has(declared) && sniffMediaType(head) !== declared;
}

/**
 * Whether Scient accepts the attachment as a chat attachment: images of a
 * type providers accept up to the image limit, and non-empty files up to the
 * file limit. Anything else travels as an unavailable attachment.
 */
export function withinAttachmentPolicy(input: {
  readonly kind: ConversationAttachmentKind;
  readonly mediaType: string;
  readonly byteLength: number;
}): boolean {
  switch (input.kind) {
    case "image":
      return (
        SUPPORTED_IMAGE_TYPES.has(input.mediaType) &&
        input.byteLength >= 1 &&
        input.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      );
    case "file":
      return input.byteLength >= 1 && input.byteLength <= PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    default:
      return false;
  }
}
