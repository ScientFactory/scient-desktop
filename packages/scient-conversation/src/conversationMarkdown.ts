/**
 * Scient conversation Markdown v1: the grammar of an exported conversation,
 * its writer primitives, and a parser that recovers message boundaries.
 *
 *     ---
 *     scient: conversation
 *     scient-format: 1
 *     scient-export: 7f3c9a2e41b8
 *     title: Export and import design
 *     exported: 2026-09-28T09:12:00.000Z
 *     ---
 *
 *     <!-- scient:message export=7f3c9a2e41b8 n=1 role=user time=2026-09-27T14:05:00.000Z -->
 *     ## You · 27 Sep 2026, 14:05 UTC
 *
 *     Please investigate …
 *
 *     <!-- scient:message export=7f3c9a2e41b8 n=2 role=assistant time=… turn=1 -->
 *     ## Assistant · 27 Sep 2026, 14:06 UTC
 *
 *     Here is what I found …
 *
 *     <!-- scient:part export=7f3c9a2e41b8 kind=work-log -->
 *     <details>…</details>
 *
 * Markers carry structure only. Boundaries come only from top-level marker
 * comments carrying the file's own export value; speaker headings are for
 * people. Content between a message's heading and its first part marker is the
 * message body; parts are generated material the writer attached to it.
 */
import type { Heading, Html, Root, Yaml } from "mdast";
import * as DateTime from "effect/DateTime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  applyEdits,
  nodeRange,
  parseMarkdown,
  visitNodes,
  type SourceEdit,
} from "./markdownAst.ts";
import { readMessageBody } from "./messageBody.ts";

export const SCIENT_CONVERSATION_MARKDOWN_VERSION = 1;

export type MarkdownMessageRole = "user" | "assistant";

export const MARKDOWN_PART_KINDS = [
  "attachments",
  "context",
  "plan",
  "answers",
  "work-log",
  "reasoning",
] as const;
export type MarkdownPartKind = (typeof MARKDOWN_PART_KINDS)[number];

const SPEAKER_LABELS: Record<MarkdownMessageRole, string> = { user: "You", assistant: "Assistant" };

const EXPORT_VALUE_PATTERN = /^[a-f0-9]{12,64}$/u;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const MARKER_PATTERN = /^<!-- scient:([a-z-]+)((?: [a-z-]+=[^\s=]+)*) -->$/u;

export function isExportValue(value: string): boolean {
  return EXPORT_VALUE_PATTERN.test(value);
}

/** Namespace a body's labels and anchors live under in the shared document. */
export function messageNamespace(n: number): string {
  return `m${n}-`;
}

export function formatFrontMatter(input: {
  readonly exportValue: string;
  readonly title: string;
  readonly exported: string;
}): string {
  const yaml = stringifyYaml(
    {
      scient: "conversation",
      "scient-format": SCIENT_CONVERSATION_MARKDOWN_VERSION,
      "scient-export": input.exportValue,
      title: input.title,
      exported: input.exported,
    },
    { lineWidth: 0 },
  );
  return `---\n${yaml}---\n`;
}

export function formatMessageMarker(input: {
  readonly exportValue: string;
  readonly n: number;
  readonly role: MarkdownMessageRole;
  readonly time: string;
  /** 1-based position of the message's turn in the file; absent for a turnless message. */
  readonly turn: number | null;
}): string {
  const turn = input.turn === null ? "" : ` turn=${input.turn}`;
  return `<!-- scient:message export=${input.exportValue} n=${input.n} role=${input.role} time=${input.time}${turn} -->`;
}

export function formatPartMarker(input: {
  readonly exportValue: string;
  readonly kind: MarkdownPartKind;
}): string {
  return `<!-- scient:part export=${input.exportValue} kind=${input.kind} -->`;
}

/** "27 Sep 2026, 14:05 UTC" in the requested zone; UTC when the zone is unknown. */
export function formatSpeakerTime(iso: string, timeZone: string): string {
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) return iso;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
      timeZoneName: "short",
    });
  } catch {
    return formatSpeakerTime(iso, "UTC");
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(epochMs).map((part) => [part.type, part.value] as const),
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

export function formatSpeakerHeading(input: {
  readonly role: MarkdownMessageRole;
  readonly time: string;
  readonly timeZone: string;
}): string {
  return `## ${SPEAKER_LABELS[input.role]} · ${formatSpeakerTime(input.time, input.timeZone)}`;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface ParsedMarkdownPart {
  readonly kind: MarkdownPartKind;
  readonly markdown: string;
}

export interface ParsedMarkdownMessage {
  readonly n: number;
  readonly role: MarkdownMessageRole;
  readonly time: string;
  readonly turn: number | null;
  /** The message text with the writer's namespace removed. */
  readonly body: string;
  readonly parts: ReadonlyArray<ParsedMarkdownPart>;
  /** 1-based line of the message marker. */
  readonly line: number;
}

export type MarkdownIssueKind =
  | "foreign-marker"
  | "malformed-marker"
  | "duplicate-number"
  | "out-of-order-number"
  | "out-of-order-turn"
  | "missing-number"
  | "unknown-role"
  | "invalid-time"
  | "unknown-part";

export interface MarkdownIssue {
  readonly kind: MarkdownIssueKind;
  /** 1-based line of the marker the issue concerns. */
  readonly line: number;
  readonly detail: string;
}

export type ParsedConversationMarkdown =
  | {
      /** No Scient conversation front matter: an ordinary document, never a transcript. */
      readonly kind: "document";
    }
  | {
      readonly kind: "conversation";
      readonly exportValue: string;
      readonly title: string | null;
      readonly exported: string | null;
      /** Messages whose markers parsed cleanly, in file order. */
      readonly messages: ReadonlyArray<ParsedMarkdownMessage>;
      readonly issues: ReadonlyArray<MarkdownIssue>;
    };

interface Marker {
  readonly type: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

function readFrontMatter(
  root: Root,
): { exportValue: string; title: string | null; exported: string | null } | null {
  const first = root.children[0];
  if (first?.type !== "yaml") return null;
  let data: unknown;
  try {
    data = parseYaml((first as Yaml).value);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const exportValue = record["scient-export"];
  if (
    record.scient !== "conversation" ||
    record["scient-format"] !== SCIENT_CONVERSATION_MARKDOWN_VERSION ||
    typeof exportValue !== "string" ||
    !isExportValue(exportValue)
  ) {
    return null;
  }
  return {
    exportValue,
    title: typeof record.title === "string" ? record.title : null,
    exported: typeof record.exported === "string" ? record.exported : null,
  };
}

function isGeneratedHeading(source: string, node: Heading, role: MarkdownMessageRole): boolean {
  const range = nodeRange(node);
  if (!range || node.depth !== 2) return false;
  return source.slice(range.start, range.end).startsWith(`## ${SPEAKER_LABELS[role]} · `);
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/u, "").replace(/\s+$/u, "");
}

/** Restore the marker collision escape as the reader sees it on screen, outside code. */
function restoreVisibleMarkers(body: string): string {
  if (!body.includes("&lt;!-- scient:")) return body;
  const edits: SourceEdit[] = [];
  visitNodes(parseMarkdown(body), (node) => {
    if (node.type !== "text") return;
    const range = nodeRange(node);
    if (!range) return;
    for (const match of body.slice(range.start, range.end).matchAll(/&lt;!-- scient:/gu)) {
      const start = range.start + match.index;
      edits.push({ start, end: start + "&lt;".length, text: "<" });
    }
  });
  return applyEdits(body, edits);
}

/**
 * Recovers messages from Scient conversation Markdown. Markers are recognised
 * only as top-level HTML comment blocks carrying the front matter's export
 * value; quoted markers, markers in code, and markers from another export are
 * content.
 */
export function parseConversationMarkdown(source: string): ParsedConversationMarkdown {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const root = parseMarkdown(normalized, { frontMatter: true });
  const frontMatter = readFrontMatter(root);
  if (frontMatter === null) return { kind: "document" };

  const issues: MarkdownIssue[] = [];
  const markers: Marker[] = [];
  for (const node of root.children) {
    if (node.type !== "html") continue;
    const value = (node as Html).value.trim();
    if (!value.startsWith("<!-- scient:")) continue;
    const range = nodeRange(node);
    if (!range) continue;
    const line = node.position?.start.line ?? 0;
    const match = MARKER_PATTERN.exec(value);
    if (!match) {
      issues.push({
        kind: "malformed-marker",
        line,
        detail: "The marker does not follow the format.",
      });
      markers.push({
        type: "invalid",
        attributes: new Map(),
        start: range.start,
        end: range.end,
        line,
      });
      continue;
    }
    const attributes = new Map<string, string>();
    let duplicateAttribute = false;
    for (const pair of match[2]!.trim().split(" ").filter(Boolean)) {
      const [key, attributeValue] = pair.split("=") as [string, string];
      if (attributes.has(key)) duplicateAttribute = true;
      attributes.set(key, attributeValue);
    }
    if (attributes.get("export") !== frontMatter.exportValue) {
      issues.push({
        kind: "foreign-marker",
        line,
        detail: "A marker from another export was treated as text.",
      });
      continue;
    }
    if (duplicateAttribute) {
      issues.push({ kind: "malformed-marker", line, detail: "The marker repeats an attribute." });
      markers.push({ type: "invalid", attributes, start: range.start, end: range.end, line });
      continue;
    }
    markers.push({ type: match[1]!, attributes, start: range.start, end: range.end, line });
  }

  // A damaged message marker still ends the preceding clean message. Its
  // following text must never be silently attributed to that speaker.
  const boundaries = markers.filter(
    (marker) => marker.type === "message" || marker.type === "invalid",
  );
  const messages: ParsedMarkdownMessage[] = [];
  const seen = new Set<number>();
  const closedTurns = new Set<number>();
  let currentTurn: number | null = null;
  let markerCursor = 0;
  let nodeCursor = 0;
  for (const [index, marker] of boundaries.entries()) {
    const nextBoundary = boundaries[index + 1]?.start ?? normalized.length;
    if (marker.type === "invalid") continue;
    const expected = index + 1;
    const nValue = marker.attributes.get("n") ?? "";
    const n =
      /^[1-9]\d*$/u.test(nValue) && Number.isSafeInteger(Number(nValue)) ? Number(nValue) : null;
    const role = marker.attributes.get("role");
    const time = marker.attributes.get("time") ?? "";
    const turnValue = marker.attributes.get("turn");
    let clean = true;
    if (
      n === null ||
      (turnValue !== undefined &&
        (!/^[1-9]\d*$/u.test(turnValue) || !Number.isSafeInteger(Number(turnValue)))) ||
      [...marker.attributes.keys()].some(
        (key) => !["export", "n", "role", "time", "turn"].includes(key),
      )
    ) {
      issues.push({
        kind: "malformed-marker",
        line: marker.line,
        detail: "The message number is invalid.",
      });
      clean = false;
    } else if (seen.has(n)) {
      issues.push({
        kind: "duplicate-number",
        line: marker.line,
        detail: `Message ${n} appears twice.`,
      });
      clean = false;
    } else if (n < expected) {
      issues.push({
        kind: "out-of-order-number",
        line: marker.line,
        detail: `Message ${n} is out of order.`,
      });
      clean = false;
    } else if (n > expected) {
      issues.push({
        kind: "missing-number",
        line: marker.line,
        detail: `Messages ${expected}–${n - 1} are missing.`,
      });
    }
    if (role !== "user" && role !== "assistant") {
      issues.push({
        kind: "unknown-role",
        line: marker.line,
        detail: `Unknown role "${(role ?? "").slice(0, 80)}".`,
      });
      clean = false;
    }
    if (
      !ISO_TIME_PATTERN.test(time) ||
      !Number.isFinite(Date.parse(time)) ||
      DateTime.formatIso(DateTime.makeUnsafe(Date.parse(time))).slice(0, 19) !== time.slice(0, 19)
    ) {
      issues.push({
        kind: "invalid-time",
        line: marker.line,
        detail: "The message time is invalid.",
      });
      clean = false;
    }
    if (n !== null) seen.add(n);
    if (!clean || n === null || (role !== "user" && role !== "assistant")) continue;
    const turn = turnValue === undefined ? null : Number(turnValue);
    if (turn !== null && turn !== currentTurn) {
      if (currentTurn !== null) closedTurns.add(currentTurn);
      if (closedTurns.has(turn)) {
        issues.push({
          kind: "out-of-order-turn",
          line: marker.line,
          detail: `Turn ${turn} reappears after another turn.`,
        });
        continue;
      }
      currentTurn = turn;
    }

    // Both lists follow source order. Walk each marker and Markdown node once,
    // even for a long imported conversation with thousands of messages.
    while (markerCursor < markers.length && markers[markerCursor]!.start <= marker.end) {
      markerCursor += 1;
    }
    const withinMessage: Marker[] = [];
    while (markerCursor < markers.length && markers[markerCursor]!.start < nextBoundary) {
      withinMessage.push(markers[markerCursor]!);
      markerCursor += 1;
    }
    const parts = withinMessage.filter((candidate) => candidate.type === "part");
    for (const other of withinMessage) {
      if (other.type !== "part" && other.type !== "message" && other.start > marker.end) {
        issues.push({
          kind: "malformed-marker",
          line: other.line,
          detail: `Unknown marker "${other.type}".`,
        });
      }
    }
    let bodyStart = marker.end;
    while (
      nodeCursor < root.children.length &&
      (nodeRange(root.children[nodeCursor]!)?.start ?? -1) < marker.end
    ) {
      nodeCursor += 1;
    }
    const firstNode = root.children[nodeCursor];
    const firstRange = firstNode ? nodeRange(firstNode) : null;
    if (
      firstNode?.type === "heading" &&
      firstRange &&
      firstRange.start < (parts[0]?.start ?? nextBoundary) &&
      isGeneratedHeading(normalized, firstNode as Heading, role)
    ) {
      bodyStart = firstRange.end;
    }
    const bodyEnd = parts[0]?.start ?? nextBoundary;
    const parsedParts = parts.flatMap((part, partIndex): ParsedMarkdownPart[] => {
      const kind = part.attributes.get("kind");
      if (!(MARKDOWN_PART_KINDS as ReadonlyArray<string>).includes(kind ?? "")) {
        issues.push({
          kind: "unknown-part",
          line: part.line,
          detail: `Unknown part "${(kind ?? "").slice(0, 80)}".`,
        });
        return [];
      }
      const end = parts[partIndex + 1]?.start ?? nextBoundary;
      return [
        {
          kind: kind as MarkdownPartKind,
          markdown: trimBlankLines(normalized.slice(part.end, end)),
        },
      ];
    });
    messages.push({
      n,
      role,
      time,
      turn,
      body: restoreVisibleMarkers(
        readMessageBody(trimBlankLines(normalized.slice(bodyStart, bodyEnd)), messageNamespace(n)),
      ),
      parts: parsedParts,
      line: marker.line,
    });
  }

  return {
    kind: "conversation",
    exportValue: frontMatter.exportValue,
    title: frontMatter.title,
    exported: frontMatter.exported,
    messages,
    issues,
  };
}
