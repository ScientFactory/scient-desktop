/**
 * What a context handoff carries, in which order it is kept, and how it reads.
 *
 * SCIENT-OWNED mirror of upstream Orchestration V2's `historicalMessage`,
 * `selectHistory` and `handoffCoverage`. Items are kept whole or omitted whole
 * (V2), in V2's priority order: latest user message, latest assistant message,
 * first user message, then newest to oldest. Omitted items stay reachable
 * through the `t3_thread_read` tool named in the coverage header.
 *
 * Upstream reference: pingdotgg/t3code PR #2829 at a3fbbe45315e (2026-09-27),
 * `apps/server/src/orchestration-v2/ContextHandoffBudget.ts`. V2's versions
 * read V2 turn items and render plain text in bytes, so they are mirrored in
 * behaviour, not copied: this module reads main's projection (messages,
 * activities, plans) and renders JSON sized in estimated tokens.
 *
 * Scient extends V2 in two ways, each isolated here:
 * - Reasoning and tool work are history items (V2 portable handoffs drop
 *   them). The latest turn's reasoning and tools rank right after the anchors;
 *   older ones rank last, so thinking never displaces conversation.
 * - A fork taken while the origin was still working ranks its cut turn first
 *   and labels partial text and unfinished tools.
 */
import {
  getProviderAttachmentLimitError,
  SCIENT_MARKDOWN_DOCUMENT_FORMAT,
  type ChatAttachment,
  type OrchestrationConversationImportSource,
  type OrchestrationMessage,
  type OrchestrationConversationImportOmission,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type ThreadForkMidTurnCut,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Predicate from "effect/Predicate";

import { retainQuestionAnswers } from "../retainedQuestionAnswers.ts";
import {
  attachmentTokenAllowance,
  estimateTokens,
  MIN_USEFUL_HANDOFF_TOKENS,
} from "./handoffBudget.ts";

export type HandoffItemKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "question_answer"
  | "proposed_plan"
  | "tool";

type PriorityClass = "cut" | "anchor" | "latest_turn" | "conversation" | "detail";

export interface HandoffItem {
  readonly order: number;
  readonly itemId: string;
  readonly kind: HandoffItemKind;
  readonly turnId: string | null;
  readonly text: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly partial: boolean;
}

export interface SelectedHistory {
  readonly items: ReadonlyArray<HandoffItem & { readonly truncated: boolean }>;
  readonly omittedItemIds: ReadonlyArray<string>;
  readonly reattached: ReadonlyArray<ChatAttachment>;
  readonly usedTokens: number;
}

const TOOL_OUTPUT_MAX_CHARS = 4_000;
const TOOL_DETAIL_MAX_CHARS = 2_000;
const ITEM_OVERHEAD_TOKENS = 16;
const MAX_LISTED_OMITTED_IDS = 100;

const HANDOFF_TOOL_KINDS = new Set([
  "tool.updated",
  "tool.completed",
  "tool.denied",
  "task.completed",
  "runtime.error",
]);

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function stringifyOutput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function toolStatus(
  activity: OrchestrationThreadActivity,
  cut: ThreadForkMidTurnCut | undefined,
): string {
  if (cut?.inFlightActivityIds.includes(activity.id)) return "in_flight";
  if (activity.kind === "tool.denied") return "denied";
  if (activity.tone === "error" || activity.kind === "runtime.error") return "failed";
  if (activity.kind === "tool.updated") return "in_progress";
  return "completed";
}

/**
 * Tool rows: one item per provider item. A completed row supersedes its
 * earlier progress rows; an update without completion stays (it may be the
 * unfinished call at a mid-turn cut).
 */
function toolItems(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  cut: ThreadForkMidTurnCut | undefined,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestByToolId = new Map<string, OrchestrationThreadActivity>();
  const standalone: OrchestrationThreadActivity[] = [];
  for (const activity of activities) {
    if (!HANDOFF_TOOL_KINDS.has(activity.kind) && !cut?.inFlightActivityIds.includes(activity.id))
      continue;
    const payload = Predicate.isObject(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : undefined;
    const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined;
    if (toolCallId === undefined) {
      standalone.push(activity);
      continue;
    }
    const previous = latestByToolId.get(toolCallId);
    if (previous === undefined || previous.kind !== "tool.completed") {
      latestByToolId.set(toolCallId, activity);
    }
  }
  return [...standalone, ...latestByToolId.values()];
}

function messageItem(
  message: OrchestrationMessage,
  cut: ThreadForkMidTurnCut | undefined,
): Omit<HandoffItem, "order"> | undefined {
  if (message.role === "system") return undefined;
  const partial = cut?.partialMessageIds.includes(message.id) === true;
  const text =
    message.role === "user"
      ? projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        })
      : message.text;
  const kind: HandoffItemKind =
    message.role === "user"
      ? "user_message"
      : message.role === "assistant"
        ? "assistant_message"
        : "reasoning";
  return {
    itemId: message.id,
    kind,
    turnId: message.turnId,
    text,
    fields: {},
    attachments: message.attachments ?? [],
    partial,
  };
}

/**
 * History items for everything before `beforeMessageId`, in timeline order.
 * Streaming rows are excluded; a mid-turn fork's copied rows are complete
 * copies and are labelled partial through the cut record instead.
 *
 * `inheritedThrough` is the transfer boundary of an imported thread: records
 * dated at or before it came with the import and are always prior, even when
 * the current message is dated earlier (a clock that went back).
 */
export function buildHandoffItems(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly beforeMessageId: string;
  readonly inheritedThrough?: string | undefined;
  readonly midTurnCut: ThreadForkMidTurnCut | undefined;
}): ReadonlyArray<HandoffItem> {
  const beforeIndex = input.messages.findIndex((message) => message.id === input.beforeMessageId);
  const inherited = (createdAt: string) =>
    input.inheritedThrough !== undefined && createdAt <= input.inheritedThrough;
  const priorMessages = input.messages.filter(
    (message, index) =>
      !message.streaming &&
      (beforeIndex < 0 ||
        index < beforeIndex ||
        (index > beforeIndex && inherited(message.createdAt))),
  );
  const cutoff =
    beforeIndex < 0 ? undefined : (input.messages[beforeIndex]?.createdAt ?? undefined);
  const before = (createdAt: string) =>
    cutoff === undefined || createdAt < cutoff || inherited(createdAt);

  const timeline: Array<{ readonly createdAt: string; readonly item: Omit<HandoffItem, "order"> }> =
    [];
  for (const message of priorMessages) {
    const item = messageItem(message, input.midTurnCut);
    if (item !== undefined) timeline.push({ createdAt: message.createdAt, item });
  }

  const turnIds = new Set(
    priorMessages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  for (const { activity, answer } of retainQuestionAnswers(input.activities, turnIds).answers) {
    if (!before(activity.createdAt)) continue;
    timeline.push({
      createdAt: activity.createdAt,
      item: {
        itemId: activity.id,
        kind: "question_answer",
        turnId: activity.turnId,
        text: "",
        fields: {
          questions: answer.questionTextById ?? {},
          answers: answer.answers,
        },
        attachments: Object.values(answer.attachmentsByQuestionId).flat(),
        partial: false,
      },
    });
  }

  for (const plan of input.proposedPlans) {
    if (!before(plan.createdAt)) continue;
    timeline.push({
      createdAt: plan.createdAt,
      item: {
        itemId: plan.id,
        kind: "proposed_plan",
        turnId: plan.turnId,
        text: plan.planMarkdown,
        fields: {},
        attachments: [],
        partial: false,
      },
    });
  }

  for (const activity of toolItems(input.activities, input.midTurnCut)) {
    if (!before(activity.createdAt)) continue;
    const payload = Predicate.isObject(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : {};
    const detail = typeof payload.detail === "string" ? payload.detail : undefined;
    const output = stringifyOutput(payload.data);
    timeline.push({
      createdAt: activity.createdAt,
      item: {
        itemId: activity.id,
        kind: "tool",
        turnId: activity.turnId,
        text: "",
        fields: {
          status: toolStatus(activity, input.midTurnCut),
          summary: activity.summary,
          ...(detail === undefined ? {} : { detail: clip(detail, TOOL_DETAIL_MAX_CHARS) }),
          ...(output === undefined ? {} : { output: clip(output, TOOL_OUTPUT_MAX_CHARS) }),
        },
        attachments: [],
        partial: false,
      },
    });
  }

  return timeline
    .map((entry, index) => ({ entry, index }))
    .toSorted(
      (left, right) =>
        left.entry.createdAt.localeCompare(right.entry.createdAt) || left.index - right.index,
    )
    .map(({ entry }, order) => ({ ...entry.item, order }));
}

function itemRecord(
  item: HandoffItem,
  truncated: boolean,
  reattachedIds: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    kind: item.kind,
    itemId: item.itemId,
    ...(item.turnId === null ? {} : { turnId: item.turnId }),
    ...(item.text.length > 0 ? { text: item.text } : {}),
    ...item.fields,
    ...(item.attachments.length > 0
      ? {
          attachments: item.attachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            contentReattached: reattachedIds.has(attachment.id),
          })),
        }
      : {}),
    ...(item.partial ? { partial: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function itemCost(item: HandoffItem): number {
  return estimateTokens(encode(itemRecord(item, false, new Set()))) + ITEM_OVERHEAD_TOKENS;
}

const TRUNCATION_NOTE = "\n[… truncated; read the full item with t3_thread_read …]\n";

/** Keeps the head and tail of an item's text so its cost fits `tokens`. */
function truncateToFit(item: HandoffItem, tokens: number): HandoffItem | undefined {
  const fixed = itemCost({ ...item, text: TRUNCATION_NOTE });
  let maxChars = (tokens - fixed) * 3;
  if (tokens - fixed < MIN_USEFUL_HANDOFF_TOKENS / 2 || item.text.length === 0) return undefined;
  // Characters outside ASCII cost more than a third of a token; shrink until
  // the estimate fits instead of assuming one byte per character.
  for (let attempt = 0; attempt < 6 && maxChars > 0; attempt += 1) {
    const head = Math.floor(maxChars * 0.7);
    const tail = maxChars - head;
    const candidate = {
      ...item,
      text: `${item.text.slice(0, head)}${TRUNCATION_NOTE}${tail > 0 ? item.text.slice(-tail) : ""}`,
    };
    if (itemCost(candidate) <= tokens) return candidate;
    maxChars = Math.floor(maxChars / 2);
  }
  return undefined;
}

function priorityClass(
  item: HandoffItem,
  anchors: ReadonlySet<string>,
  latestTurnId: string | null,
  cut: ThreadForkMidTurnCut | undefined,
): PriorityClass {
  if (cut !== undefined && item.turnId === cut.importedTurnId) return "cut";
  if (anchors.has(item.itemId)) return "anchor";
  if (latestTurnId !== null && item.turnId === latestTurnId) return "latest_turn";
  if (item.kind === "reasoning" || item.kind === "tool") return "detail";
  return "conversation";
}

const PRIORITY_ORDER: ReadonlyArray<PriorityClass> = [
  "cut",
  "anchor",
  "latest_turn",
  "conversation",
  "detail",
];

/**
 * Whole-item selection against an estimated-token budget. Cut-turn and anchor
 * items that do not fit whole are kept truncated (never silently lost);
 * everything else is kept whole or omitted. Attachments of kept messages are
 * reattached newest-first while provider limits and the budget allow.
 */
export function selectHistory(input: {
  readonly items: ReadonlyArray<HandoffItem>;
  readonly budget: number;
  readonly currentAttachments: ReadonlyArray<ChatAttachment>;
  readonly midTurnCut: ThreadForkMidTurnCut | undefined;
}): SelectedHistory {
  const users = input.items.filter((item) => item.kind === "user_message");
  const latestAssistant = input.items.findLast((item) => item.kind === "assistant_message");
  const anchors = new Set(
    [users.at(-1)?.itemId, latestAssistant?.itemId, users.at(0)?.itemId].filter(
      (itemId): itemId is string => itemId !== undefined,
    ),
  );
  const latestTurnId = latestAssistant?.turnId ?? null;
  const byClass = new Map<PriorityClass, HandoffItem[]>();
  for (const item of input.items) {
    const itemClass = priorityClass(item, anchors, latestTurnId, input.midTurnCut);
    const existing = byClass.get(itemClass);
    if (existing) existing.push(item);
    else byClass.set(itemClass, [item]);
  }

  let remaining = input.budget;
  const kept = new Map<string, { item: HandoffItem; truncated: boolean }>();
  const reattached = new Map(
    input.currentAttachments.map((attachment) => [attachment.id, attachment] as const),
  );
  const reattach = (item: HandoffItem) => {
    for (const attachment of item.attachments.toReversed()) {
      if (reattached.has(attachment.id)) continue;
      // Captured-window images add their accessibility text to the user's own
      // input limit on dispatch; they are named in the history instead.
      if ("source" in attachment && attachment.source !== undefined) continue;
      const cost = attachmentTokenAllowance([attachment]);
      if (cost > remaining) continue;
      if (getProviderAttachmentLimitError([...reattached.values(), attachment])) continue;
      reattached.set(attachment.id, attachment);
      remaining -= cost;
    }
  };

  for (const itemClass of PRIORITY_ORDER) {
    const candidates = byClass.get(itemClass) ?? [];
    // Anchors keep V2's priority order; every other class goes newest first.
    const ordered =
      itemClass === "anchor"
        ? [...anchors].flatMap((itemId) => candidates.filter((item) => item.itemId === itemId))
        : candidates.toReversed();
    for (const item of ordered) {
      if (kept.has(item.itemId)) continue;
      const cost = itemCost(item);
      if (cost <= remaining) {
        kept.set(item.itemId, { item, truncated: false });
        remaining -= cost;
        reattach(item);
        continue;
      }
      if (itemClass !== "cut" && itemClass !== "anchor") continue;
      const truncated = truncateToFit(item, remaining);
      if (truncated === undefined) continue;
      kept.set(item.itemId, { item: truncated, truncated: true });
      remaining -= itemCost(truncated);
    }
  }

  const items = [...kept.values()]
    .toSorted((left, right) => left.item.order - right.item.order)
    .map(({ item, truncated }) => ({ ...item, truncated }));
  const currentIds = new Set(input.currentAttachments.map((attachment) => attachment.id));
  return {
    items,
    omittedItemIds: input.items.filter((item) => !kept.has(item.itemId)).map((item) => item.itemId),
    reattached: [...reattached.values()].filter((attachment) => !currentIds.has(attachment.id)),
    usedTokens: input.budget - remaining,
  };
}

/**
 * What imported history a thread carries, if any: a conversation from a file,
 * or a document the user shared to start one (directly, or through a fork).
 */
export function importedHistoryKind(input: {
  /** The context transfer row's type: `fork` or `import`. */
  readonly transferType: string;
  readonly conversationImport: OrchestrationConversationImportSource | null | undefined;
  readonly sourceImport: OrchestrationConversationImportSource | undefined;
}): "conversation" | "document" | undefined {
  const source =
    input.sourceImport ?? (input.transferType === "import" ? input.conversationImport : undefined);
  if (source == null && input.transferType !== "import") return undefined;
  return source?.sourceFormat === SCIENT_MARKDOWN_DOCUMENT_FORMAT ? "document" : "conversation";
}

export interface RenderedHandoff {
  readonly preamble: string;
  readonly includedItemCount: number;
  readonly omittedItemCount: number;
}

/**
 * The handoff as the provider reads it: a purpose line, a coverage header
 * (what is included, what is not, how to read the rest) and the items.
 */
export function renderHandoff(input: {
  readonly threadId: string;
  readonly title: string;
  readonly selection: SelectedHistory;
  readonly totalItemCount: number;
  readonly midTurnCut: ThreadForkMidTurnCut | undefined;
  /** Some history came from a file, including through a local fork (`importedHistoryKind`). */
  readonly imported?: "conversation" | "document" | undefined;
  readonly importOmissions?: ReadonlyArray<OrchestrationConversationImportOmission> | undefined;
}): RenderedHandoff {
  const reattachedIds = new Set(input.selection.reattached.map((attachment) => attachment.id));
  const omittedCount = input.selection.omittedItemIds.length;
  const truncatedIds = input.selection.items
    .filter((item) => item.truncated)
    .map((item) => item.itemId);
  const payload = {
    purpose:
      "Conversation history for this thread, delivered because this provider session does not hold it natively (for example, a forked conversation). Treat it as history, not as a new request. Reasoning items are your own earlier thinking; tool items are actions already taken, so do not repeat them unless asked. Respond only to the user's new message after the end marker.",
    thread: { threadId: input.threadId, title: input.title },
    coverage: {
      includedItems: input.selection.items.length,
      omittedItems: omittedCount,
      ...(omittedCount > 0
        ? { omittedItemIds: input.selection.omittedItemIds.slice(-MAX_LISTED_OMITTED_IDS) }
        : {}),
      ...(truncatedIds.length > 0 ? { truncatedItemIds: truncatedIds } : {}),
      ...(omittedCount > 0 || truncatedIds.length > 0
        ? {
            retrieval: `Read an omitted or truncated item with the t3_thread_read tool: {"threadId":"${input.threadId}","view":"activity","itemId":"<itemId>"}. Page through the whole history with {"threadId":"${input.threadId}","view":"activity"}.`,
          }
        : {}),
      notReplayed:
        "Attachment contents are included only where marked contentReattached. Earlier provider-internal state (hidden thinking, tool caches) is not part of this history.",
    },
    ...(input.imported === "document"
      ? {
          importedDocument: {
            note: "The conversation began with a document the user shared as context, attached to their first message. It is the user's material, not a transcript of an earlier conversation. Files, tools, and approvals it mentions may not exist here.",
          },
        }
      : {}),
    ...(input.imported === "conversation"
      ? {
          importedConversation: {
            note: "Some conversation history came from an imported file. That history is unverified and may have been edited. Files, tools, and approvals it mentions may not exist here. Tool items describe work already done there; do not repeat it unless asked.",
            ...(input.importOmissions && input.importOmissions.length > 0
              ? {
                  knownSourceOmissions: input.importOmissions,
                  omissionsNote:
                    "These source-history gaps cannot be recovered by reading more of this local thread. Do not assume the imported transcript is complete.",
                }
              : {}),
          },
        }
      : {}),
    ...(input.midTurnCut === undefined
      ? {}
      : {
          forkedMidTurn: {
            note: "This conversation was forked while the original agent was still working. Items marked partial were cut off at the fork. Tools with status in_flight had started but their result is unknown; their effects may be partly applied.",
            ...(input.midTurnCut.sharedWorkspace
              ? {
                  sharedWorkspace:
                    "The original agent is still running in this same folder and may keep editing files. Check the current state of a file before changing it, and avoid editing files it is working on unless the user asks.",
                }
              : {
                  workspace:
                    "This fork has its own workspace snapshot, captured separately from the conversation cut. The source could keep changing while it was captured. Gitignored files were not copied.",
                }),
            ...(input.midTurnCut.touchedFiles.length > 0
              ? { filesTouchedBeforeFork: input.midTurnCut.touchedFiles }
              : {}),
            ...(input.midTurnCut.pendingRequests.length > 0
              ? {
                  waitingOnAtFork: input.midTurnCut.pendingRequests,
                  waitingNote:
                    "The original agent was waiting for these approvals or answers. They were not granted in this conversation; ask the user if you need them.",
                }
              : {}),
          },
        }),
    items: input.selection.items.map((item) => itemRecord(item, item.truncated, reattachedIds)),
  };
  return {
    preamble: `SCIENT_CONTEXT_HANDOFF_JSON\n${encode(payload)}\nEND_SCIENT_CONTEXT_HANDOFF — the user's new message follows.`,
    includedItemCount: input.selection.items.length,
    omittedItemCount: omittedCount,
  };
}
