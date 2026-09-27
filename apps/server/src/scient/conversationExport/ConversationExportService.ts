/**
 * Conversation export on the server: capture a snapshot, build its document
 * bundle, write the requested format, and hand back either a temporary file
 * (read through a signed asset by the HTTP layer) or text for the clipboard.
 * Formats this host cannot produce are reported, not attempted.
 */
import {
  CONVERSATION_REFERENCE_URL_PREFIX,
  SCIC_FILE_EXTENSION,
  SCIC_MEDIA_TYPE,
  SCIENT_CONVERSATION_EXPORT_CLIPBOARD_MAX_CHARS,
  SCIENT_CONVERSATION_EXPORT_EXCERPT_MAX_CHARS,
  SCIENT_CONVERSATION_EXPORT_MAX_ASSET_BYTES,
  ScientConversationExportError,
  type ConversationExportFormat,
  type ConversationExportFormatCapability,
  type DocumentWarning,
  type ScientConversationExportPreparation,
  type ScientConversationExportRequest,
  type Sha256Digest,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildConversationDocument,
  packagedAssets,
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

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import { prepareScicPackage } from "../conversationFile/ScicWriter.ts";
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

/** Formats this server produces. PDF and Word register here when they land. */
const FORMAT_CAPABILITIES: ReadonlyArray<ConversationExportFormatCapability> = [
  { format: "markdown", available: true, unavailableReason: null },
  { format: "scic", available: true, unavailableReason: null },
];

export type ProducedExportOutput =
  | {
      readonly _tag: "file";
      readonly path: string;
      readonly fileName: string;
      readonly mediaType: string;
      readonly byteLength: number;
    }
  | { readonly _tag: "text"; readonly text: string };

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
  }
>()("t3/scient/conversationExport/ConversationExportService") {}

const STORAGE_PLACEHOLDER = "«scient-data»";

/**
 * Replaces Scient's own storage locations with a placeholder. User and agent
 * text is exported as written, but Scient never publishes where it keeps data.
 */
function redactStoragePaths(text: string, roots: ReadonlyArray<string>): string {
  let result = text;
  const variants = roots
    .flatMap((root) => {
      const trimmed = root.replace(/[\\/]+$/u, "");
      return trimmed.length > 1 ? [trimmed, trimmed.replace(/\\/gu, "/")] : [];
    })
    .toSorted((left, right) => right.length - left.length);
  for (const root of new Set(variants)) result = result.split(root).join(STORAGE_PLACEHOLDER);
  return result;
}

/** A file name every desktop file system accepts, derived from the conversation title. */
function exportBaseName(title: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+|\.+$/gu, "")
    .slice(0, 100)
    .trim();
  return cleaned.length > 0 ? cleaned : "Conversation";
}

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
  const storageRoots = [config.stateDir, config.baseDir];

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
    const { snapshot } = yield* capture({
      threadId,
      selection: { workLog: true, reasoning: true, throughMessageId: null },
    });
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
    const packaging = request.options.markdownPackaging ?? "text";
    if (
      request.delivery === "clipboard" &&
      (request.format !== "markdown" || packaging !== "text")
    ) {
      return yield* reject("delivery-unsupported", "Only text-only Markdown can be copied.");
    }

    const { snapshot, attachmentFiles } = yield* capture({
      threadId: request.threadId,
      selection: {
        workLog: request.options.includeWorkLog,
        reasoning: request.options.includeReasoning,
        throughMessageId:
          request.options.range._tag === "through-message" ? request.options.range.messageId : null,
      },
    });

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
    const exportId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const exported = DateTime.formatIso(yield* DateTime.now);

    if (request.format === "scic") {
      const prepared = prepareScicPackage({
        snapshot,
        attachments: resolved,
        exportValue,
        exportedAt: exported,
        exporter: { name: "Scient", version: packageJson.version },
        timeZone: request.timeZone ?? "UTC",
        redact: (text) => redactStoragePaths(text, storageRoots),
      });
      if (prepared._tag === "nothing-to-export") {
        return yield* reject(
          "nothing-to-export",
          "This conversation has no completed messages yet.",
        );
      }
      if (prepared._tag === "too-large") {
        return yield* reject(
          "too-large",
          "This conversation is too large for a Scient conversation file. Export a shorter range or leave out the work log.",
        );
      }
      const fileName = `${exportBaseName(snapshot.thread.title)}${SCIC_FILE_EXTENSION}`;
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
      };
    }
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

    const name = exportBaseName(snapshot.thread.title);
    const fileName = packaging === "text" ? `${name}.md` : `${name}.zip`;
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
                { path: `${name}.md`, bytes: new TextEncoder().encode(markdown) },
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

  return ConversationExportService.of({ prepare, produce });
});

export const layer = Layer.effect(ConversationExportService, make);
