/**
 * Conversation export on the server: capture a snapshot, build its document
 * bundle, write the requested format, and hand back either a temporary file
 * (read through a signed asset by the HTTP layer) or text for the clipboard.
 * Formats this host cannot produce are reported, not attempted.
 */
import {
  CONVERSATION_REFERENCE_URL_PREFIX,
  SCIENT_CONVERSATION_EXPORT_CLIPBOARD_MAX_CHARS,
  SCIENT_CONVERSATION_EXPORT_EXCERPT_MAX_CHARS,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  ScientConversationExportError,
  type ConversationExportFormat,
  type ConversationExportFormatCapability,
  type DocumentBundle,
  type DocumentWarning,
  type ScientConversationExportPreparation,
  type ScientConversationExportRequest,
  type Sha256Digest,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildConversationDocument,
  exportFileName,
  packagedAssets,
  redactSnapshotStoragePaths,
  redactStoragePaths,
  writeConversationMarkdown,
  type ResolvedAttachmentContent,
} from "@scientfactory/conversation";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import {
  ConversationExportFiles,
  type ConversationExportFileError,
} from "./ConversationExportFiles.ts";
import {
  ConversationSnapshotService,
  type ConversationSnapshotReadError,
} from "./ConversationSnapshotService.ts";

const MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8";
const ZIP_MEDIA_TYPE = "application/zip";

/**
 * Formats this server produces. Word and `.scic` register here when they land.
 * PDF is captured here and printed by a connected Scient desktop; clients add
 * that requirement to the server's capability.
 */
const FORMAT_CAPABILITIES: ReadonlyArray<ConversationExportFormatCapability> = [
  { format: "markdown", available: true, unavailableReason: null },
  { format: "pdf", available: true, unavailableReason: null },
];

/** Formats `produce` writes on the server; the rest are produced from `document`. */
const SERVER_WRITTEN_FORMATS: ReadonlySet<ConversationExportFormat> = new Set(["markdown"]);

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

const reject = (reason: ScientConversationExportError["reason"], message: string) =>
  Effect.fail(new ScientConversationExportError({ reason, message }));

const make = Effect.gen(function* () {
  const snapshots = yield* ConversationSnapshotService;
  const files = yield* ConversationExportFiles;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  // Both the configured and the resolved spelling (e.g. /var vs /private/var).
  const storageRoots = [config.stateDir, config.baseDir];
  for (const root of [config.stateDir, config.baseDir]) {
    const resolved = yield* fileSystem.realPath(root).pipe(Effect.option);
    if (resolved._tag === "Some") storageRoots.push(resolved.value);
  }

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
      formats: FORMAT_CAPABILITIES,
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
   * Captures the snapshot for the request's options, redacts Scient's storage
   * locations from its structured text, and builds its document.
   */
  const buildDocument = Effect.fn("ConversationExportService.buildDocument")(function* (
    request: ScientConversationExportRequest,
  ) {
    const captured = yield* capture({
      threadId: request.threadId,
      selection: {
        workLog: request.options.includeWorkLog,
        reasoning: request.options.includeReasoning,
        throughMessageId:
          request.options.range._tag === "through-message" ? request.options.range.messageId : null,
      },
    });

    const attachmentFiles = captured.attachmentFiles;
    // Redact structured text before any writer escapes it.
    const snapshot = redactSnapshotStoragePaths(captured.snapshot, storageRoots);

    // Read attachment bytes once, bounded in total; the document is pure.
    const resolved = new Map<string, ResolvedAttachmentContent>();
    let totalBytes = 0;
    for (const [localId, path] of attachmentFiles) {
      const bytes = yield* fileSystem.readFile(path).pipe(Effect.option);
      if (bytes._tag === "None") {
        resolved.set(localId, { _tag: "unavailable", reason: "unreadable" });
        continue;
      }
      if (totalBytes + bytes.value.byteLength > SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES) {
        resolved.set(localId, { _tag: "unavailable", reason: "too-large" });
        continue;
      }
      totalBytes += bytes.value.byteLength;
      const digest = yield* crypto.digest("SHA-256", bytes.value).pipe(Effect.option);
      resolved.set(
        localId,
        digest._tag === "None"
          ? { _tag: "unavailable", reason: "unreadable" }
          : {
              _tag: "bytes",
              bytes: bytes.value,
              sha256: `sha256:${Encoding.encodeHex(digest.value)}`,
            },
      );
    }

    const exportValue = Encoding.encodeHex(yield* crypto.randomBytes(6).pipe(Effect.orDie));
    const document = buildConversationDocument({
      snapshot,
      exportValue,
      timeZone: request.timeZone ?? "UTC",
      resolveAttachment: (attachment) =>
        resolved.get(attachment.localId) ?? { _tag: "unavailable", reason: "missing" },
    });
    if (document.messageCount === 0) {
      return yield* reject("nothing-to-export", "This conversation has no completed messages yet.");
    }
    return { snapshot, document: { ...document, exportValue } };
  });

  const produce: ConversationExportService["Service"]["produce"] = Effect.fn(
    "ConversationExportService.produce",
  )(function* (request) {
    const capability = FORMAT_CAPABILITIES.find((entry) => entry.format === request.format);
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
    if (request.delivery === "clipboard" && packaging !== "text") {
      return yield* reject("delivery-unsupported", "Only text-only Markdown can be copied.");
    }
    const { snapshot, document } = yield* buildDocument(request);
    const exportValue = document.exportValue;
    const exportId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const exported = DateTime.formatIso(yield* DateTime.now);
    const markdown = redactStoragePaths(
      writeConversationMarkdown({ bundle: document.bundle, exportValue, exported, packaging }),
      storageRoots,
    );
    const warnings = document.bundle.warnings.map((warning) => ({
      ...warning,
      message: redactStoragePaths(warning.message, storageRoots),
    }));
    const base = {
      exportId,
      format: request.format,
      contentDigest: snapshot.contentDigest,
      messageCount: document.messageCount,
      warnings,
    };

    if (request.delivery === "clipboard") {
      if (markdown.length > SCIENT_CONVERSATION_EXPORT_CLIPBOARD_MAX_CHARS) {
        return yield* reject(
          "too-large",
          "This conversation is too long to copy. Save it as a file instead.",
        );
      }
      return { ...base, output: { _tag: "text", text: markdown } };
    }

    const fileName = exportFileName(snapshot.thread.title, packaging === "text" ? ".md" : ".zip");
    const markdownName = exportFileName(snapshot.thread.title, ".md");
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
                ...packagedAssets(document.bundle),
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
    };
  });

  const document: ConversationExportService["Service"]["document"] = Effect.fn(
    "ConversationExportService.document",
  )(function* (request) {
    const built = yield* buildDocument(request);
    const bundle = built.document.bundle;
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
        warnings: bundle.warnings.map((warning) => ({
          ...warning,
          message: redactStoragePaths(warning.message, storageRoots),
        })),
      },
      messageCount: built.document.messageCount,
    };
  });

  return ConversationExportService.of({ prepare, produce, document });
});

export const layer = Layer.effect(ConversationExportService, make);
