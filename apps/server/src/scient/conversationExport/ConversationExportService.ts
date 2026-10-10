import * as Hex from "effect/encoding/Hex";
/**
 * Conversation export on the server: capture a snapshot, build its document
 * bundle, write the requested format, and hand back either a temporary file
 * (read through a signed asset by the HTTP layer) or text for the clipboard.
 * Formats this host cannot produce are reported, not attempted: Word is
 * available whenever the managed Pandoc is installed on this server.
 */
import {
  CONVERSATION_REFERENCE_URL_PREFIX,
  SCIC_FILE_EXTENSION,
  SCIC_MEDIA_TYPE,
  SCIENT_CONVERSATION_EXPORT_CLIPBOARD_MAX_CHARS,
  SCIENT_CONVERSATION_EXPORT_EXCERPT_MAX_CHARS,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  ScientConversationExportError,
  type ConversationAttachment,
  type ConversationExportFormat,
  type ConversationExportFormatCapability,
  type DocumentAssetUnavailableReason,
  type DocumentBundle,
  type ConversationSnapshotV1,
  type DocumentWarning,
  type ScientConversationExportPreparation,
  type ScientConversationExportRequest,
  type Sha256Digest,
  type ScientWordDiagramPlan,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildConversationDocument,
  exportFileName,
  packagedAssets,
  redactSnapshotStoragePaths,
  redactStoragePaths,
  writeConversationMarkdown,
  type ExternalAttachmentContent,
  type ResolvedAttachmentContent,
} from "@scientfactory/conversation";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import { prepareScicPackage, type ScicAttachmentFile } from "../conversationFile/ScicWriter.ts";
import { SNIFF_BYTES } from "../conversationFile/scicFormat.ts";
import {
  DOCX_MEDIA_TYPE,
  PandocWordConverter,
  type WordConversionFailureReason,
} from "../pandoc/PandocWordConverter.ts";
import { capturedWordDiagramAssets, planWordDiagrams } from "../pandoc/wordDiagramCapture.ts";
import {
  ConversationExportFileError,
  ConversationExportFiles,
  inspectAttachmentFile,
  type PackageEntry,
} from "./ConversationExportFiles.ts";
import {
  ConversationSnapshotService,
  type ConversationSnapshotReadError,
} from "./ConversationSnapshotService.ts";

const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const ZIP_MEDIA_TYPE = "application/zip";

const WORD_FAILURE_REASON: Record<
  WordConversionFailureReason,
  ScientConversationExportError["reason"]
> = {
  unavailable: "format-unavailable",
  "too-large": "too-large",
  timeout: "too-large",
  failed: "conversion-failed",
};

/** Formats `produce` writes on the server; the rest are produced from `document`. */
const SERVER_WRITTEN_FORMATS: ReadonlySet<ConversationExportFormat> = new Set([
  "markdown",
  "scic",
  "docx",
]);

export type ProducedExportOutput =
  | {
      readonly _tag: "file";
      readonly path: string;
      readonly fileName: string;
      readonly mediaType: string;
      readonly byteLength: number;
    }
  | { readonly _tag: "text"; readonly text: string };

/** A conversation's document bundle for a writer outside this service, such as PDF. */
export interface ConversationExportDocument {
  readonly bundle: DocumentBundle;
  readonly messageCount: number;
}

export interface ProducedExport {
  readonly exportId: string;
  readonly format: ConversationExportFormat;
  readonly contentDigest: Sha256Digest;
  readonly messageCount: number;
  readonly warnings: ReadonlyArray<DocumentWarning>;
  readonly output: ProducedExportOutput;
}

export type ConversationExportServiceError =
  | ScientConversationExportError
  | ConversationSnapshotReadError
  | ConversationExportFileError;

export class ConversationExportService extends Context.Service<
  ConversationExportService,
  {
    readonly prepare: (
      threadId: ThreadId,
    ) => Effect.Effect<ScientConversationExportPreparation, ConversationExportServiceError>;
    readonly produce: (
      request: ScientConversationExportRequest,
    ) => Effect.Effect<ProducedExport, ConversationExportServiceError>;
    readonly prepareWordDiagrams: (
      request: ScientConversationExportRequest,
    ) => Effect.Effect<ScientWordDiagramPlan, ConversationExportServiceError>;
    /**
     * The document bundle for the request's options (work log, reasoning,
     * range), with Scient's storage locations redacted, for writers that run
     * elsewhere.
     */
    readonly document: (
      request: ScientConversationExportRequest,
    ) => Effect.Effect<ConversationExportDocument, ConversationExportServiceError>;
  }
>()("t3/scient/conversationExport/ConversationExportService") {}

function excerpt(text: string): string {
  const plain = text
    .replaceAll(new RegExp(`\\]\\(${CONVERSATION_REFERENCE_URL_PREFIX}r\\d+\\)`, "gu"), "]")
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length <= SCIENT_CONVERSATION_EXPORT_EXCERPT_MAX_CHARS
    ? plain
    : `${plain.slice(0, SCIENT_CONVERSATION_EXPORT_EXCERPT_MAX_CHARS - 1)}…`;
}

/** Attachment ids the snapshot references, in conversation order, without repeats. */
function snapshotAttachmentIds(snapshot: ConversationSnapshotV1): ReadonlyArray<string> {
  return [
    ...new Set([
      ...snapshot.messages.flatMap((message) =>
        message.attachments.map((attachment) => attachment.localId),
      ),
      ...snapshot.questionAnswers.flatMap((answer) =>
        answer.items.flatMap((item) => item.attachments.map((attachment) => attachment.localId)),
      ),
    ]),
  ];
}

const reject = (reason: ScientConversationExportError["reason"], message: string) =>
  Effect.fail(new ScientConversationExportError({ reason, message }));

const nothingToExport = reject(
  "nothing-to-export",
  "This conversation has no completed messages yet.",
);

type UnavailableAttachment = {
  readonly _tag: "unavailable";
  readonly reason: DocumentAssetUnavailableReason;
};

const make = Effect.gen(function* () {
  const snapshots = yield* ConversationSnapshotService;
  const files = yield* ConversationExportFiles;
  const words = yield* PandocWordConverter;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  // Both the configured and the resolved spelling (e.g. /var vs /private/var).
  const storageRoots = [config.stateDir, config.baseDir];
  for (const root of [config.stateDir, config.baseDir]) {
    const resolved = yield* fileSystem.realPath(root).pipe(Effect.option);
    if (resolved._tag === "Some") storageRoots.push(resolved.value);
  }

  /** PDF is printed by the desktop; Word requires the managed Pandoc tool. */
  const formatCapabilities = words.availability.pipe(
    Effect.map((word): ReadonlyArray<ConversationExportFormatCapability> => [
      { format: "markdown", available: true, unavailableReason: null },
      { format: "pdf", available: true, unavailableReason: null },
      { format: "scic", available: true, unavailableReason: null },
      { format: "docx", available: word.available, unavailableReason: word.reason },
    ]),
  );

  const capture = (input: Parameters<ConversationSnapshotService["Service"]["capture"]>[0]) =>
    snapshots.capture(input).pipe(
      Effect.catchTags({
        ConversationThreadNotFoundError: () =>
          reject("thread-not-found", "This conversation no longer exists."),
        ConversationRangeError: () =>
          reject(
            "message-not-found",
            "The selected message is not part of the completed conversation.",
          ),
      }),
    );

  const prepare: ConversationExportService["Service"]["prepare"] = Effect.fn(
    "ConversationExportService.prepare",
  )(function* (threadId) {
    // Counts only: the selected content never leaves this function.
    const captured = yield* capture({
      threadId,
      selection: { workLog: true, reasoning: true, throughMessageId: null },
    });
    const snapshot = redactSnapshotStoragePaths(captured.snapshot, storageRoots);
    const answered = new Set(snapshot.questionAnswers.map((answer) => answer.id));
    const messages = snapshot.messages.filter(
      (message) =>
        message.role !== "system" &&
        !(message.id.startsWith("async-answer:") && answered.has(message.id.slice(13))),
    );
    return {
      threadId,
      title: snapshot.thread.title,
      formats: yield* formatCapabilities,
      messageCount: messages.length,
      attachmentCount:
        snapshot.messages.reduce((total, message) => total + message.attachments.length, 0) +
        snapshot.questionAnswers.reduce(
          (total, answer) =>
            total + answer.items.reduce((sum, item) => sum + item.attachments.length, 0),
          0,
        ),
      workLogEntryCount: snapshot.workLog.length,
      reasoningCount: snapshot.reasoning.length,
      runningTurnOmitted: snapshot.omittedRunningTurn !== null,
      messages: messages.map((message, index) => ({
        messageId: message.id,
        n: index + 1,
        role: message.role,
        createdAt: message.createdAt,
        excerpt: excerpt(message.text),
      })),
    };
  });

  /**
   * Captures the snapshot for the request's options and redacts Scient's
   * storage locations from its structured text before any writer escapes it.
   */
  const captureRequest = Effect.fn("ConversationExportService.captureRequest")(function* (
    request: ScientConversationExportRequest,
  ) {
    // Every export path captures through here, so this is where partial
    // ranges are refused. The snapshot's range selection stays for later, but
    // it cuts records by creation time, and a plan, reasoning block, or message
    // created before the chosen message and updated after it keeps its
    // creation time while carrying the later content. That must be solved
    // before ranges are accepted again.
    if (request.options.range._tag !== "whole") {
      return yield* reject(
        "range-unavailable",
        "Exporting part of a conversation is not available yet.",
      );
    }
    const captured = yield* capture({
      threadId: request.threadId,
      selection: {
        workLog: request.options.includeWorkLog,
        reasoning: request.options.includeReasoning,
        throughMessageId: null,
      },
    });
    const exportValue = Hex.encode(yield* crypto.randomBytes(6).pipe(Effect.orDie));
    return {
      snapshot: redactSnapshotStoragePaths(captured.snapshot, storageRoots),
      attachmentFiles: captured.attachmentFiles,
      exportValue,
    };
  });

  /**
   * Resolves the snapshot's attachment files within the export's byte budget.
   * Only attachments the selected snapshot holds are looked at and charged, in
   * the order they appear, so an excluded tail cannot use up the budget. `read`
   * receives a regular file that fits and returns what the writer needs.
   */
  const resolveAttachments = <A extends { readonly byteLength: number }>(
    snapshot: ConversationSnapshotV1,
    attachmentFiles: ReadonlyMap<string, string>,
    read: (
      path: string,
      remaining: number,
      size: number,
    ) => Effect.Effect<A | Exclude<DocumentAssetUnavailableReason, "missing">>,
  ) =>
    Effect.gen(function* () {
      const resolved = new Map<string, A | UnavailableAttachment>();
      let totalBytes = 0;
      for (const localId of snapshotAttachmentIds(snapshot)) {
        const path = attachmentFiles.get(localId);
        if (path === undefined) continue;
        const remaining = SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES - totalBytes;
        const fileInfo = yield* fileSystem.stat(path).pipe(Effect.option);
        if (fileInfo._tag === "None" || fileInfo.value.type !== "File") {
          resolved.set(localId, { _tag: "unavailable", reason: "unreadable" });
          continue;
        }
        if (fileInfo.value.size > remaining) {
          resolved.set(localId, { _tag: "unavailable", reason: "too-large" });
          continue;
        }
        const result = yield* read(path, remaining, Number(fileInfo.value.size));
        if (typeof result === "string") {
          resolved.set(localId, { _tag: "unavailable", reason: result });
          continue;
        }
        totalBytes += result.byteLength;
        resolved.set(localId, result);
      }
      return resolved;
    });

  /** Reads attachments into memory, for writers that embed their bytes (PDF, Word). */
  const readAttachmentBytes = (path: string, remaining: number) =>
    Effect.gen(function* () {
      // Bound the actual read too: the file could grow between stat and read.
      const bytes = yield* fileSystem.stream(path, { bytesToRead: remaining + 1 }).pipe(
        Stream.runCollect,
        Effect.map((chunks) => Buffer.concat(chunks)),
        Effect.option,
      );
      if (bytes._tag === "None") return "unreadable" as const;
      if (bytes.value.byteLength > remaining) return "too-large" as const;
      const digest = yield* crypto.digest("SHA-256", bytes.value).pipe(Effect.option);
      if (digest._tag === "None") return "unreadable" as const;
      return {
        _tag: "bytes" as const,
        bytes: bytes.value,
        byteLength: bytes.value.byteLength,
        sha256: `sha256:${Hex.encode(digest.value)}` as Sha256Digest,
      };
    });

  /** A file a package streams when it is written; its size was checked against the budget. */
  const packageAttachmentFile = (path: string, _remaining: number, size: number) =>
    Effect.succeed({ _tag: "file" as const, path, byteLength: size });

  /** Hashes a file a conversation file streams, holding only its first bytes. */
  const inspectAttachment = (path: string, remaining: number) =>
    Effect.tryPromise(() => inspectAttachmentFile(path, remaining, SNIFF_BYTES)).pipe(
      Effect.map((inspected) =>
        inspected === null
          ? ("too-large" as const)
          : ({ _tag: "file", path, ...inspected } satisfies ScicAttachmentFile),
      ),
      Effect.orElseSucceed(() => "unreadable" as const),
    );

  /**
   * The document for writers that list attachments without their bytes: text
   * Markdown, Copy, and the Word diagram plan use the recorded sizes and never
   * open an attachment file.
   */
  const listedDocument = (
    snapshot: ConversationSnapshotV1,
    exportValue: string,
    request: ScientConversationExportRequest,
    resolve: (
      attachment: ConversationAttachment,
    ) => ResolvedAttachmentContent | ExternalAttachmentContent = (attachment) => ({
      _tag: "external",
      byteLength: attachment.sizeBytes,
      sha256: null,
    }),
  ) =>
    Effect.gen(function* () {
      const document = buildConversationDocument({
        snapshot,
        exportValue,
        timeZone: request.timeZone ?? "UTC",
        resolveAttachment: resolve,
      });
      if (document.messageCount === 0) return yield* nothingToExport;
      return document;
    });

  /** The document with attachment bytes in memory, for PDF and Word. */
  const embeddedDocument = Effect.fn("ConversationExportService.embeddedDocument")(function* (
    request: ScientConversationExportRequest,
  ) {
    const { snapshot, attachmentFiles, exportValue } = yield* captureRequest(request);
    const resolved = yield* resolveAttachments(snapshot, attachmentFiles, readAttachmentBytes);
    const document = buildConversationDocument({
      snapshot,
      exportValue,
      timeZone: request.timeZone ?? "UTC",
      resolveAttachment: (attachment): ResolvedAttachmentContent => {
        const content = resolved.get(attachment.localId);
        return content === undefined
          ? { _tag: "unavailable", reason: "missing" }
          : content._tag === "bytes"
            ? { _tag: "bytes", bytes: content.bytes, sha256: content.sha256 }
            : content;
      },
    });
    if (document.messageCount === 0) return yield* nothingToExport;
    return { snapshot, document };
  });

  const prepareWordDiagrams: ConversationExportService["Service"]["prepareWordDiagrams"] =
    Effect.fn("ConversationExportService.prepareWordDiagrams")(function* (request) {
      const { snapshot, exportValue } = yield* captureRequest(request);
      const document = yield* listedDocument(snapshot, exportValue, request);
      return yield* Effect.try({
        try: () =>
          planWordDiagrams(
            redactStoragePaths(document.bundle.markdown, storageRoots),
            snapshot.contentDigest,
          ),
        catch: () =>
          new ScientConversationExportError({
            reason: "too-large",
            message:
              "This conversation has too many or oversized Mermaid diagrams for Word export.",
          }),
      });
    });

  const redactWarnings = (warnings: ReadonlyArray<DocumentWarning>) =>
    warnings.map((warning) => ({
      ...warning,
      message: redactStoragePaths(warning.message, storageRoots),
    }));

  const produceScic = Effect.fn("ConversationExportService.produceScic")(function* (
    request: ScientConversationExportRequest,
    exportId: string,
    exported: string,
  ) {
    const { snapshot, attachmentFiles, exportValue } = yield* captureRequest(request);
    const attachments = yield* resolveAttachments(snapshot, attachmentFiles, inspectAttachment);
    const prepared = prepareScicPackage({
      snapshot,
      attachments,
      exportValue,
      exportedAt: exported,
      exporter: { name: "Scient", version: packageJson.version },
      timeZone: request.timeZone ?? "UTC",
      redact: (text) => redactStoragePaths(text, storageRoots),
    });
    if (prepared._tag === "nothing-to-export") return yield* nothingToExport;
    if (prepared._tag === "too-large") {
      return yield* reject(
        "too-large",
        "This conversation is too large for a Scient conversation file. Leave out the work log and reasoning, or export it as Markdown.",
      );
    }
    if (prepared._tag === "invalid-package") {
      // Never hand out a file the reader would refuse.
      return yield* new ConversationExportFileError({
        cause: new Error(`The conversation file failed its own check: ${prepared.detail}`),
      });
    }
    const fileName = exportFileName(snapshot.thread.title, SCIC_FILE_EXTENSION);
    const written = yield* files.write({
      exportId,
      fileName,
      content: { _tag: "zip", modifiedAt: exported, entries: prepared.value.files },
    });
    return {
      exportId,
      format: request.format,
      contentDigest: prepared.value.contentDigest,
      messageCount: prepared.value.messageCount,
      warnings: prepared.value.warnings,
      output: {
        _tag: "file",
        path: written.path,
        fileName,
        mediaType: SCIC_MEDIA_TYPE,
        byteLength: written.byteLength,
      },
    } satisfies ProducedExport;
  });

  const produceWord = Effect.fn("ConversationExportService.produceWord")(function* (
    request: ScientConversationExportRequest,
    exportId: string,
  ) {
    const { snapshot, document } = yield* embeddedDocument(request);
    const wordMarkdown = redactStoragePaths(document.bundle.markdown, storageRoots);
    const diagrams = yield* Effect.try({
      try: () =>
        capturedWordDiagramAssets(
          { ...document.bundle, markdown: wordMarkdown },
          snapshot.contentDigest,
          request.diagramCapture,
        ),
      catch: (cause) =>
        new ScientConversationExportError({
          reason: "conversion-failed",
          message: cause instanceof Error ? cause.message : "The diagram capture is invalid.",
        }),
    });
    const fileName = exportFileName(snapshot.thread.title, ".docx");
    const target = yield* files.reserve({ exportId, fileName });
    const converted = yield* words
      .convert({
        bundle: {
          ...document.bundle,
          markdown: wordMarkdown,
          assets: [...document.bundle.assets, ...diagrams],
        },
        outputPath: target.path,
      })
      .pipe(
        Effect.catchTags({
          WordConversionError: (error) => reject(WORD_FAILURE_REASON[error.reason], error.message),
        }),
      );
    return {
      exportId,
      format: request.format,
      contentDigest: snapshot.contentDigest,
      messageCount: document.messageCount,
      warnings: redactWarnings(converted.warnings),
      output: {
        _tag: "file",
        path: target.path,
        fileName,
        mediaType: DOCX_MEDIA_TYPE,
        byteLength: converted.byteLength,
      },
    } satisfies ProducedExport;
  });

  const produceMarkdown = Effect.fn("ConversationExportService.produceMarkdown")(function* (
    request: ScientConversationExportRequest,
    exportId: string,
    exported: string,
  ) {
    const packaging = request.options.markdownPackaging ?? "text";
    const { snapshot, attachmentFiles, exportValue } = yield* captureRequest(request);
    // A text export lists attachments; a `.zip` streams each file into the
    // archive when it is written, so neither holds attachment bytes.
    const packageFiles =
      packaging === "with-attachments"
        ? yield* resolveAttachments(snapshot, attachmentFiles, packageAttachmentFile)
        : new Map<string, never>();
    const document = yield* listedDocument(
      snapshot,
      exportValue,
      request,
      packaging === "with-attachments"
        ? (attachment) => {
            const content = packageFiles.get(attachment.localId);
            return content === undefined
              ? { _tag: "unavailable", reason: "missing" }
              : content._tag === "file"
                ? { _tag: "external", byteLength: content.byteLength, sha256: null }
                : content;
          }
        : undefined,
    );
    const markdown = redactStoragePaths(
      writeConversationMarkdown({ bundle: document.bundle, exportValue, exported, packaging }),
      storageRoots,
    );
    const base = {
      exportId,
      format: request.format,
      contentDigest: snapshot.contentDigest,
      messageCount: document.messageCount,
      warnings: redactWarnings(document.bundle.warnings),
    };

    if (request.delivery === "clipboard") {
      if (markdown.length > SCIENT_CONVERSATION_EXPORT_CLIPBOARD_MAX_CHARS) {
        return yield* reject(
          "too-large",
          "This conversation is too long to copy. Save it as a file instead.",
        );
      }
      return { ...base, output: { _tag: "text", text: markdown } } satisfies ProducedExport;
    }

    const fileName = exportFileName(snapshot.thread.title, packaging === "text" ? ".md" : ".zip");
    const markdownName = exportFileName(snapshot.thread.title, ".md");
    const entries = packagedAssets(document.bundle).flatMap((asset): PackageEntry[] => {
      if ("bytes" in asset) return [{ path: asset.path, bytes: asset.bytes }];
      const content = packageFiles.get(asset.localId);
      return content?._tag === "file"
        ? [
            {
              path: asset.path,
              file: { path: content.path, byteLength: content.byteLength, sha256: null },
            },
          ]
        : [];
    });
    const written = yield* files.write({
      exportId,
      fileName,
      content:
        packaging === "text"
          ? { _tag: "text", text: markdown }
          : {
              _tag: "zip",
              modifiedAt: exported,
              entries: [
                { path: markdownName, bytes: new TextEncoder().encode(markdown) },
                ...entries,
              ],
            },
    });
    return {
      ...base,
      output: {
        _tag: "file",
        path: written.path,
        fileName,
        mediaType: packaging === "text" ? MARKDOWN_MEDIA_TYPE : ZIP_MEDIA_TYPE,
        byteLength: written.byteLength,
      },
    } satisfies ProducedExport;
  });

  const produce: ConversationExportService["Service"]["produce"] = Effect.fn(
    "ConversationExportService.produce",
  )(function* (request) {
    const capability = (yield* formatCapabilities).find((entry) => entry.format === request.format);
    if (!capability?.available) {
      return yield* reject(
        "format-unavailable",
        capability?.unavailableReason ?? "This format is not available on this Scient.",
      );
    }
    if (!SERVER_WRITTEN_FORMATS.has(request.format)) {
      return yield* reject(
        "format-unavailable",
        "This format is produced by the Scient desktop, not by a server export request.",
      );
    }
    const packaging = request.options.markdownPackaging ?? "text";
    if (
      request.delivery === "clipboard" &&
      (request.format !== "markdown" || packaging !== "text")
    ) {
      return yield* reject("delivery-unsupported", "Only text-only Markdown can be copied.");
    }
    const exportId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const exported = DateTime.formatIso(yield* DateTime.now);
    switch (request.format) {
      case "scic":
        return yield* produceScic(request, exportId, exported);
      case "docx":
        return yield* produceWord(request, exportId);
      default:
        return yield* produceMarkdown(request, exportId, exported);
    }
  });

  const document: ConversationExportService["Service"]["document"] = Effect.fn(
    "ConversationExportService.document",
  )(function* (request) {
    const { document: built } = yield* embeddedDocument(request);
    const bundle = built.bundle;
    // The snapshot was redacted before the bundle was built; this second pass
    // covers text the bundle adds, as the Markdown writer's output pass does.
    return {
      bundle: {
        ...bundle,
        metadata: {
          ...bundle.metadata,
          title: redactStoragePaths(bundle.metadata.title, storageRoots),
        },
        markdown: redactStoragePaths(bundle.markdown, storageRoots),
        warnings: redactWarnings(bundle.warnings),
      },
      messageCount: built.messageCount,
    };
  });

  return ConversationExportService.of({ prepare, prepareWordDiagrams, produce, document });
});

export const layer = Layer.effect(ConversationExportService, make);
