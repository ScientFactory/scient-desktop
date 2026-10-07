/**
 * How a conversation's work log is grouped around its messages, and chat's
 * per-message line-break decision. Chat's
 * timeline (`MessagesTimeline.logic.ts`) and the server's conversation export
 * both call these functions, so an export groups a turn's work exactly as chat
 * does. Pure and framework-free: entries are described structurally, so chat's
 * `TimelineEntry` and the export's projection both fit without conversion.
 */
import type { TurnId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

export interface GroupingMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system" | "reasoning";
  readonly turnId?: TurnId | null | undefined;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GroupingWork {
  readonly turnId?: TurnId | null | undefined;
  readonly tone: string;
  readonly sourceActivityKind?: string | undefined;
  readonly questionAnswer?: unknown;
}

export type GroupingTimelineEntry<W extends GroupingWork = GroupingWork> =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly createdAt: string;
      readonly message: GroupingMessage;
    }
  | { readonly id: string; readonly kind: "work"; readonly createdAt: string; readonly entry: W }
  | {
      readonly id: string;
      readonly kind: "proposed-plan";
      readonly createdAt: string;
      readonly proposedPlan: { readonly turnId: TurnId | null };
    };

export interface GroupingLatestTurn {
  readonly turnId: TurnId;
  readonly state: "running" | "interrupted" | "completed" | "error";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface TurnFold {
  readonly turnId: TurnId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

/**
 * Chat's per-message line-break decision for assistant text: single line
 * breaks render as breaks (`remark-breaks`) only in "★ Insight" blocks. User
 * messages and reasoning always keep their line breaks.
 */
export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

/** The last assistant message of each response: per turn, or per user message when turnless. */
export function deriveTerminalAssistantMessageIds(
  timelineEntries: ReadonlyArray<GroupingTimelineEntry>,
): Set<string> {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
export function deriveUnsettledTurnId(
  latestTurn: Pick<GroupingLatestTurn, "turnId" | "state" | "completedAt"> | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/** The turn an entry belongs to for grouping; user messages open a response and have none. */
export function timelineEntryTurnId(entry: GroupingTimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" || entry.message.role === "reasoning"
      ? (entry.message.turnId ?? null)
      : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId;
  }
  return entry.kind === "work" ? (entry.entry.turnId ?? null) : null;
}

/**
 * Settled turns fold activity before their terminal assistant message behind
 * a "Worked for ..." row. A single ordinary activity after that message joins
 * the fold, while larger groups and failures stay visible as a trailing summary.
 */
export function deriveTurnFolds<W extends GroupingWork>(input: {
  readonly timelineEntries: ReadonlyArray<GroupingTimelineEntry<W>>;
  readonly terminalAssistantMessageIds: ReadonlySet<string>;
  readonly latestTurn: GroupingLatestTurn | null;
  readonly unfoldedTurnIds: ReadonlySet<TurnId>;
  /** Whether a work entry displays as a failed tool call. */
  readonly workIndicatesFailure: (entry: W) => boolean;
}): ReadonlyMap<string, TurnFold> {
  type Entry = GroupingTimelineEntry<W>;
  interface TurnGroup {
    entries: Array<Entry>;
    terminalEntry: Extract<Entry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    // Thinking is work, so it folds with the rest of it. A provider that
    // interleaves a block with every tool call would otherwise leave dozens of
    // "Thought" rows standing beside the "Worked for ..." summary.
    // Nothing folds while the turn is live, which is when traces are watched.
    const turnId =
      entry.kind === "message" &&
      (entry.message.role === "assistant" || entry.message.role === "reasoning")
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      // A live turn is already excluded above, so only an answer still being
      // written may hold a fold open. A thinking block stranded by a crashed
      // provider keeps its streaming flag forever and must not.
      if (entry.message.streaming && entry.message.role !== "reasoning") {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (input.unfoldedTurnIds.has(turnId)) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    // Thinking blocks do not count toward "one trailing activity": a block can
    // follow the answer, and it must not stop that lone tool call from folding
    // the way it did before traces existed. Loop-invariant, so it is counted
    // once: a long turn re-derives these rows on every work-log change.
    const trailingEntryCount = group.entries.filter(
      (candidate, candidateIndex) =>
        candidateIndex > terminalEntryIndex &&
        !(candidate.kind === "message" && candidate.message.role === "reasoning"),
    ).length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction =
        entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
      const isSingleTrailingActivity =
        trailingEntryCount === 1 &&
        entry.kind === "work" &&
        !input.workIndicatesFailure(entry.entry);
      // A thinking block after the answer folds with its turn rather than
      // trailing under it, which is what mobile already does.
      const isReasoning = entry.kind === "message" && entry.message.role === "reasoning";
      if (
        !isCompaction &&
        !isReasoning &&
        index > terminalEntryIndex &&
        !isSingleTrailingActivity
      ) {
        continue;
      }
      // User input stays visible after its turn settles.
      if (entry.kind === "work" && entry.entry.questionAnswer !== undefined) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction row stays visible on its own; it only folds away as
    // part of a turn that already folds other work. Thinking is the same: a
    // question answered by thought alone keeps its "Thought" row
    // rather than collapsing behind a "Worked for ..." that hides nothing else.
    const hidesFoldableWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction") &&
        !(entry.kind === "message" && entry.message.role === "reasoning"),
    );
    if (!hidesFoldableWork) {
      continue;
    }

    const firstEntry = group.entries[0];
    const firstHiddenEntry = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !firstHiddenEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstHiddenEntry.id, {
      turnId,
      anchorEntryId: firstHiddenEntry.id,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}
