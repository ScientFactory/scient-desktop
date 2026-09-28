// @effect-diagnostics nodeBuiltinImport:off -- the staged Markdown bytes are hashed and copied as a file.
/** Adapts Scient conversation Markdown v1 (or an ordinary document) to the existing import lease. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { parseConversationMarkdown } from "@scientfactory/conversation";
import {
  CONVERSATION_SNAPSHOT_FORMAT,
  ConversationSnapshotV1,
  SCIENT_CONVERSATION_MARKDOWN_FORMAT,
  SCIENT_MARKDOWN_DOCUMENT_FORMAT,
  type ConversationImportId,
  type ScientConversationImportPreview,
  type Sha256Digest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

import { stagedAttachmentFile } from "../conversationFile/ScicReader.ts";
import {
  conversationContentDigest,
  conversationImportOmissions,
  ValidatedConversationImport,
} from "./ConversationImporter.ts";

export const MARKDOWN_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

export interface MarkdownReadInput {
  readonly importId: ConversationImportId;
  readonly path: string;
  readonly fileName: string;
  readonly packageSha256: Sha256Digest;
  readonly packageBytes: number;
  readonly attachmentsDirectory: string;
  readonly mode: "messages" | "document";
  readonly receivedAt: string;
}

export interface MarkdownReadResult {
  readonly validated: ValidatedConversationImport;
  readonly kind: "markdown" | "document";
  readonly issues: ScientConversationImportPreview["markdownIssues"];
}

/** A Markdown file Scient refuses to import; `message` is shown to the user. */
export class MarkdownConversationRejection extends Schema.TaggedError<MarkdownConversationRejection>()(
  "MarkdownConversationRejection",
  { message: Schema.String },
) {}

const decodeSnapshot = Schema.decodeUnknownSync(ConversationSnapshotV1);
const decodeValidated = Schema.decodeUnknownSync(ValidatedConversationImport);

/** The uploaded file is the only authority for message text; generated IDs are package-local. */
export function readMarkdownConversation(input: MarkdownReadInput): MarkdownReadResult {
  if (input.packageBytes > MARKDOWN_IMPORT_MAX_BYTES)
    throw new Error("Markdown file is too large.");
  const bytes = NodeFS.readFileSync(input.path);
  if (bytes.byteLength !== input.packageBytes)
    throw new Error("Markdown file changed during preview.");
  const actual = `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== input.packageSha256) throw new Error("Markdown file changed during preview.");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MarkdownConversationRejection({
      message: "This Markdown file is not plain UTF-8 text.",
    });
  }
  const parsed = parseConversationMarkdown(source);
  const document = input.mode === "document" || parsed.kind === "document";
  const title =
    parsed.kind === "conversation" ? parsed.title?.trim() || input.fileName : input.fileName;
  const receivedAt = input.receivedAt;
  const exportedAt =
    parsed.kind === "conversation" &&
    parsed.exported &&
    Number.isFinite(Date.parse(parsed.exported))
      ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(parsed.exported)))
      : receivedAt;
  const selected = parsed.kind === "conversation" && !document ? parsed.messages : [];
  const hasListedAttachments = selected.some((message) =>
    message.parts.some((part) => part.kind === "attachments"),
  );
  const firstTime = selected[0]?.time ?? receivedAt;
  const lastTime = selected.at(-1)?.time ?? receivedAt;
  const attachment = document
    ? {
        localId: "attachment-1",
        kind: "file" as const,
        name: input.fileName,
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength,
        pastedText: false,
        available: true,
      }
    : null;
  if (attachment) {
    NodeFS.mkdirSync(input.attachmentsDirectory, { recursive: true });
    NodeFS.copyFileSync(
      input.path,
      stagedAttachmentFile(input.attachmentsDirectory, input.packageSha256),
    );
  }
  const snapshot = decodeSnapshot({
    format: CONVERSATION_SNAPSHOT_FORMAT,
    version: 1,
    thread: {
      title: title.slice(0, 255),
      createdAt: firstTime,
      updatedAt: lastTime,
      provider: null,
      model: null,
    },
    provenance: { _tag: "original" },
    captured: {
      threadId: `markdown-${input.importId}`,
      snapshotSequence: 0,
      threadSequence: 0,
      capturedAt: receivedAt,
    },
    selection: { workLog: document, reasoning: document, throughMessageId: null },
    messages: document
      ? [
          {
            n: 1,
            id: "markdown-document-1",
            role: "user",
            turnId: null,
            createdAt: receivedAt,
            updatedAt: receivedAt,
            text: "Please use the attached Markdown document as context.",
            attachments: [attachment],
            references: [],
          },
        ]
      : selected.map((message, index) => ({
          n: index + 1,
          id: `markdown-message-${message.n}`,
          role: message.role,
          turnId: message.turn === null ? null : `markdown-turn-${message.turn}`,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(message.time))),
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(message.time))),
          text: [
            message.body,
            ...message.parts
              .filter(
                (part) =>
                  part.kind === "attachments" || part.kind === "context" || part.kind === "answers",
              )
              .map((part) => part.markdown),
          ]
            .filter(Boolean)
            .join("\n\n"),
          attachments: [],
          references: [],
        })),
    reasoning: [],
    workLog: [],
    proposedPlans: [],
    questionAnswers: [],
    omittedRunningTurn: null,
    warnings: [],
    contentDigest: `sha256:${"0".repeat(64)}`,
  });
  const contentDigest = conversationContentDigest(snapshot);
  const completeSnapshot = { ...snapshot, contentDigest };
  const lineCount = source.split("\n").length;
  const issues: Array<ScientConversationImportPreview["markdownIssues"][number]> =
    parsed.kind === "conversation"
      ? parsed.issues.map((issue) => {
          // Issues are not necessarily sorted by line, but message markers are.
          // A binary search avoids rescanning a long transcript for each issue.
          let low = 0;
          let high = parsed.messages.length;
          while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (parsed.messages[middle]!.line <= issue.line) low = middle + 1;
            else high = middle;
          }
          const next = parsed.messages[low];
          return {
            kind: issue.kind,
            startLine: issue.line,
            endLine: Math.max(issue.line, (next?.line ?? lineCount + 1) - 1),
            detail: issue.detail,
          };
        })
      : [];
  if (parsed.kind === "conversation" && parsed.messages.length === 0) {
    issues.push({
      kind: "no-valid-messages",
      startLine: 1,
      endLine: lineCount,
      detail: "No valid Scient message markers were found.",
    });
  }
  const validated = decodeValidated({
    importId: input.importId,
    package: {
      format: document ? SCIENT_MARKDOWN_DOCUMENT_FORMAT : SCIENT_CONVERSATION_MARKDOWN_FORMAT,
      formatVersion: { major: 1, minor: 0 },
      exporter: { name: "Scient Markdown", version: "1" },
      exportId:
        parsed.kind === "conversation" ? parsed.exportValue : input.packageSha256.slice(7, 39),
      exportedAt,
      sourceThreadId: null,
      contentDigest,
      packageSha256: input.packageSha256,
      packageBytes: input.packageBytes,
    },
    snapshot: completeSnapshot,
    attachments: attachment
      ? [
          {
            resourceId: "attachment-1",
            kind: "file",
            name: input.fileName,
            mediaType: "text/plain",
            byteLength: bytes.byteLength,
            sha256: input.packageSha256,
            pastedText: false,
          },
        ]
      : [],
    omissions: conversationImportOmissions(completeSnapshot),
    warnings: hasListedAttachments
      ? [
          {
            _tag: "export-warning",
            warning: {
              code: "resource-unresolved",
              message:
                "Attachment names are kept in the imported text; their file contents are not included.",
            },
          },
        ]
      : [],
  });
  return { validated, kind: document ? "document" : "markdown", issues };
}
