/**
 * Conversation snapshot → document bundle. Writes each message under a
 * speaker heading with its timestamp, applies chat's line-break and raw-HTML
 * decisions per message, resolves inline references to readable Markdown,
 * lists attachments with their availability, and places the selected work log
 * and reasoning with the message chat shows them under.
 *
 * The bundle Markdown is Scient conversation Markdown v1 without front matter:
 * readable-output writers share it, and the Markdown writer adds front matter
 * and resolves `scient-asset:` destinations.
 */
import {
  CONVERSATION_REFERENCE_URL_PREFIX,
  DOCUMENT_ASSET_URL_PREFIX,
  type ConversationAttachment,
  type ConversationInlineReference,
  type ConversationMessage,
  type ConversationQuestionAnswer,
  type ConversationSnapshotV1,
  type ConversationSnapshotWarning,
  type ConversationWorkLogEntry,
  type DocumentAsset,
  type DocumentAssetUnavailableReason,
  type DocumentBundle,
  type DocumentCitation,
  type DocumentWarning,
  type OrchestrationConversationImportOmission,
  type Sha256Digest,
  type TurnId,
} from "@t3tools/contracts";
import type { Link } from "mdast";

import {
  formatMessageMarker,
  formatPartMarker,
  formatSpeakerHeading,
  messageNamespace,
  type MarkdownMessageRole,
  type MarkdownPartKind,
} from "./conversationMarkdown.ts";
import {
  applyEdits,
  escapeHtmlText,
  escapeMarkdownText,
  fencedBlock,
  longestRun,
  nodeRange,
  parseMarkdown,
  visitNodes,
  type SourceEdit,
} from "./markdownAst.ts";
import { truncateUtf8, warningValue } from "./boundedText.ts";
import { scanHtmlStartTags } from "./htmlTags.ts";
import { writeMessageBody } from "./messageBody.ts";
import {
  deriveTerminalAssistantMessageIds,
  deriveTurnFolds,
  shouldPreserveAssistantLineBreaks,
  timelineEntryTurnId,
  type GroupingTimelineEntry,
} from "./workLogGrouping.ts";

export type ResolvedAttachmentContent =
  | { readonly _tag: "bytes"; readonly bytes: Uint8Array; readonly sha256: Sha256Digest }
  | { readonly _tag: "unavailable"; readonly reason: DocumentAssetUnavailableReason };

/**
 * An available attachment whose bytes stay outside the bundle: a text-only
 * export lists it by name and size without reading it, and a packaging writer
 * copies it into the package itself. `sha256` is set when that writer needs it.
 */
export interface ExternalAttachmentContent {
  readonly _tag: "external";
  readonly byteLength: number;
  readonly sha256: Sha256Digest | null;
}

/** A bundle asset; an `external` one names the attachment a packaging writer copies. */
export type ConversationDocumentAsset = Omit<DocumentAsset, "content"> & {
  readonly content:
    | DocumentAsset["content"]
    | {
        readonly _tag: "external";
        readonly localId: string;
        readonly sha256: Sha256Digest | null;
      };
};

/** A document bundle whose assets may keep their bytes outside it. */
export type ConversationDocumentBundle = Omit<DocumentBundle, "assets"> & {
  readonly assets: ReadonlyArray<ConversationDocumentAsset>;
};

export interface ConversationDocumentInput<Content = ResolvedAttachmentContent> {
  readonly snapshot: ConversationSnapshotV1;
  /** The per-export value every structure marker carries. */
  readonly exportValue: string;
  /** IANA zone for speaker headings; UTC when unknown. */
  readonly timeZone: string;
  readonly resolveAttachment: (attachment: ConversationAttachment) => Content;
}

export interface ConversationDocument<Bundle = DocumentBundle> {
  readonly bundle: Bundle;
  /** Messages written into the document, which the Markdown markers number. */
  readonly messageCount: number;
}

interface WorkItem {
  readonly turnId: TurnId | null;
  readonly tone: string;
  readonly sourceActivityKind?: string;
  readonly questionAnswer?: ConversationQuestionAnswer;
  readonly entry: ConversationWorkLogEntry | null;
}

type Entry = GroupingTimelineEntry<WorkItem>;

interface Attached {
  readonly plans: Array<ConversationSnapshotV1["proposedPlans"][number]>;
  readonly answers: ConversationQuestionAnswer[];
  readonly work: ConversationWorkLogEntry[];
  readonly reasoning: Array<ConversationSnapshotV1["reasoning"][number]>;
  workTurns: Set<TurnId>;
}

const MARKDOWN_ROLE: Record<string, MarkdownMessageRole | undefined> = {
  user: "user",
  assistant: "assistant",
};

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Longest package file name, so `attachments/NN-<name>` stays within every file system's limit. */
const PACKAGE_NAME_MAX_BYTES = 160;

/** A package file name: letters, digits, `.`, `_`, `-`, cut on code points and bounded in bytes. */
function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "");
  const extensionIndex = cleaned.lastIndexOf(".");
  const extension =
    extensionIndex > 0
      ? truncateUtf8(cleaned.slice(extensionIndex), 64, 16).replace(/[-.]+$/u, "")
      : "";
  const stem = truncateUtf8(
    extensionIndex > 0 ? cleaned.slice(0, extensionIndex) : cleaned,
    PACKAGE_NAME_MAX_BYTES - new TextEncoder().encode(extension).byteLength,
    80,
  ).replace(/[-.]+$/u, "");
  return `${stem || "attachment"}${extension}`;
}

function inlineCode(text: string): string {
  const fence = "`".repeat(longestRun(text, "`") + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded.replace(/\r?\n/gu, " ")}${fence}`;
}

function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * A snapshot warning as the file states it. `fileNumber` maps a snapshot
 * message number to the number the file shows, or null for a message the file
 * leaves out (system messages, answers folded into their question).
 */
function warningMessage(
  warning: ConversationSnapshotWarning,
  fileNumber: (snapshotN: number) => number | null,
): DocumentWarning {
  const where = (messageN: number | null) => {
    const n = messageN === null ? null : fileNumber(messageN);
    return n === null ? "" : ` in message ${n}`;
  };
  switch (warning._tag) {
    case "running-turn-omitted":
      return {
        code: "running-turn-omitted",
        message: "The current turn was still running and is not included.",
      };
    case "attachment-unavailable":
      return {
        code: "attachment-unavailable",
        message: `Attachment “${warningValue(warning.name)}”${where(warning.messageN)} was unavailable and is listed by name only.`,
      };
    case "attachment-unsupported":
      return {
        code: "attachment-unsupported",
        message: `Attachment “${warningValue(warning.name)}”${where(warning.messageN)} has a type Scient cannot display; it is included as a file.`,
      };
    case "records-skipped": {
      const what =
        warning.kind === "activity"
          ? "work-log records"
          : warning.kind === "question-answer"
            ? "question answers"
            : "inline references";
      return {
        code: "records-skipped",
        message: `${warning.count} ${what} could not be read and ${warning.count === 1 ? "was" : "were"} left out.`,
      };
    }
  }
}

const SHIFT_UNITS = [
  { ms: 86_400_000, one: "day", many: "days" },
  { ms: 3_600_000, one: "hour", many: "hours" },
  { ms: 60_000, one: "minute", many: "minutes" },
  { ms: 1_000, one: "second", many: "seconds" },
] as const;

/**
 * The sentence the import notice and every readable export use when an
 * import moved its times back (`timesShiftedMs`). The move is given in its
 * two largest units, such as "1 day 36 seconds".
 */
export function importTimesShiftedNotice(timesShiftedMs: number): string {
  let rest = timesShiftedMs;
  const parts: string[] = [];
  for (const unit of SHIFT_UNITS) {
    const count = Math.floor(rest / unit.ms);
    rest -= count * unit.ms;
    if (count > 0) parts.push(`${count} ${count === 1 ? unit.one : unit.many}`);
  }
  const shift = parts.length === 0 ? "less than a second" : parts.slice(0, 2).join(" ");
  return `Times are shown ${shift} earlier than in the file, because the file's times were later than the moment it was imported.`;
}

/** The shown times differ from the file's; readable exports say so, as the thread does. */
function timesShiftedWarning(timesShiftedMs: number | undefined): ReadonlyArray<DocumentWarning> {
  return timesShiftedMs === undefined || timesShiftedMs <= 0
    ? []
    : [{ code: "times-shifted", message: importTimesShiftedNotice(timesShiftedMs) }];
}

function sourceOmissionWarning(omission: OrchestrationConversationImportOmission): DocumentWarning {
  const message = (() => {
    switch (omission._tag) {
      case "work-log-excluded":
        return "An earlier transfer excluded the work log; it is not available in this conversation.";
      case "reasoning-excluded":
        return "An earlier transfer excluded reasoning; it is not available in this conversation.";
      case "range-truncated":
        return `An earlier transfer stopped at message ${omission.throughMessageN}; later source messages may be missing.`;
      case "running-turn-omitted":
        return "An earlier transfer omitted a turn that was still running.";
      case "attachments-unavailable":
        return `An earlier transfer lacked ${omission.count} attachment${omission.count === 1 ? "" : "s"}.`;
      case "records-skipped":
        return `An earlier transfer skipped ${omission.count} record${omission.count === 1 ? "" : "s"}.`;
    }
  })();
  return { code: "source-history-incomplete", message };
}

/** The same caution the export dialog shows, kept with the file it applies to. */
function sensitiveContentWarning(
  selection: ConversationSnapshotV1["selection"],
): ReadonlyArray<DocumentWarning> {
  const included = [
    selection.workLog ? "the work log" : null,
    selection.reasoning ? "reasoning" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" and ");
  return included.length === 0
    ? []
    : [
        {
          code: "sensitive-content-included",
          message: `This export includes ${included}, which can contain file paths, command output, and secrets.`,
        },
      ];
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "in-progress":
      return "in progress";
    case null:
      return "";
    default:
      return status;
  }
}

function renderWorkEntry(entry: ConversationWorkLogEntry): string {
  const lines: string[] = [];
  const detail = (value: { readonly text: string } | null) =>
    value === null ? [] : [indent(escapeMarkdownText(value.text))];
  switch (entry._tag) {
    case "tool": {
      const status = statusLabel(entry.status);
      lines.push(`- **${escapeMarkdownText(entry.title)}**${status ? ` · ${status}` : ""}`);
      if (entry.toolName !== null && entry.toolName !== entry.title)
        lines.push(indent(`Tool: ${inlineCode(entry.toolName)}`));
      if (entry.command !== null) lines.push(indent(fencedBlock(entry.command.text, "sh")));
      lines.push(...detail(entry.detail));
      if (entry.changedFiles.length > 0) {
        const more = entry.omittedChangedFiles > 0 ? ` and ${entry.omittedChangedFiles} more` : "";
        lines.push(indent(`Files: ${entry.changedFiles.map(inlineCode).join(", ")}${more}`));
      }
      if (entry.output !== null) lines.push(indent(fencedBlock(entry.output.text)));
      break;
    }
    case "task": {
      const status = statusLabel(entry.status);
      const role = entry.agentRole === null ? "" : ` · ${escapeMarkdownText(entry.agentRole)}`;
      lines.push(
        `- **Task: ${escapeMarkdownText(entry.title)}**${status ? ` · ${status}` : ""}${role}`,
      );
      lines.push(...detail(entry.detail));
      break;
    }
    case "notice": {
      const level =
        entry.level === "error" ? "Error" : entry.level === "warning" ? "Warning" : "Note";
      lines.push(`- **${level}: ${escapeMarkdownText(entry.title)}**`);
      lines.push(...detail(entry.detail));
      break;
    }
    case "compaction":
      lines.push(`- *${escapeMarkdownText(entry.title)}*`);
      break;
    case "plan-steps": {
      lines.push("- **Plan**");
      if (entry.explanation !== null) lines.push(...detail(entry.explanation));
      for (const step of entry.steps) {
        const progress = step.status === "in-progress" ? " *(in progress)*" : "";
        lines.push(
          indent(
            `- [${step.status === "completed" ? "x" : " "}] ${escapeMarkdownText(step.step)}${progress}`,
          ),
        );
      }
      if (entry.omittedSteps > 0) lines.push(indent(`- … ${entry.omittedSteps} more steps`));
      break;
    }
  }
  return lines.join("\n");
}

function workLogStepCount(entries: ReadonlyArray<ConversationWorkLogEntry>): string {
  return `${entries.length} ${entries.length === 1 ? "step" : "steps"}`;
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${escapeHtmlText(summary)}</summary>\n\n${body}\n\n</details>`;
}

/**
 * Builds the document bundle. Deterministic for a given snapshot, export
 * value, zone, and resolved attachment content. With attachment bytes only,
 * the bundle is a `DocumentBundle` any readable writer takes; with `external`
 * content it is for the Markdown and conversation-file writers.
 */
export function buildConversationDocument(input: ConversationDocumentInput): ConversationDocument;
export function buildConversationDocument(
  input: ConversationDocumentInput<ResolvedAttachmentContent | ExternalAttachmentContent>,
): ConversationDocument<ConversationDocumentBundle>;
export function buildConversationDocument(
  input: ConversationDocumentInput<ResolvedAttachmentContent | ExternalAttachmentContent>,
): ConversationDocument<ConversationDocumentBundle> {
  const { snapshot, exportValue } = input;
  const answeredRequestIds = new Set(snapshot.questionAnswers.map((answer) => answer.id));
  // Chat shows a folded question answer instead of its "async-answer" message.
  const exported = snapshot.messages.filter(
    (message) =>
      MARKDOWN_ROLE[message.role] !== undefined &&
      !(
        message.role === "user" &&
        message.id.startsWith("async-answer:") &&
        answeredRequestIds.has(message.id.slice("async-answer:".length))
      ),
  );

  // Warnings name messages by the numbers the file shows. An answer's
  // attachments are reported once, with the answer, not again for the
  // folded message that carried them.
  const fileNumberBySnapshotN = new Map(exported.map((message, index) => [message.n, index + 1]));
  const foldedAnswerNumbers = new Set(
    snapshot.messages
      .filter(
        (message) =>
          message.id.startsWith("async-answer:") &&
          answeredRequestIds.has(message.id.slice("async-answer:".length)),
      )
      .map((message) => message.n),
  );
  const unavailableAnswerNames = new Set(
    snapshot.questionAnswers.flatMap((answer) =>
      answer.items.flatMap((item) =>
        item.attachments
          .filter((attachment) => !attachment.available)
          .map((attachment) => attachment.name),
      ),
    ),
  );
  const snapshotWarnings = snapshot.warnings.filter(
    (warning) =>
      !(
        (warning._tag === "attachment-unavailable" || warning._tag === "attachment-unsupported") &&
        warning.messageN !== null &&
        foldedAnswerNumbers.has(warning.messageN) &&
        unavailableAnswerNames.has(warning.name)
      ),
  );
  const warnings: DocumentWarning[] = [
    ...sensitiveContentWarning(snapshot.selection),
    ...snapshotWarnings.map((warning) =>
      warningMessage(warning, (n) => fileNumberBySnapshotN.get(n) ?? null),
    ),
    ...(snapshot.provenance._tag === "import"
      ? (snapshot.provenance.omissions ?? []).map(sourceOmissionWarning)
      : snapshot.provenance._tag === "fork"
        ? (snapshot.provenance.sourceImport?.omissions ?? []).map(sourceOmissionWarning)
        : []),
    ...timesShiftedWarning(
      snapshot.provenance._tag === "import"
        ? snapshot.provenance.timesShiftedMs
        : snapshot.provenance._tag === "fork"
          ? snapshot.provenance.sourceImport?.timesShiftedMs
          : undefined,
    ),
  ];
  const assets: ConversationDocumentAsset[] = [];
  const citations: DocumentCitation[] = [];
  const assetIdByLocalId = new Map<string, string>();

  const registerAsset = (
    attachment: ConversationAttachment,
    id: string,
  ): ConversationDocumentAsset => {
    const content = attachment.available
      ? input.resolveAttachment(attachment)
      : ({ _tag: "unavailable", reason: "missing" } as const);
    if (attachment.available && content._tag === "unavailable") {
      warnings.push({
        code: "attachment-unavailable",
        message: `Attachment “${warningValue(attachment.name)}” ${content.reason === "too-large" ? "is too large to include" : "could not be read"} and is listed by name only.`,
      });
    }
    const asset: ConversationDocumentAsset = {
      id,
      role: attachment.kind === "image" ? "image" : "attachment",
      fileName: attachment.name,
      mediaType: attachment.mimeType,
      byteLength:
        content._tag === "bytes"
          ? content.bytes.byteLength
          : content._tag === "external"
            ? content.byteLength
            : attachment.sizeBytes,
      packagePath: `attachments/${String(assets.length + 1).padStart(2, "0")}-${safeFileName(attachment.name)}`,
      content:
        content._tag === "bytes"
          ? { _tag: "bytes", bytes: content.bytes, sha256: content.sha256 }
          : content._tag === "external"
            ? { _tag: "external", localId: attachment.localId, sha256: content.sha256 }
            : { _tag: "unavailable", reason: content.reason },
    };
    assets.push(asset);
    assetIdByLocalId.set(attachment.localId, id);
    return asset;
  };

  // Timeline in chat's order: by time, messages before plans before work on ties.
  const timeline: Entry[] = [
    ...exported.map((message): Entry => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message: { ...message, streaming: false },
    })),
    ...snapshot.reasoning.map((reasoning): Entry => ({
      id: reasoning.id,
      kind: "message",
      createdAt: reasoning.createdAt,
      message: { ...reasoning, role: "reasoning", streaming: false },
    })),
    ...snapshot.proposedPlans.map((plan): Entry => ({
      id: `plan:${plan.id}`,
      kind: "proposed-plan",
      createdAt: plan.createdAt,
      proposedPlan: { turnId: plan.turnId },
    })),
    ...snapshot.questionAnswers.map((answer): Entry => ({
      id: `answer:${answer.id}`,
      kind: "work",
      createdAt: answer.createdAt,
      entry: { turnId: answer.turnId, tone: "tool", questionAnswer: answer, entry: null },
    })),
    ...snapshot.workLog.map((entry): Entry => ({
      id: `work:${entry.id}`,
      kind: "work",
      createdAt: entry.createdAt,
      entry: {
        turnId: entry.turnId,
        tone: entry._tag === "notice" && entry.level === "error" ? "error" : "tool",
        ...(entry._tag === "compaction" ? { sourceActivityKind: "context-compaction" } : {}),
        entry,
      },
    })),
  ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  const terminalIds = deriveTerminalAssistantMessageIds(timeline);
  const folds = deriveTurnFolds({
    timelineEntries: timeline,
    terminalAssistantMessageIds: terminalIds,
    latestTurn: null,
    unfoldedTurnIds: new Set(),
    workIndicatesFailure: (item) =>
      (item.entry?._tag === "tool" || item.entry?._tag === "task") &&
      item.entry.status === "failed",
  });
  const foldLabelByTurn = new Map([...folds.values()].map((fold) => [fold.turnId, fold.label]));

  const exportedIds = new Set<string>(exported.map((message) => message.id));
  const terminalByTurn = new Map<TurnId, string>();
  for (const entry of timeline) {
    if (entry.kind === "message" && terminalIds.has(entry.message.id) && entry.message.turnId)
      terminalByTurn.set(entry.message.turnId, entry.message.id);
  }
  const attached = new Map<string, Attached>(
    exported.map((message) => [
      message.id,
      { plans: [], answers: [], work: [], reasoning: [], workTurns: new Set() },
    ]),
  );
  const planByEntryId = new Map(snapshot.proposedPlans.map((plan) => [`plan:${plan.id}`, plan]));
  const reasoningById = new Map<string, ConversationSnapshotV1["reasoning"][number]>(
    snapshot.reasoning.map((reasoning) => [reasoning.id, reasoning]),
  );
  let previousMessageId: string | null = null;
  const pending: Entry[] = [];
  const attach = (entry: Entry, ownerId: string) => {
    const owner = attached.get(ownerId)!;
    if (entry.kind === "proposed-plan") {
      const plan = planByEntryId.get(entry.id);
      if (plan) owner.plans.push(plan);
    } else if (entry.kind === "work") {
      if (entry.entry.questionAnswer) owner.answers.push(entry.entry.questionAnswer);
      if (entry.entry.entry) {
        owner.work.push(entry.entry.entry);
        if (entry.entry.turnId) owner.workTurns.add(entry.entry.turnId);
      }
    } else if (entry.kind === "message" && entry.message.role === "reasoning") {
      const reasoning = reasoningById.get(entry.id);
      if (reasoning) owner.reasoning.push(reasoning);
    }
  };
  for (const entry of timeline) {
    if (entry.kind === "message" && exportedIds.has(entry.message.id)) {
      previousMessageId = entry.message.id;
      for (const early of pending.splice(0)) attach(early, entry.message.id);
      continue;
    }
    const turnId = timelineEntryTurnId(entry);
    const terminal = turnId === null ? undefined : terminalByTurn.get(turnId);
    const owner = terminal ?? previousMessageId;
    if (owner === null) pending.push(entry);
    else attach(entry, owner);
  }

  // Each run of a turn's messages gets its own ordinal: the reader requires a
  // turn's messages to be contiguous, so a turn that returns after another
  // one continues as a new turn in the file. Turnless messages (prompts and
  // steering) do not end a run.
  const turnOrdinalByMessage = new Map<string, number>();
  let runTurn: TurnId | null = null;
  let runs = 0;
  for (const message of exported) {
    if (message.turnId === null) continue;
    if (message.turnId !== runTurn) {
      runTurn = message.turnId;
      runs += 1;
    }
    turnOrdinalByMessage.set(message.id, runs);
  }

  const sections: string[] = [];
  for (const [index, message] of exported.entries()) {
    const n = index + 1;
    const role = MARKDOWN_ROLE[message.role]!;
    const namespace = messageNamespace(n);
    const owner = attached.get(message.id)!;
    const part = (kind: MarkdownPartKind, content: string) =>
      `${formatPartMarker({ exportValue, kind })}\n${content}`;
    const blocks: string[] = [
      `${formatMessageMarker({
        exportValue,
        n,
        role,
        time: message.createdAt,
        turn: turnOrdinalByMessage.get(message.id) ?? null,
      })}\n${formatSpeakerHeading({ role, time: message.createdAt, timeZone: input.timeZone })}`,
    ];

    const messageAssets = message.attachments.map((attachment, attachmentIndex) =>
      registerAsset(attachment, `m${n}-a${attachmentIndex + 1}`),
    );
    const contextDetails: string[] = [];
    const unresolvedImage = (alt: string) =>
      warnings.push({
        code: "resource-unresolved",
        message: `Image “${warningValue(alt) || "untitled"}” in message ${n} refers to a file on the original computer and is not included.`,
      });
    const bodySource = replaceLocalImages(
      renderReferences(message, {
        assetIdByLocalId,
        citations,
        contextDetails,
      }),
      unresolvedImage,
      role === "assistant",
    );
    const text =
      bodySource.trim().length === 0 &&
      role === "assistant" &&
      !messageAssets.some((asset) => asset.role === "image")
        ? "(empty response)"
        : bodySource;
    const written = writeMessageBody(text, {
      namespace,
      preserveLineBreaks: role === "user" || shouldPreserveAssistantLineBreaks(text),
      rawHtml: role === "user" ? "literal" : "render",
    });
    if (written.containedAsLiteral) {
      warnings.push({
        code: "unsupported-construct",
        message: `Message ${n} could not be kept as formatted Markdown and is included as literal text.`,
      });
    }
    if (written.markdown.length > 0) blocks.push(written.markdown);

    if (messageAssets.length > 0) {
      blocks.push(
        part("attachments", `**Attachments**\n\n${messageAssets.map(assetListItem).join("\n")}`),
      );
    }
    if (contextDetails.length > 0) {
      blocks.push(part("context", `**Context**\n\n${contextDetails.join("\n")}`));
    }
    for (const [planIndex, plan] of owner.plans.entries()) {
      const planBody = writeMessageBody(replaceLocalImages(plan.markdown, unresolvedImage, true), {
        namespace: `${namespace}p${planIndex + 1}-`,
        preserveLineBreaks: false,
        rawHtml: "render",
      });
      blocks.push(
        part(
          "plan",
          `**Proposed plan**${plan.implemented ? " · implemented" : ""}\n\n${planBody.markdown}`,
        ),
      );
    }
    if (owner.answers.length > 0) {
      const answers = owner.answers.flatMap((answer, answerIndex) =>
        answer.items.map((item, itemIndex) => {
          const lines: string[] = [];
          if (item.question !== null) lines.push(`**Q:** ${escapeMarkdownText(item.question)}`);
          lines.push(`**A:** ${escapeMarkdownText(item.answer || "(no text)")}`);
          const itemAssets = item.attachments.map((attachment, attachmentIndex) =>
            registerAsset(
              attachment,
              `m${n}-q${answerIndex + 1}-${itemIndex + 1}-a${attachmentIndex + 1}`,
            ),
          );
          const answerBlock = lines.join("\\\n");
          return itemAssets.length > 0
            ? `${answerBlock}\n\n${itemAssets.map(assetListItem).join("\n")}`
            : answerBlock;
        }),
      );
      blocks.push(part("answers", `**Questions and answers**\n\n${answers.join("\n\n")}`));
    }
    if (owner.work.length > 0) {
      const foldLabel = [...owner.workTurns]
        .map((turnId) => foldLabelByTurn.get(turnId))
        .find((label) => label !== undefined);
      const summary = `Work log · ${workLogStepCount(owner.work)}${foldLabel ? ` · ${foldLabel}` : ""}`;
      blocks.push(part("work-log", details(summary, owner.work.map(renderWorkEntry).join("\n"))));
    }
    if (owner.reasoning.length > 0) {
      const bodies = owner.reasoning.map(
        (reasoning, reasoningIndex) =>
          writeMessageBody(replaceLocalImages(reasoning.text, unresolvedImage, true), {
            namespace: `${namespace}r${reasoningIndex + 1}-`,
            preserveLineBreaks: true,
            rawHtml: "render",
          }).markdown,
      );
      blocks.push(part("reasoning", details("Reasoning", bodies.join("\n\n"))));
    }
    sections.push(blocks.join("\n\n"));
  }

  const metadata = [
    `${exported.length} ${exported.length === 1 ? "message" : "messages"}`,
    snapshot.thread.provider,
    snapshot.thread.model,
    snapshot.provenance._tag === "fork"
      ? snapshot.provenance.sourceImport === undefined
        ? "forked conversation"
        : "forked conversation with imported history (unverified)"
      : snapshot.provenance._tag === "import"
        ? `imported from ${snapshot.provenance.source === "scic" ? "a Scient conversation file" : "Markdown"} (unverified)`
        : null,
  ].filter((value): value is string => value !== null);
  // Two attachments with one name in one message would say the same thing twice.
  const notes = [
    ...new Map(
      warnings.map((warning) => [`${warning.code}\n${warning.message}`, warning]),
    ).values(),
  ];
  const preamble = [
    `# ${escapeMarkdownText(snapshot.thread.title)}`,
    `*Exported from Scient · ${metadata.map(escapeMarkdownText).join(" · ")}*`,
    ...(notes.length > 0
      ? [
          `**Export notes**\n\n${notes.map((warning) => `- ${escapeMarkdownText(warning.message)}`).join("\n")}`,
        ]
      : []),
  ];

  return {
    bundle: {
      markdown: `${[...preamble, ...sections].join("\n\n")}\n`,
      profile: "chat",
      metadata: {
        title: snapshot.thread.title,
        language: null,
        direction: "auto",
        createdAt: snapshot.thread.createdAt,
        source: {
          _tag: "conversation",
          threadId: snapshot.captured.threadId,
          contentDigest: snapshot.contentDigest,
          snapshotSequence: snapshot.captured.snapshotSequence,
        },
      },
      assets,
      citations,
      warnings: notes,
    },
    messageCount: exported.length,
  };
}

const REMOTE_IMAGE_URL = /^(?:https?:|data:image\/|\/\/)/iu;

function isLocalImageUrl(url: string): boolean {
  return (
    url.trim().length > 0 &&
    !url.startsWith(DOCUMENT_ASSET_URL_PREFIX) &&
    !REMOTE_IMAGE_URL.test(url)
  );
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/giu, (entity, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower] ?? entity;
  });
}

/**
 * Images a message points at by a path on the original computer (for example
 * `![Plot](./figures/plot.png)`, or `<img src="./plot.png">` where raw HTML is
 * rendered) cannot travel with the export. Each becomes a labelled placeholder
 * and reports itself; remote and bundle images stay.
 */
function replaceLocalImages(
  source: string,
  onUnresolved: (alt: string) => void,
  rendersHtml: boolean,
): string {
  if (!source.includes("![") && !(rendersHtml && /<img/iu.test(source))) return source;
  const root = parseMarkdown(source);
  const definitions = new Map<string, string>();
  visitNodes(root, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  });
  const edits: SourceEdit[] = [];
  visitNodes(root, (node) => {
    if (node.type === "html") {
      if (!rendersHtml) return;
      const range = nodeRange(node);
      if (!range) return;
      const html = source.slice(range.start, range.end);
      for (const tag of scanHtmlStartTags(html)) {
        const src = tag.attributes.get("src");
        if (tag.name !== "img" || src === undefined) continue;
        if (!isLocalImageUrl(decodeHtmlEntities(src))) continue;
        const alt = decodeHtmlEntities(tag.attributes.get("alt") ?? "");
        onUnresolved(alt);
        edits.push({
          start: range.start + tag.start,
          end: range.start + tag.end,
          text: `<em>[Image not included${alt ? `: ${escapeHtmlText(alt)}` : ""}]</em>`,
        });
      }
      return;
    }
    const url =
      node.type === "image"
        ? node.url
        : node.type === "imageReference"
          ? definitions.get(node.identifier)
          : undefined;
    if (url === undefined || !isLocalImageUrl(url)) return;
    const range = nodeRange(node);
    if (!range) return;
    const alt = "alt" in node ? (node.alt ?? "") : "";
    onUnresolved(alt);
    edits.push({
      start: range.start,
      end: range.end,
      text: `*\\[Image not included${alt ? `: ${escapeMarkdownText(alt)}` : ""}\\]*`,
    });
  });
  return applyEdits(source, edits);
}

function assetListItem(asset: ConversationDocumentAsset): string {
  const name = escapeMarkdownText(asset.fileName);
  if (asset.content._tag === "unavailable") return `- ${name} · unavailable`;
  const link = `${asset.role === "image" ? "!" : ""}[${name}](${DOCUMENT_ASSET_URL_PREFIX}${asset.id})`;
  return `- ${link} · ${escapeMarkdownText(asset.mediaType)}, ${formatBytes(asset.byteLength)}`;
}

/**
 * A snapshot message's text as an imported thread stores it. A transfer file
 * carries inline references as typed display fields, not as the composer
 * context chips they came from, so they become the same readable Markdown the
 * document export writes: quotes as block quotations with their source,
 * attachments by name (the files stay attached to the message), and other
 * context by label, with its details listed after the text.
 */
export function importedMessageMarkdown(message: ConversationMessage): string {
  if (!message.text.includes(CONVERSATION_REFERENCE_URL_PREFIX)) return message.text;
  const contextDetails: string[] = [];
  const text = renderReferences(message, {
    assetIdByLocalId: new Map(),
    citations: [],
    contextDetails,
  });
  return contextDetails.length === 0
    ? text
    : `${text}\n\n**Context**\n\n${contextDetails.join("\n")}`;
}

/**
 * Replaces `scient-ref:` links with readable Markdown. Quotes become block
 * quotations with their source; attachments point at bundle assets; other
 * context shows its label inline and its details in the message's context part.
 * A link to `scient-asset:` in a message is neutralized so only generated
 * links can address bundle assets.
 */
function renderReferences(
  message: ConversationMessage,
  sink: {
    readonly assetIdByLocalId: ReadonlyMap<string, string>;
    readonly citations: DocumentCitation[];
    readonly contextDetails: string[];
  },
): string {
  const source = message.text.replace(/\r\n?/gu, "\n");
  if (
    !source.includes(CONVERSATION_REFERENCE_URL_PREFIX) &&
    !source.includes(DOCUMENT_ASSET_URL_PREFIX)
  )
    return source;
  const referencesById = new Map(message.references.map((reference) => [reference.id, reference]));
  const root = parseMarkdown(source);
  const edits: SourceEdit[] = [];
  visitNodes(root, (node) => {
    if (node.type !== "link" && node.type !== "image" && node.type !== "definition") return;
    const range = nodeRange(node);
    if (!range) return;
    const url = (node as Link).url;
    if (url.startsWith(DOCUMENT_ASSET_URL_PREFIX)) {
      const at = source.lastIndexOf(DOCUMENT_ASSET_URL_PREFIX, range.end);
      if (at >= range.start)
        edits.push({
          start: at + "scient-asset".length,
          end: at + "scient-asset:".length,
          text: "%3A",
        });
      return;
    }
    if (node.type === "definition" || !url.startsWith(CONVERSATION_REFERENCE_URL_PREFIX)) return;
    const reference = referencesById.get(url.slice(CONVERSATION_REFERENCE_URL_PREFIX.length));
    edits.push({
      start: range.start,
      end: range.end,
      text: reference === undefined ? escapeMarkdownText(url) : renderReference(reference, sink),
    });
  });
  return applyEdits(source, edits);
}

function renderReference(
  reference: ConversationInlineReference,
  sink: {
    readonly assetIdByLocalId: ReadonlyMap<string, string>;
    readonly citations: DocumentCitation[];
    readonly contextDetails: string[];
  },
): string {
  const label = escapeMarkdownText(reference.label);
  const excerpt = (heading: string, text: string, comment: string | null) =>
    `\n\n${quote(`${heading}\\\n${escapeMarkdownText(text)}`)}\n\n${comment === null ? "" : `Comment: ${escapeMarkdownText(comment)}\n\n`}`;
  switch (reference._tag) {
    case "attachment": {
      const assetId = sink.assetIdByLocalId.get(reference.attachmentLocalId);
      return assetId === undefined
        ? label
        : `${reference.image ? "!" : ""}[${label}](${DOCUMENT_ASSET_URL_PREFIX}${assetId})`;
    }
    case "file-excerpt": {
      sink.citations.push({
        _tag: "file-excerpt",
        id: `c${sink.citations.length + 1}`,
        path: reference.path,
        startLine: reference.startLine,
        endLine: reference.endLine,
        unsaved: reference.unsaved,
        text: reference.text,
        comment: reference.comment,
      });
      const lines =
        reference.startLine === reference.endLine
          ? `line ${reference.startLine}`
          : `lines ${reference.startLine}–${reference.endLine}`;
      return excerpt(
        `**Quote from ${inlineCode(reference.path)}**, ${lines}${reference.unsaved ? " (unsaved at the time)" : ""}:`,
        reference.text,
        reference.comment,
      );
    }
    case "message-excerpt":
      sink.citations.push({
        _tag: "message-excerpt",
        id: `c${sink.citations.length + 1}`,
        text: reference.text,
        comment: reference.comment,
      });
      return excerpt("**Quote from an earlier answer:**", reference.text, reference.comment);
    case "mention":
      return inlineCode(reference.path);
    case "skill":
      return `*Skill ${escapeMarkdownText(reference.name)}*`;
    case "terminal":
      sink.contextDetails.push(
        `- Terminal ${inlineCode(reference.terminal)}, lines ${reference.lineStart}–${reference.lineEnd}:\n${indent(fencedBlock(reference.text.text))}`,
      );
      return `*${label}*`;
    case "review-comment":
      sink.contextDetails.push(
        `- Review comment on ${inlineCode(reference.filePath)} (${escapeMarkdownText(reference.rangeLabel)}):\n${indent(escapeMarkdownText(reference.comment.text))}\n${indent(fencedBlock(reference.diff.text, "diff"))}`,
      );
      return `*${label}*`;
    case "page-element":
      sink.contextDetails.push(
        `- Page element ${inlineCode(reference.tagName)}${reference.selector === null ? "" : ` ${inlineCode(reference.selector)}`} on ${inlineCode(reference.pageUrl)}`,
      );
      return `*${label}*`;
    case "preview-annotation":
      sink.contextDetails.push(
        `- Annotation on ${inlineCode(reference.pageUrl)} (${escapeMarkdownText(reference.targetSummary)}):\n${indent(escapeMarkdownText(reference.comment.text))}`,
      );
      return `*${label}*`;
  }
}
