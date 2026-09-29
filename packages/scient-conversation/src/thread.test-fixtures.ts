import {
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ConversationSnapshotSelection,
  type ConversationSnapshotV1,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildConversationDocument,
  type ResolvedAttachmentContent,
} from "./conversationDocument.ts";
import { writeConversationMarkdown } from "./markdownExport.ts";
import { buildConversationSnapshot, canonicalSnapshotContent } from "./snapshot.ts";

export const EXPORT_VALUE = "7f3c9a2e41b8";
export const DIGEST = `sha256:${"0".repeat(64)}`;

let clock = Date.parse("2026-09-27T14:00:00.000Z");

/** A strictly increasing ISO time, so fixtures keep their written order. */
export function tick(seconds = 1): string {
  clock += seconds * 1_000;
  return DateTime.formatIso(DateTime.makeUnsafe(clock));
}

export function resetClock(): void {
  clock = Date.parse("2026-09-27T14:00:00.000Z");
}

export function message(input: {
  readonly id: string;
  readonly role: OrchestrationMessage["role"];
  readonly text: string;
  readonly turnId?: string | null;
  readonly at?: string;
  readonly streaming?: boolean;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessage["context"];
}): OrchestrationMessage {
  const at = input.at ?? tick();
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    turnId: input.turnId ? TurnId.make(input.turnId) : null,
    streaming: input.streaming ?? false,
    createdAt: at,
    updatedAt: at,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.context ? { context: input.context } : {}),
  };
}

export function activity(input: {
  readonly id: string;
  readonly kind: string;
  readonly summary?: string;
  readonly payload?: unknown;
  readonly turnId?: string | null;
  readonly tone?: OrchestrationThreadActivity["tone"];
  readonly at?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    kind: input.kind,
    tone: input.tone ?? "tool",
    summary: input.summary ?? input.kind,
    payload: input.payload ?? {},
    turnId: input.turnId ? TurnId.make(input.turnId) : null,
    createdAt: input.at ?? tick(),
  };
}

export function thread(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly proposedPlans?: OrchestrationThread["proposedPlans"];
  readonly latestTurn?: OrchestrationThread["latestTurn"];
  readonly session?: OrchestrationThread["session"];
  readonly title?: string;
}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: null,
    workspaceRoot: "/Users/someone/project",
    title: input.title ?? "Export design",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: input.latestTurn ?? null,
    createdAt: "2026-09-27T14:00:00.000Z",
    updatedAt: "2026-09-27T15:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [...input.messages],
    proposedPlans: input.proposedPlans ?? [],
    activities: [...(input.activities ?? [])],
    checkpoints: [],
    session: input.session ?? null,
  };
}

export const WHOLE: ConversationSnapshotSelection = {
  workLog: false,
  reasoning: false,
  throughMessageId: null,
};

export function snapshotOf(
  source: OrchestrationThread,
  selection: ConversationSnapshotSelection = WHOLE,
  isAvailable: (attachment: ChatAttachment) => boolean = () => true,
): ConversationSnapshotV1 {
  const content = buildConversationSnapshot({
    thread: source,
    snapshotSequence: 10,
    threadSequence: 9,
    capturedAt: "2026-09-27T15:00:01.000Z",
    selection,
    isAttachmentAvailable: isAvailable,
  });
  // Tests do not need a real hash; the canonical text must still be computable.
  canonicalSnapshotContent(content);
  return { ...content, contentDigest: DIGEST };
}

export function exportMarkdown(
  snapshot: ConversationSnapshotV1,
  options: {
    readonly packaging?: "text" | "with-attachments";
    readonly timeZone?: string;
    readonly resolve?: (localId: string) => ResolvedAttachmentContent;
  } = {},
): { readonly markdown: string; readonly document: ReturnType<typeof buildConversationDocument> } {
  const document = buildConversationDocument({
    snapshot,
    exportValue: EXPORT_VALUE,
    timeZone: options.timeZone ?? "UTC",
    resolveAttachment: (attachment) =>
      options.resolve?.(attachment.localId) ?? {
        _tag: "bytes",
        bytes: new TextEncoder().encode(attachment.name),
        sha256: DIGEST,
      },
  });
  return {
    document,
    markdown: writeConversationMarkdown({
      bundle: document.bundle,
      exportValue: EXPORT_VALUE,
      exported: "2026-09-28T09:12:00.000Z",
      packaging: options.packaging ?? "text",
    }),
  };
}

/** Name pieces that stress code-point handling: astral letters, CJK, combining marks, emoji, RTL. */
const NAME_PIECES = [
  "研究",
  "結果",
  "𝒜",
  "𠀀",
  "𝟙",
  "é",
  "é",
  "q̃",
  "İ",
  "ß",
  "🧪",
  "👩‍🔬",
  "ب",
  "א",
  "क्ष",
  "‍",
  ".",
  " ",
  "-",
  "_",
  "a",
  "Z",
  "9",
  ".png",
];

/**
 * Deterministic attachment-style names (at most 255 UTF-16 units, as chat
 * attachments allow) for property-style tests.
 */
export function generatedNames(count: number, seed = 0x5c1e47): ReadonlyArray<string> {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Array.from({ length: count }, () => {
    const pieces = 1 + Math.floor(next() * 160);
    let name = "";
    for (let index = 0; index < pieces; index += 1) {
      const piece = NAME_PIECES[Math.floor(next() * NAME_PIECES.length)]!;
      if (name.length + piece.length > 255) break;
      name += piece;
    }
    return name.trim() || "x";
  });
}
