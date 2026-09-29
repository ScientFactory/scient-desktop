// @effect-diagnostics nodeBuiltinImport:off -- entry digests are computed synchronously while the package is assembled.
/**
 * Assembles a portable conversation file from a captured snapshot and the
 * attachment bytes present at capture.
 *
 * The package's snapshot is the captured one made portable: every attachment
 * is renamed to a package resource (`attachment-N`), attachments outside the
 * chat attachment media policy or whose bytes contradict their declared type
 * travel as unavailable, the attachment warnings are rebuilt from those facts,
 * Scient's own storage paths are redacted from every string, and the content
 * digest is recomputed over the result. The readable copy is written from that
 * same snapshot, with its attachment links pointing into the package.
 */
import * as NodeCrypto from "node:crypto";

import {
  SCIC_FORMAT,
  SCIC_FORMAT_MAJOR_VERSION,
  SCIC_FORMAT_MINOR_VERSION,
  SCIC_MEDIA_TYPE,
  type ConversationAttachment,
  type ConversationImportResourceId,
  TurnId,
  type ConversationSnapshotV1,
  type ConversationSnapshotWarning,
  type DocumentWarning,
  type Sha256Digest,
} from "@t3tools/contracts";
import {
  buildConversationDocument,
  warningValue,
  writeConversationMarkdown,
  type ExternalAttachmentContent,
  type ResolvedAttachmentContent,
} from "@scientfactory/conversation";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ValidatedConversationImport,
  conversationContentDigest,
  conversationImportOmissions,
} from "../conversationImport/ConversationImporter.ts";
import {
  SCIC_COMPRESSION_RATIO_FLOOR_BYTES,
  SCIC_MANIFEST_ENTRY,
  SCIC_MARKDOWN_ENTRY,
  SCIC_MARKDOWN_MEDIA_TYPE,
  SCIC_MAX_MANIFEST_BYTES,
  SCIC_MAX_MARKDOWN_BYTES,
  SCIC_MAX_SNAPSHOT_BYTES,
  SCIC_MAX_ENTRIES,
  SCIC_MAX_UNCOMPRESSED_BYTES,
  SCIC_MIMETYPE_ENTRY,
  SCIC_SNAPSHOT_ENTRY,
  SCIC_SNAPSHOT_MEDIA_TYPE,
  SNIFF_BYTES,
  ScicManifest,
  contradictsDeclaredType,
  scicAttachmentPath,
  scicAttachmentPathDigest,
  withinAttachmentPolicy,
  type ScicManifestEntry,
  type ScicManifestResource,
  type ScicUnavailableReason,
} from "./scicFormat.ts";

/**
 * An attachment file checked at capture but not read into memory: the
 * archive streams it and fails if it no longer matches its size and digest.
 */
export interface ScicAttachmentFile {
  readonly _tag: "file";
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: Sha256Digest;
  /** The file's first bytes, for checking its declared media type. */
  readonly head: Uint8Array;
}

/** Attachment content found at capture, or why there is none, by local attachment ID. */
export type ScicAttachmentBytes = ResolvedAttachmentContent | ScicAttachmentFile;

export interface ScicPackageInput<Attachment extends ScicAttachmentBytes = ScicAttachmentBytes> {
  readonly snapshot: ConversationSnapshotV1;
  /** Attachments found at capture; an available attachment missing here is `missing`. */
  readonly attachments: ReadonlyMap<string, Attachment>;
  /** The export's marker value; also the manifest's export ID. */
  readonly exportValue: string;
  readonly exportedAt: string;
  readonly exporter: { readonly name: string; readonly version: string };
  readonly timeZone: string;
  /** Removes Scient's own storage locations from text. */
  readonly redact: (text: string) => string;
}

export interface ScicPackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Stored as is or deflated, subject to the reader's compression-ratio limit. */
  readonly compress: boolean;
}

/** An attachment entry copied from its file when the archive is written. */
export interface ScicStreamedFile {
  readonly path: string;
  readonly file: {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: Sha256Digest;
  };
  readonly compress: boolean;
}

export interface ScicPackage<File = ScicPackageFile> {
  /** In archive order: `mimetype` first, then the manifest, documents, and attachments. */
  readonly files: ReadonlyArray<File>;
  readonly manifest: ScicManifest;
  readonly snapshot: ConversationSnapshotV1;
  readonly contentDigest: Sha256Digest;
  readonly messageCount: number;
  readonly warnings: ReadonlyArray<DocumentWarning>;
}

export type ScicPackageFailure =
  | { readonly _tag: "nothing-to-export" }
  | { readonly _tag: "too-large"; readonly entry: string }
  /** The writer's own package would fail the reader's checks: a defect in the writer. */
  | { readonly _tag: "invalid-package"; readonly detail: string };

const encoder = new TextEncoder();

/** Above this size, deflation could make a valid entry fail the reader's ratio limit. */
function canCompress(byteLength: number): boolean {
  return byteLength <= SCIC_COMPRESSION_RATIO_FLOOR_BYTES;
}

export function sha256Digest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function redactStrings<A>(value: A, redact: (text: string) => string): A {
  if (typeof value === "string") return redact(value) as A;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact)) as A;
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]),
    ) as A;
  }
  return value;
}

interface IncludedContent {
  readonly _tag: "included";
  readonly byteLength: number;
  readonly sha256: Sha256Digest;
  readonly source:
    | { readonly _tag: "bytes"; readonly bytes: Uint8Array }
    | { readonly _tag: "file"; readonly path: string };
}

interface Resource {
  readonly id: ConversationImportResourceId;
  readonly attachment: ConversationAttachment;
  readonly content:
    | IncludedContent
    | { readonly _tag: "unavailable"; readonly reason: ScicUnavailableReason };
}

function resolveResource(
  attachment: ConversationAttachment,
  read: ScicAttachmentBytes | undefined,
): Resource["content"] {
  if (!attachment.available || read === undefined)
    return { _tag: "unavailable", reason: "missing" };
  if (read._tag === "unavailable") return { _tag: "unavailable", reason: read.reason };
  const byteLength = read._tag === "bytes" ? read.bytes.byteLength : read.byteLength;
  const head = read._tag === "bytes" ? read.bytes : read.head;
  const acceptable =
    withinAttachmentPolicy({ kind: attachment.kind, mediaType: attachment.mimeType, byteLength }) &&
    !contradictsDeclaredType(attachment.mimeType, head.subarray(0, SNIFF_BYTES));
  return acceptable
    ? {
        _tag: "included",
        byteLength,
        sha256: read.sha256,
        source:
          read._tag === "bytes"
            ? { _tag: "bytes", bytes: read.bytes }
            : { _tag: "file", path: read.path },
      }
    : { _tag: "unavailable", reason: "unsupported" };
}

const UNAVAILABLE_NOTES: Record<Exclude<ScicUnavailableReason, "missing">, string> = {
  unreadable: "could not be read",
  unsupported: "is not a type or size Scient can import",
  "too-large": "is too large to include",
};

/**
 * The importer maps each source turn to one local turn and so requires a
 * turn's messages to form one run (steering prompts, which have no turn, may
 * sit inside it). A turn whose messages return after another turn therefore
 * continues as a new turn, `<turnId>~2`, `~3`, …, and every other record of
 * that turn joins the run it was recorded in: the latest run that had started
 * by its time, or the first.
 */
function splitReappearingTurns(snapshot: ConversationSnapshotV1): ConversationSnapshotV1 {
  const taken = new Set<string>(
    [
      ...snapshot.messages,
      ...snapshot.reasoning,
      ...snapshot.workLog,
      ...snapshot.proposedPlans,
      ...snapshot.questionAnswers,
    ].flatMap((record) => (record.turnId === null ? [] : [record.turnId])),
  );
  if (snapshot.omittedRunningTurn) taken.add(snapshot.omittedRunningTurn.turnId);
  const runs = new Map<string, Array<{ readonly start: string; readonly turnId: TurnId }>>();
  let current: TurnId | null = null;
  let split = false;
  const messages = snapshot.messages.map((message) => {
    if (message.turnId === null) return message;
    let turnRuns = runs.get(message.turnId);
    if (turnRuns === undefined) {
      turnRuns = [{ start: message.createdAt, turnId: message.turnId }];
      runs.set(message.turnId, turnRuns);
    } else if (message.turnId !== current) {
      let ordinal = turnRuns.length + 1;
      while (taken.has(`${message.turnId}~${ordinal}`)) ordinal += 1;
      const turnId = TurnId.make(`${message.turnId}~${ordinal}`);
      taken.add(turnId);
      turnRuns.push({ start: message.createdAt, turnId });
      split = true;
    }
    current = message.turnId;
    return { ...message, turnId: turnRuns.at(-1)!.turnId };
  });
  if (!split) return snapshot;
  const runTurn = (turnId: TurnId | null, createdAt: string): TurnId | null => {
    const turnRuns = turnId === null ? undefined : runs.get(turnId);
    if (turnRuns === undefined) return turnId;
    let chosen = turnRuns[0]!;
    for (const run of turnRuns) if (run.start <= createdAt) chosen = run;
    return chosen.turnId;
  };
  const withRunTurn = <A extends { readonly turnId: TurnId | null; readonly createdAt: string }>(
    record: A,
  ): A => ({ ...record, turnId: runTurn(record.turnId, record.createdAt) });
  return {
    ...snapshot,
    messages,
    reasoning: snapshot.reasoning.map(withRunTurn),
    workLog: snapshot.workLog.map(withRunTurn),
    proposedPlans: snapshot.proposedPlans.map(withRunTurn),
    questionAnswers: snapshot.questionAnswers.map(withRunTurn),
  };
}

const decodeManifest = Schema.decodeUnknownExit(ScicManifest);

/**
 * The reader's manifest and path rules, applied by the writer to its own
 * manifest before anything is written: it decodes as a `ScicManifest`, every
 * entry path is distinct regardless of case, and every attachment path is one
 * the reader accepts for its digest. Null when the package passes.
 */
function checkOwnManifest(manifestText: string): string | null {
  const decoded = decodeManifest(JSON.parse(manifestText));
  if (Exit.isFailure(decoded)) return "The manifest does not decode.";
  const folded = new Set<string>();
  for (const path of [
    SCIC_MIMETYPE_ENTRY,
    SCIC_MANIFEST_ENTRY,
    ...decoded.value.entries.map((entry) => entry.path),
  ]) {
    const key = path.normalize("NFC").toLowerCase();
    if (folded.has(key)) return "Two entries share a path.";
    folded.add(key);
  }
  for (const entry of decoded.value.entries) {
    if (entry.path === SCIC_SNAPSHOT_ENTRY || entry.path === SCIC_MARKDOWN_ENTRY) continue;
    if (scicAttachmentPathDigest(entry.path) !== entry.sha256) {
      return "An attachment path is not one the reader accepts.";
    }
  }
  for (const resource of decoded.value.resources) {
    if (resource._tag === "included" && scicAttachmentPathDigest(resource.path) !== resource.sha256)
      return "A resource path is not one the reader accepts.";
  }
  return null;
}

const decodeValidated = Schema.decodeUnknownExit(ValidatedConversationImport);
/** Stand-ins for what only a receiver knows; validation does not depend on them. */
const SELF_CHECK_IMPORT_ID = "cimp_00000000-0000-4000-8000-000000000000";
const SELF_CHECK_PACKAGE_SHA256 = `sha256:${"0".repeat(64)}`;
const SELF_CHECK_PACKAGE_BYTES = 1;

/**
 * The reader's validation of the conversation, applied by the writer to its
 * own `conversation.json` and manifest: the decoded snapshot, its staged
 * attachments, omissions, and warnings must form a `ValidatedConversationImport`.
 * Null when they do.
 */
function checkOwnSnapshot(input: {
  readonly manifest: ScicManifest;
  readonly snapshotText: string;
  readonly packageSnapshot: ConversationSnapshotV1;
}): string | null {
  const pastedText = new Map(
    [
      ...input.packageSnapshot.messages.flatMap((message) => message.attachments),
      ...input.packageSnapshot.questionAnswers.flatMap((answer) =>
        answer.items.flatMap((item) => item.attachments),
      ),
    ].map((attachment) => [attachment.localId, attachment.pastedText]),
  );
  const validated = decodeValidated({
    importId: SELF_CHECK_IMPORT_ID,
    package: {
      format: input.manifest.format,
      formatVersion: input.manifest.formatVersion,
      exporter: input.manifest.exporter,
      exportId: input.manifest.exportId,
      exportedAt: input.manifest.exportedAt,
      sourceThreadId: input.manifest.sourceThreadId,
      contentDigest: input.manifest.contentDigest,
      packageSha256: SELF_CHECK_PACKAGE_SHA256,
      packageBytes: SELF_CHECK_PACKAGE_BYTES,
    },
    snapshot: JSON.parse(input.snapshotText),
    attachments: input.manifest.resources.flatMap((resource) =>
      resource._tag === "included"
        ? [
            {
              resourceId: resource.id,
              kind: resource.kind,
              name: resource.name,
              mediaType: resource.mediaType,
              byteLength: resource.byteLength,
              sha256: resource.sha256,
              pastedText: pastedText.get(resource.id) ?? false,
            },
          ]
        : [],
    ),
    omissions: conversationImportOmissions(input.packageSnapshot),
    warnings: input.manifest.warnings.map((warning) => ({
      _tag: "export-warning" as const,
      warning,
    })),
  });
  return Exit.isFailure(validated) ? "The conversation does not pass import validation." : null;
}

/**
 * Makes the captured snapshot portable, then assembles every package entry.
 * Attachments given as bytes become in-memory entries; attachment files are
 * streamed when the archive is written.
 */
export function prepareScicPackage(
  input: ScicPackageInput<ResolvedAttachmentContent>,
): { readonly _tag: "ok"; readonly value: ScicPackage } | ScicPackageFailure;
export function prepareScicPackage(
  input: ScicPackageInput,
):
  | { readonly _tag: "ok"; readonly value: ScicPackage<ScicPackageFile | ScicStreamedFile> }
  | ScicPackageFailure;
export function prepareScicPackage(
  input: ScicPackageInput,
):
  | { readonly _tag: "ok"; readonly value: ScicPackage<ScicPackageFile | ScicStreamedFile> }
  | ScicPackageFailure {
  const { snapshot } = input;

  // Resources in order of first appearance: message attachments, then answers.
  const occurrences = [
    ...snapshot.messages.flatMap((message) =>
      message.attachments.map((attachment) => ({
        attachment,
        messageN: message.n as number | null,
      })),
    ),
    ...snapshot.questionAnswers.flatMap((answer) =>
      answer.items.flatMap((item) =>
        item.attachments.map((attachment) => ({ attachment, messageN: null as number | null })),
      ),
    ),
  ];
  const resources = new Map<string, Resource>();
  for (const { attachment } of occurrences) {
    if (resources.has(attachment.localId)) continue;
    resources.set(attachment.localId, {
      id: `attachment-${resources.size + 1}` as ConversationImportResourceId,
      attachment,
      content: resolveResource(attachment, input.attachments.get(attachment.localId)),
    });
  }

  const portableAttachment = (attachment: ConversationAttachment): ConversationAttachment => {
    const resource = resources.get(attachment.localId)!;
    return {
      ...attachment,
      localId: resource.id,
      available: resource.content._tag === "included",
      sizeBytes:
        resource.content._tag === "included" ? resource.content.byteLength : attachment.sizeBytes,
    };
  };

  // Attachment warnings restated from the facts: one per unavailable attachment
  // on a message, and per unavailable answer attachment.
  const attachmentWarnings: ConversationSnapshotWarning[] = occurrences.flatMap(
    ({ attachment, messageN }) =>
      resources.get(attachment.localId)!.content._tag === "included"
        ? []
        : [{ _tag: "attachment-unavailable", name: attachment.name, messageN }],
  );
  const warnings: ConversationSnapshotWarning[] = [
    ...snapshot.warnings.filter((warning) => warning._tag === "running-turn-omitted"),
    ...attachmentWarnings,
    ...snapshot.warnings.filter((warning) => warning._tag === "records-skipped"),
  ];

  const contiguous = splitReappearingTurns(snapshot);
  const portable = redactStrings(
    {
      ...contiguous,
      messages: contiguous.messages.map((message) => ({
        ...message,
        attachments: message.attachments.map(portableAttachment),
        references: message.references.map((reference) =>
          reference._tag === "attachment" && resources.has(reference.attachmentLocalId)
            ? { ...reference, attachmentLocalId: resources.get(reference.attachmentLocalId)!.id }
            : reference,
        ),
      })),
      questionAnswers: contiguous.questionAnswers.map((answer) => ({
        ...answer,
        items: answer.items.map((item) => ({
          ...item,
          attachments: item.attachments.map(portableAttachment),
        })),
      })),
      warnings,
    },
    input.redact,
  );
  const contentDigest = conversationContentDigest(portable);
  const packageSnapshot: ConversationSnapshotV1 = { ...portable, contentDigest };

  // One archive path has one media type. Reuse a path only for resources whose
  // declared type also matches; prefix a colliding name to keep it readable.
  const pathsByNameAndType = new Map<string, Map<string, string>>();
  const occupiedPaths = new Map<string, { readonly path: string; readonly mediaType: string }>();
  const attachmentPath = (sha256: Sha256Digest, name: string, mediaType: string): string => {
    const naturalPath = scicAttachmentPath(sha256, name);
    let byType = pathsByNameAndType.get(naturalPath);
    if (!byType) {
      byType = new Map();
      pathsByNameAndType.set(naturalPath, byType);
    }
    const assigned = byType.get(mediaType);
    if (assigned) return assigned;
    let path = naturalPath;
    let suffix = 1;
    while (true) {
      const key = path.normalize("NFC").toLowerCase();
      const occupied = occupiedPaths.get(key);
      if (!occupied || occupied.mediaType === mediaType) {
        const selected = occupied?.path ?? path;
        if (!occupied) occupiedPaths.set(key, { path, mediaType });
        byType.set(mediaType, selected);
        return selected;
      }
      path = scicAttachmentPath(sha256, `${suffix}-${name}`);
      suffix += 1;
    }
  };
  for (const resource of resources.values()) {
    if (resource.content._tag === "included") {
      attachmentPath(
        resource.content.sha256,
        input.redact(resource.attachment.name),
        resource.attachment.mimeType,
      );
    }
  }

  const includedById = new Map<string, IncludedContent>();
  for (const resource of resources.values()) {
    if (resource.content._tag === "included") includedById.set(resource.id, resource.content);
  }
  // The readable copy only links to attachment files; it never needs their bytes.
  const document = buildConversationDocument({
    snapshot: packageSnapshot,
    exportValue: input.exportValue,
    timeZone: input.timeZone,
    resolveAttachment: (attachment): ResolvedAttachmentContent | ExternalAttachmentContent => {
      const included = includedById.get(attachment.localId);
      return included
        ? { _tag: "external", byteLength: included.byteLength, sha256: included.sha256 }
        : { _tag: "unavailable", reason: "missing" };
    },
  });
  if (document.messageCount === 0) return { _tag: "nothing-to-export" };

  // The readable copy links each attachment to its file in the package.
  const bundle = {
    ...document.bundle,
    assets: document.bundle.assets.map((asset) =>
      asset.content._tag !== "unavailable" && asset.content.sha256 !== null
        ? {
            ...asset,
            packagePath: attachmentPath(asset.content.sha256, asset.fileName, asset.mediaType),
          }
        : asset,
    ),
  };
  const markdown = input.redact(
    writeConversationMarkdown({
      bundle,
      exportValue: input.exportValue,
      exported: input.exportedAt,
      packaging: "with-attachments",
    }),
  );
  const exportWarnings: DocumentWarning[] = [
    ...bundle.warnings,
    ...[...resources.values()].flatMap((resource): DocumentWarning[] =>
      resource.content._tag === "unavailable" && resource.content.reason !== "missing"
        ? [
            {
              code: "attachment-unavailable",
              message: `Attachment “${warningValue(resource.attachment.name)}” ${UNAVAILABLE_NOTES[resource.content.reason]} and is listed by name only.`,
            },
          ]
        : [],
    ),
  ].map((warning) => ({ ...warning, message: input.redact(warning.message) }));

  const snapshotText = JSON.stringify(packageSnapshot);
  const snapshotBytes = encoder.encode(snapshotText);
  if (snapshotBytes.byteLength > SCIC_MAX_SNAPSHOT_BYTES) {
    return { _tag: "too-large", entry: SCIC_SNAPSHOT_ENTRY };
  }
  const markdownBytes = encoder.encode(markdown);
  if (markdownBytes.byteLength > SCIC_MAX_MARKDOWN_BYTES) {
    return { _tag: "too-large", entry: SCIC_MARKDOWN_ENTRY };
  }

  const attachmentFiles = new Map<
    string,
    (ScicPackageFile | ScicStreamedFile) & {
      readonly byteLength: number;
      readonly sha256: Sha256Digest;
      readonly mediaType: string;
    }
  >();
  const manifestResources: ScicManifestResource[] = [];
  for (const resource of resources.values()) {
    const { attachment, content } = resource;
    const name = input.redact(attachment.name);
    if (content._tag === "unavailable") {
      manifestResources.push({
        _tag: "unavailable",
        id: resource.id,
        name,
        reason: content.reason,
      });
      continue;
    }
    const path = attachmentPath(content.sha256, name, attachment.mimeType);
    if (!attachmentFiles.has(path)) {
      const compress = attachment.kind !== "image" && canCompress(content.byteLength);
      attachmentFiles.set(path, {
        path,
        byteLength: content.byteLength,
        sha256: content.sha256,
        mediaType: attachment.mimeType,
        compress,
        ...(content.source._tag === "bytes"
          ? { bytes: content.source.bytes }
          : {
              file: {
                path: content.source.path,
                byteLength: content.byteLength,
                sha256: content.sha256,
              },
            }),
      });
    }
    manifestResources.push({
      _tag: "included",
      id: resource.id,
      path,
      name,
      kind: attachment.kind === "image" ? "image" : "file",
      mediaType: attachment.mimeType,
      byteLength: content.byteLength,
      sha256: content.sha256,
    });
  }
  const orderedAttachments = [...attachmentFiles.values()].toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (orderedAttachments.length + 4 > SCIC_MAX_ENTRIES) {
    return { _tag: "too-large", entry: SCIC_MANIFEST_ENTRY };
  }

  const entries: ScicManifestEntry[] = [
    {
      path: SCIC_SNAPSHOT_ENTRY,
      mediaType: SCIC_SNAPSHOT_MEDIA_TYPE,
      byteLength: snapshotBytes.byteLength,
      sha256: sha256Digest(snapshotBytes),
    },
    {
      path: SCIC_MARKDOWN_ENTRY,
      mediaType: SCIC_MARKDOWN_MEDIA_TYPE,
      byteLength: markdownBytes.byteLength,
      sha256: sha256Digest(markdownBytes),
    },
    ...orderedAttachments.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      sha256: file.sha256,
    })),
  ];
  const manifest: ScicManifest = {
    format: SCIC_FORMAT,
    formatVersion: { major: SCIC_FORMAT_MAJOR_VERSION, minor: SCIC_FORMAT_MINOR_VERSION },
    exporter: input.exporter,
    exportId: input.exportValue,
    exportedAt: input.exportedAt,
    sourceThreadId: packageSnapshot.captured.threadId,
    contentDigest,
    entries,
    resources: manifestResources,
    warnings: exportWarnings,
  };
  const manifestText = JSON.stringify(manifest);
  const manifestBytes = encoder.encode(manifestText);
  if (manifestBytes.byteLength > SCIC_MAX_MANIFEST_BYTES) {
    return { _tag: "too-large", entry: SCIC_MANIFEST_ENTRY };
  }
  const invalid =
    checkOwnManifest(manifestText) ?? checkOwnSnapshot({ manifest, snapshotText, packageSnapshot });
  if (invalid !== null) return { _tag: "invalid-package", detail: invalid };
  const expandedBytes =
    SCIC_MEDIA_TYPE.length +
    manifestBytes.byteLength +
    snapshotBytes.byteLength +
    markdownBytes.byteLength +
    orderedAttachments.reduce((total, file) => total + file.byteLength, 0);
  if (expandedBytes > SCIC_MAX_UNCOMPRESSED_BYTES) {
    return { _tag: "too-large", entry: SCIC_MANIFEST_ENTRY };
  }

  return {
    _tag: "ok",
    value: {
      files: [
        { path: SCIC_MIMETYPE_ENTRY, bytes: encoder.encode(SCIC_MEDIA_TYPE), compress: false },
        {
          path: SCIC_MANIFEST_ENTRY,
          bytes: manifestBytes,
          compress: canCompress(manifestBytes.byteLength),
        },
        {
          path: SCIC_SNAPSHOT_ENTRY,
          bytes: snapshotBytes,
          compress: canCompress(snapshotBytes.byteLength),
        },
        {
          path: SCIC_MARKDOWN_ENTRY,
          bytes: markdownBytes,
          compress: canCompress(markdownBytes.byteLength),
        },
        ...orderedAttachments.map((file): ScicPackageFile | ScicStreamedFile =>
          "bytes" in file
            ? { path: file.path, bytes: file.bytes, compress: file.compress }
            : { path: file.path, file: file.file, compress: file.compress },
        ),
      ],
      manifest,
      snapshot: packageSnapshot,
      contentDigest,
      messageCount: document.messageCount,
      warnings: exportWarnings,
    },
  };
}
