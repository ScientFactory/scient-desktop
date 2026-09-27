/**
 * Scient's inline message references (composer context chips and captured
 * quotes) as the conversation snapshot carries them: link destinations become
 * `scient-ref:<id>` and each reference keeps only its typed display fields.
 * Installation-local identities (environment, thread and message ids,
 * absolute workspace roots, file revisions, editor positions) are dropped.
 */
import {
  CONVERSATION_REFERENCE_URL_PREFIX,
  isFileCitation,
  type ComposerContextRecord,
  type ConversationAttachment,
  type ConversationInlineReference,
} from "@t3tools/contracts";
import { collectComposerCitations } from "@t3tools/shared/composerCitations";
import {
  collectComposerContextReferences,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { boundText, type TextBounds } from "./boundedText.ts";
import { escapeMarkdownText } from "./markdownAst.ts";

const CONTEXT_TEXT_BOUNDS: TextBounds = {
  headLines: 60,
  tailLines: 20,
  headChars: 12_000,
  tailChars: 4_000,
};

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

function basename(path: string): string {
  return path.split(/[\\/]/u).findLast((part) => part.length > 0) ?? path;
}

/**
 * A path shown relative to the project. Absolute paths inside one of `roots`
 * lose the root; any other absolute path keeps only its file name, so no
 * machine-specific directory leaves the installation.
 */
export function projectRelativePath(path: string, roots: ReadonlyArray<string>): string {
  const normalized = path.replace(/\\/gu, "/");
  if (!isAbsolutePath(path)) return normalized.replace(/^\.\//u, "");
  for (const root of roots) {
    const prefix = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (prefix.length > 0 && normalized.startsWith(`${prefix}/`)) {
      return normalized.slice(prefix.length + 1);
    }
  }
  return basename(normalized);
}

export interface InlineReferenceProjection {
  readonly text: string;
  readonly references: ReadonlyArray<ConversationInlineReference>;
  /** References that could not be projected; their labels were kept as text. */
  readonly skipped: number;
}

interface Occurrence {
  readonly start: number;
  readonly end: number;
  readonly render: (id: string) => {
    readonly reference: ConversationInlineReference | null;
    readonly label: string;
    readonly image: boolean;
  };
}

function projectRecord(
  record: ComposerContextRecord | undefined,
  label: string,
  attachments: ReadonlyArray<ConversationAttachment>,
  roots: ReadonlyArray<string>,
  id: string,
): ConversationInlineReference | null {
  if (!record || "payload" in record) return null;
  const base = { id, label };
  switch (record.kind) {
    case "image":
    case "file": {
      const attachment = attachments.find((candidate) => candidate.localId === record.attachmentId);
      return attachment
        ? {
            _tag: "attachment",
            ...base,
            attachmentLocalId: attachment.localId,
            image: record.kind === "image",
          }
        : null;
    }
    case "terminal":
      return {
        _tag: "terminal",
        ...base,
        terminal: record.terminalLabel.slice(0, 255),
        lineStart: record.lineStart,
        lineEnd: record.lineEnd,
        text: boundText(record.text, CONTEXT_TEXT_BOUNDS),
      };
    case "mention":
      return { _tag: "mention", ...base, path: projectRelativePath(record.path, roots) };
    case "skill":
      return { _tag: "skill", ...base, name: record.name };
    case "review-comment":
      return {
        _tag: "review-comment",
        ...base,
        filePath: projectRelativePath(record.filePath, roots),
        rangeLabel: record.rangeLabel,
        comment: boundText(record.text, CONTEXT_TEXT_BOUNDS),
        diff: boundText(record.diff, CONTEXT_TEXT_BOUNDS),
      };
    case "element":
      return {
        _tag: "page-element",
        ...base,
        pageUrl: record.pageUrl,
        pageTitle: record.pageTitle,
        tagName: record.tagName,
        selector: record.selector,
      };
    case "preview-annotation":
      return {
        _tag: "preview-annotation",
        ...base,
        pageUrl: record.pageUrl,
        pageTitle: record.pageTitle,
        comment: boundText(record.comment, CONTEXT_TEXT_BOUNDS),
        targetSummary: record.targetSummary,
      };
    default:
      return null;
  }
}

/**
 * Rewrites a stored message's inline references. `roots` are the thread's
 * workspace root and worktree, used to make paths project-relative.
 */
export function projectInlineReferences(input: {
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly attachments: ReadonlyArray<ConversationAttachment>;
  readonly roots: ReadonlyArray<string>;
}): InlineReferenceProjection {
  const recordsById = new Map(input.records.map((record) => [record.contextId, record] as const));
  const occurrences: Occurrence[] = [
    ...collectComposerContextReferences(input.text).map((occurrence): Occurrence => ({
      start: occurrence.start,
      end: occurrence.end,
      render: (id) => {
        const label = sanitizeComposerContextLabel(occurrence.label, occurrence.kind);
        const reference = projectRecord(
          recordsById.get(occurrence.contextId),
          label,
          input.attachments,
          input.roots,
          id,
        );
        return {
          reference,
          label,
          image: reference?._tag === "attachment" && reference.image && occurrence.image,
        };
      },
    })),
    ...collectComposerCitations(input.text).map((match): Occurrence => ({
      start: match.start,
      end: match.end,
      render: (id) => {
        const citation = match.citation;
        if (isFileCitation(citation)) {
          return {
            label: "File quote",
            image: false,
            reference: {
              _tag: "file-excerpt",
              id,
              label: "File quote",
              path: projectRelativePath(
                isAbsolutePath(citation.path) ? citation.path : `${citation.cwd}/${citation.path}`,
                [citation.cwd, ...input.roots],
              ),
              startLine: citation.startLine,
              endLine: citation.endLine,
              unsaved: citation.origin === "draft",
              text: citation.text,
              comment: citation.comment ?? null,
            },
          };
        }
        return {
          label: "Assistant quote",
          image: false,
          reference: {
            _tag: "message-excerpt",
            id,
            label: "Assistant quote",
            text: citation.text,
            comment: citation.comment ?? null,
          },
        };
      },
    })),
  ].toSorted((left, right) => left.start - right.start);

  const references: ConversationInlineReference[] = [];
  let skipped = 0;
  let text = "";
  let cursor = 0;
  for (const occurrence of occurrences) {
    if (occurrence.start < cursor) continue;
    const id = `r${references.length + 1}`;
    const rendered = occurrence.render(id);
    text += input.text.slice(cursor, occurrence.start);
    if (rendered.reference === null) {
      skipped += 1;
      text += escapeMarkdownText(rendered.label);
    } else {
      references.push(rendered.reference);
      text += `${rendered.image ? "!" : ""}[${rendered.label}](${CONVERSATION_REFERENCE_URL_PREFIX}${id})`;
    }
    cursor = occurrence.end;
  }
  return { text: text + input.text.slice(cursor), references, skipped };
}
