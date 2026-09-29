/**
 * The export projection of a thread's activities: an explicit allowlist of
 * activity kinds, each mapped to a fixed set of display fields. Provider
 * payload objects are read field by field and never copied, and nothing
 * executable (approval requests, unanswered questions) is produced.
 */
import {
  isToolLifecycleItemType,
  type ConversationAttachment,
  type ConversationBoundedText,
  type ConversationQuestionAnswer,
  type ConversationWorkLogEntry,
  type ConversationWorkLogStatus,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { boundItems, boundText, type TextBounds } from "./boundedText.ts";

const TITLE_MAX_CHARS = 512;
const COMMAND_BOUNDS: TextBounds = {
  headLines: 12,
  tailLines: 4,
  headChars: 2_000,
  tailChars: 500,
};
const DETAIL_BOUNDS: TextBounds = { headLines: 20, tailLines: 5, headChars: 2_000, tailChars: 500 };
const OUTPUT_BOUNDS: TextBounds = {
  headLines: 30,
  tailLines: 15,
  headChars: 6_000,
  tailChars: 2_000,
};
const MAX_CHANGED_FILES = 50;
const MAX_PLAN_STEPS = 100;

type UnknownRecord = { readonly [key: string]: unknown };

function field(value: unknown, key: string): unknown {
  return Predicate.isObject(value) && !Array.isArray(value)
    ? (value as UnknownRecord)[key]
    : undefined;
}

function text(value: unknown): string | null {
  if (!Predicate.isString(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function title(value: string): string {
  return value.length <= TITLE_MAX_CHARS ? value : `${value.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

/**
 * Where an imported activity keeps what its sender's export left out, so that
 * exporting it again says so again: the kept text already ends in its own
 * "[… N lines omitted …]" line, and a kept list is already cut.
 */
const IMPORTED_OMISSIONS_KEY = "scientExportOmissions";

interface TextOmission {
  readonly lines: number;
  readonly chars: number;
}

interface ImportedOmissions {
  readonly command?: TextOmission | undefined;
  readonly detail?: TextOmission | undefined;
  readonly output?: TextOmission | undefined;
  readonly explanation?: TextOmission | undefined;
  readonly changedFiles?: number | undefined;
  readonly steps?: number | undefined;
}

function textOmission(value: ConversationBoundedText | null): TextOmission | undefined {
  return value === null || (value.omittedLines === 0 && value.omittedChars === 0)
    ? undefined
    : { lines: value.omittedLines, chars: value.omittedChars };
}

/**
 * The payload fields an imported work-log entry's activity carries for what
 * the sender's export left out; empty when nothing was.
 */
export function importedWorkLogOmissions(entry: ConversationWorkLogEntry): {
  readonly [IMPORTED_OMISSIONS_KEY]?: ImportedOmissions;
} {
  const candidates: ImportedOmissions = {
    ...(entry._tag === "tool"
      ? {
          command: textOmission(entry.command),
          output: textOmission(entry.output),
          changedFiles: entry.omittedChangedFiles,
        }
      : {}),
    ...("detail" in entry ? { detail: textOmission(entry.detail) } : {}),
    ...(entry._tag === "plan-steps"
      ? { explanation: textOmission(entry.explanation), steps: entry.omittedSteps }
      : {}),
  };
  const omissions = Object.fromEntries(
    Object.entries(candidates).filter(([, value]) => value !== undefined && value !== 0),
  );
  return Object.keys(omissions).length === 0 ? {} : { [IMPORTED_OMISSIONS_KEY]: omissions };
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

function readTextOmission(value: unknown): TextOmission | undefined {
  const lines = count(field(value, "lines"));
  const chars = count(field(value, "chars"));
  return lines === 0 && chars === 0 ? undefined : { lines, chars };
}

/** What an imported activity's sender left out, as recorded at import; nothing for others. */
function importedOmissions(payload: unknown): ImportedOmissions {
  const value = field(payload, IMPORTED_OMISSIONS_KEY);
  if (!Predicate.isObject(value)) return {};
  return {
    command: readTextOmission(field(value, "command")),
    detail: readTextOmission(field(value, "detail")),
    output: readTextOmission(field(value, "output")),
    explanation: readTextOmission(field(value, "explanation")),
    changedFiles: count(field(value, "changedFiles")),
    steps: count(field(value, "steps")),
  };
}

/** The longest omission line `boundText` writes, with its line breaks. */
const OMISSION_LINE_MAX_CHARS = 48;

function bounded(
  value: string | null,
  bounds: TextBounds,
  earlier?: TextOmission,
): ConversationBoundedText | null {
  if (value === null) return null;
  const result = boundText(value, bounds);
  if (earlier === undefined) return result;
  // Imported text was bounded by its sender and already holds its omission
  // line; it is kept as it is, with the sender's counts. Text longer than any
  // bounded text is bounded again, and what that cuts is counted too.
  const alreadyBounded =
    value.split("\n").length <= bounds.headLines + bounds.tailLines + 1 &&
    value.length <= bounds.headChars + bounds.tailChars + OMISSION_LINE_MAX_CHARS;
  return alreadyBounded
    ? { text: value, omittedLines: earlier.lines, omittedChars: earlier.chars }
    : {
        ...result,
        omittedLines: result.omittedLines + earlier.lines,
        omittedChars: result.omittedChars + earlier.chars,
      };
}

function commandText(value: unknown): string | null {
  const direct = text(value);
  if (direct !== null) return direct;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    const partText = text(part);
    return partText === null
      ? []
      : [/[\s"'`]/u.test(partText) ? JSON.stringify(partText) : partText];
  });
  return parts.length > 0 ? parts.join(" ") : null;
}

function status(value: unknown): ConversationWorkLogStatus | null {
  switch (text(value)?.toLowerCase()) {
    case "inprogress":
    case "in_progress":
    case "in-progress":
    case "running":
    case "pending":
      return "in-progress";
    case "completed":
    case "complete":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "declined":
    case "denied":
    case "rejected":
      return "declined";
    case "stopped":
    case "cancelled":
    case "canceled":
    case "interrupted":
      return "stopped";
    default:
      return null;
  }
}

function toolCommand(payload: unknown): string | null {
  const data = field(payload, "data");
  const item = field(data, "item");
  for (const candidate of [
    field(item, "command"),
    field(field(item, "input"), "command"),
    field(field(item, "result"), "command"),
    field(data, "command"),
  ]) {
    const command = commandText(candidate);
    if (command !== null) return command;
  }
  return null;
}

function toolOutput(payload: unknown): string | null {
  const data = field(payload, "data");
  const item = field(data, "item");
  const rawOutput = field(data, "rawOutput");
  const streams = [text(field(rawOutput, "stdout")), text(field(rawOutput, "stderr"))].filter(
    (stream): stream is string => stream !== null,
  );
  for (const candidate of [
    text(field(item, "aggregatedOutput")),
    text(field(field(item, "result"), "content")),
    text(rawOutput),
    text(field(rawOutput, "content")),
    streams.length > 0 ? streams.join("\n") : null,
    text(field(rawOutput, "output")),
    text(field(data, "result")),
  ]) {
    if (candidate !== null) return candidate;
  }
  return null;
}

function changedFiles(payload: unknown): ReadonlyArray<string> {
  const changes = field(field(field(payload, "data"), "item"), "changes");
  if (!Array.isArray(changes)) return [];
  const paths = changes.flatMap((change) => {
    const path = text(field(change, "path"));
    return path === null ? [] : [path.slice(0, 1_024)];
  });
  return [...new Set(paths)];
}

/** Rows chat hides: subagent-internal work, ExitPlanMode boundaries, and empty notices. */
function isHiddenActivity(activity: OrchestrationThreadActivity): boolean {
  const payload = activity.payload;
  const isTask = activity.kind.startsWith("task.");
  if (field(payload, "timelineBypass") === true && !isTask) return true;
  const agentId = text(field(payload, "agentId"));
  if (agentId !== null && (!isTask || field(payload, "agentKind") !== "agent")) return true;
  if (
    activity.kind.startsWith("tool.") &&
    text(field(payload, "detail"))?.startsWith("ExitPlanMode:")
  )
    return true;
  if (
    activity.kind === "runtime.warning" &&
    activity.summary.endsWith("(no displayable text content)")
  )
    return true;
  return activity.summary === "Checkpoint captured";
}

function toolEntry(activity: OrchestrationThreadActivity): ConversationWorkLogEntry {
  const payload = activity.payload;
  const itemType = text(field(payload, "itemType"));
  const command = toolCommand(payload);
  const output = toolOutput(payload);
  const detail = text(field(payload, "detail"));
  const files = boundItems(changedFiles(payload), MAX_CHANGED_FILES);
  const earlier = importedOmissions(payload);
  return {
    _tag: "tool",
    id: activity.id,
    turnId: activity.turnId,
    createdAt: activity.createdAt,
    title: title(text(field(payload, "title")) ?? activity.summary),
    itemType: itemType !== null && isToolLifecycleItemType(itemType) ? itemType : null,
    toolName: text(field(field(payload, "data"), "toolName"))?.slice(0, 256) ?? null,
    status:
      activity.kind === "tool.denied"
        ? "declined"
        : (status(field(payload, "status")) ??
          (activity.kind === "tool.completed" ? "completed" : null)),
    command: bounded(command, COMMAND_BOUNDS, earlier.command),
    // Ingestion echoes the command or the first output line into `detail`.
    detail:
      detail === command || detail === output
        ? null
        : bounded(detail, DETAIL_BOUNDS, earlier.detail),
    output: bounded(output, OUTPUT_BOUNDS, earlier.output),
    changedFiles: files.items,
    omittedChangedFiles: files.omitted + (earlier.changedFiles ?? 0),
  };
}

function mergeTool(
  previous: Extract<ConversationWorkLogEntry, { _tag: "tool" }>,
  next: Extract<ConversationWorkLogEntry, { _tag: "tool" }>,
): Extract<ConversationWorkLogEntry, { _tag: "tool" }> {
  return {
    ...next,
    // The row keeps the position where the call started.
    id: previous.id,
    createdAt: previous.createdAt,
    itemType: next.itemType ?? previous.itemType,
    toolName: next.toolName ?? previous.toolName,
    status: next.status ?? previous.status,
    command: next.command ?? previous.command,
    detail: next.detail ?? previous.detail,
    output: next.output ?? previous.output,
    changedFiles: next.changedFiles.length > 0 ? next.changedFiles : previous.changedFiles,
    omittedChangedFiles:
      next.changedFiles.length > 0 ? next.omittedChangedFiles : previous.omittedChangedFiles,
  };
}

function planSteps(
  activity: OrchestrationThreadActivity,
): Extract<ConversationWorkLogEntry, { _tag: "plan-steps" }> | null {
  const plan = field(activity.payload, "plan");
  if (!Array.isArray(plan)) return null;
  const steps = plan.flatMap((entry) => {
    const step = text(field(entry, "step"));
    if (step === null) return [];
    const stepStatus = field(entry, "status");
    return [
      {
        step: step.slice(0, 2_048),
        status:
          stepStatus === "completed"
            ? ("completed" as const)
            : stepStatus === "inProgress"
              ? ("in-progress" as const)
              : ("pending" as const),
      },
    ];
  });
  if (steps.length === 0) return null;
  const boundedSteps = boundItems(steps, MAX_PLAN_STEPS);
  const earlier = importedOmissions(activity.payload);
  return {
    _tag: "plan-steps",
    id: activity.id,
    turnId: activity.turnId,
    createdAt: activity.createdAt,
    explanation: bounded(
      text(field(activity.payload, "explanation")),
      DETAIL_BOUNDS,
      earlier.explanation,
    ),
    steps: boundedSteps.items,
    omittedSteps: boundedSteps.omitted + (earlier.steps ?? 0),
  };
}

export interface WorkLogProjection {
  readonly entries: ReadonlyArray<ConversationWorkLogEntry>;
  /** Supported activities whose payload could not be read. */
  readonly skipped: number;
}

/**
 * Projects activities in their recorded order. Tool lifecycle updates of one
 * call, and progress rows of one task, collapse into a single entry; a turn
 * keeps only its latest plan checklist.
 */
export function projectWorkLog(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogProjection {
  // A cleared plan leaves a hole so earlier indexes stay valid.
  const entries: Array<ConversationWorkLogEntry | null> = [];
  const toolIndex = new Map<string, number>();
  const taskIndex = new Map<string, number>();
  const planIndex = new Map<string, number>();
  let skipped = 0;

  for (const activity of activities) {
    if (isHiddenActivity(activity)) continue;
    const payload = activity.payload;
    switch (activity.kind) {
      case "tool.updated":
      case "tool.completed":
      case "tool.denied": {
        const entry = toolEntry(activity);
        if (entry._tag !== "tool") break;
        const callId = text(field(payload, "toolCallId"));
        const key = callId === null ? null : `${activity.turnId ?? "no-turn"}:${callId}`;
        const existing = key === null ? undefined : toolIndex.get(key);
        const previous = existing === undefined ? undefined : entries[existing];
        if (existing !== undefined && previous?._tag === "tool") {
          entries[existing] = mergeTool(previous, entry);
        } else {
          if (key !== null) toolIndex.set(key, entries.length);
          entries.push(entry);
        }
        break;
      }
      case "task.started":
      case "task.progress":
      case "task.completed": {
        const taskId = text(field(payload, "taskId"));
        const label =
          text(field(payload, "summary")) ??
          text(field(payload, "title")) ??
          text(field(payload, "detail")) ??
          activity.summary;
        const entry: ConversationWorkLogEntry = {
          _tag: "task",
          id: activity.id,
          turnId: activity.turnId,
          createdAt: activity.createdAt,
          title: title(label),
          status:
            activity.kind === "task.completed"
              ? (status(field(payload, "status")) ?? "completed")
              : "in-progress",
          agentRole: text(field(payload, "role"))?.slice(0, 256) ?? null,
          detail:
            text(field(payload, "detail")) === label
              ? null
              : bounded(
                  text(field(payload, "detail")),
                  DETAIL_BOUNDS,
                  importedOmissions(payload).detail,
                ),
        };
        const existing = taskId === null ? undefined : taskIndex.get(taskId);
        const previous = existing === undefined ? undefined : entries[existing];
        if (existing !== undefined && previous?._tag === "task") {
          entries[existing] = {
            ...entry,
            id: previous.id,
            createdAt: previous.createdAt,
            turnId: previous.turnId,
            agentRole: entry.agentRole ?? previous.agentRole,
            detail: entry.detail ?? previous.detail,
          };
        } else {
          if (taskId !== null) taskIndex.set(taskId, entries.length);
          entries.push(entry);
        }
        break;
      }
      case "runtime.warning":
      case "runtime.error": {
        const message = text(field(payload, "message")) ?? text(field(payload, "detail"));
        entries.push({
          _tag: "notice",
          id: activity.id,
          turnId: activity.turnId,
          createdAt: activity.createdAt,
          level: activity.kind === "runtime.error" ? "error" : "warning",
          title: title(activity.summary),
          detail:
            message === activity.summary
              ? null
              : bounded(message, DETAIL_BOUNDS, importedOmissions(payload).detail),
        });
        break;
      }
      case "context-compaction":
        entries.push({
          _tag: "compaction",
          id: activity.id,
          turnId: activity.turnId,
          createdAt: activity.createdAt,
          title: title(activity.summary),
        });
        break;
      case "turn.plan.updated": {
        const entry = planSteps(activity);
        const key = activity.turnId ?? "no-turn";
        const existing = planIndex.get(key);
        if (entry === null) {
          // A plan without readable steps clears the turn's checklist, as in chat.
          if (!Array.isArray(field(payload, "plan"))) skipped += 1;
          if (existing !== undefined) {
            entries[existing] = null;
            planIndex.delete(key);
          }
          break;
        }
        if (existing !== undefined) {
          const previous = entries[existing];
          entries[existing] = {
            ...entry,
            id: previous?.id ?? entry.id,
            createdAt: previous?.createdAt ?? entry.createdAt,
          };
        } else {
          planIndex.set(key, entries.length);
          entries.push(entry);
        }
        break;
      }
      default:
        // Orchestration failures (`*.failed`) are shown in chat as error rows.
        if (activity.kind.endsWith(".failed")) {
          entries.push({
            _tag: "notice",
            id: activity.id,
            turnId: activity.turnId,
            createdAt: activity.createdAt,
            level: "error",
            title: title(activity.summary),
            detail: null,
          });
        }
        break;
    }
  }
  return {
    entries: entries.filter((entry): entry is ConversationWorkLogEntry => entry !== null),
    skipped,
  };
}

function answerText(value: unknown, labels: ReadonlyMap<string, string>): string {
  if (Predicate.isString(value)) return labels.get(value) ?? value;
  if (Array.isArray(value))
    return value
      .map((answer) => answerText(answer, labels))
      .filter(Boolean)
      .join(", ");
  return Predicate.isObject(value) ? answerText(field(value, "answers"), labels) : "";
}

export interface QuestionAnswerProjection {
  readonly questionAnswers: ReadonlyArray<ConversationQuestionAnswer>;
  readonly skipped: number;
}

/**
 * One entry per question request that received an answer, folded the way chat
 * folds it (`foldUserInputActivities`): question texts and option labels from
 * the request, answers from the latest `user-input.answer-submitted` or, when
 * there is none, the latest `user-input.resolved`, and attachments from every
 * activity of the request. Providers report ordinary answers only through
 * `user-input.resolved`; `answer-submitted` is added for attachment-bearing
 * responses. Pending, dismissed, and unanswered requests produce nothing.
 * `toAttachment` resolves a recorded answer attachment, or null when unreadable.
 */
export function projectQuestionAnswers(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  toAttachment: (value: unknown) => ConversationAttachment | null,
): QuestionAnswerProjection {
  interface Request {
    first: OrchestrationThreadActivity;
    questionTexts: Map<string, string>;
    optionLabels: Map<string, Map<string, string>>;
    submitted: OrchestrationThreadActivity | null;
    resolved: OrchestrationThreadActivity | null;
    attachmentsByQuestionId: Map<string, ReadonlyArray<unknown>>;
    malformed: boolean;
  }
  const requests = new Map<string, Request>();
  for (const activity of activities) {
    if (
      activity.kind !== "user-input.requested" &&
      activity.kind !== "user-input.resolved" &&
      activity.kind !== "user-input.answer-submitted"
    )
      continue;
    const requestId = text(field(activity.payload, "requestId"));
    if (requestId === null) continue;
    let request = requests.get(requestId);
    if (!request) {
      request = {
        first: activity,
        questionTexts: new Map(),
        optionLabels: new Map(),
        submitted: null,
        resolved: null,
        attachmentsByQuestionId: new Map(),
        malformed: false,
      };
      requests.set(requestId, request);
    }
    const questionTextById = field(activity.payload, "questionTextById");
    if (Predicate.isObject(questionTextById)) {
      for (const [id, value] of Object.entries(questionTextById)) {
        const questionText = text(value);
        if (questionText !== null) request.questionTexts.set(id, questionText);
      }
    }
    const questions = field(activity.payload, "questions");
    for (const question of Array.isArray(questions) ? questions : []) {
      const id = text(field(question, "id"));
      if (id === null) continue;
      const questionText = text(field(question, "question"));
      if (questionText !== null) request.questionTexts.set(id, questionText);
      const options = field(question, "options");
      const labels = new Map<string, string>();
      for (const option of Array.isArray(options) ? options : []) {
        const value = text(field(option, "value"));
        const label = text(field(option, "label"));
        if (value !== null && label !== null) labels.set(value, label);
      }
      request.optionLabels.set(id, labels);
    }
    const attachmentsByQuestionId = field(activity.payload, "attachmentsByQuestionId");
    if (Predicate.isObject(attachmentsByQuestionId)) {
      for (const [id, value] of Object.entries(attachmentsByQuestionId)) {
        if (Array.isArray(value)) request.attachmentsByQuestionId.set(id, value);
      }
    }
    if (activity.kind !== "user-input.requested") {
      if (Predicate.isObject(field(activity.payload, "answers"))) {
        if (activity.kind === "user-input.answer-submitted") request.submitted = activity;
        else request.resolved = activity;
      } else if (field(activity.payload, "answers") !== undefined) {
        request.malformed = true;
      }
    }
  }

  const questionAnswers: ConversationQuestionAnswer[] = [];
  let skipped = 0;
  for (const [requestId, request] of requests) {
    const answering = request.submitted ?? request.resolved;
    const answers =
      answering === null ? {} : (field(answering.payload, "answers") as UnknownRecord);
    if (answering === null && request.attachmentsByQuestionId.size === 0) {
      if (request.malformed) skipped += 1;
      continue;
    }
    const questionIds = [
      ...new Set([...Object.keys(answers), ...request.attachmentsByQuestionId.keys()]),
    ];
    const items = questionIds.flatMap((questionId) => {
      const answer = answerText(
        answers[questionId],
        request.optionLabels.get(questionId) ?? new Map(),
      ).trim();
      const attachments = (request.attachmentsByQuestionId.get(questionId) ?? []).flatMap(
        (value: unknown) => {
          const attachment = toAttachment(value);
          return attachment === null ? [] : [attachment];
        },
      );
      if (answer.length === 0 && attachments.length === 0) return [];
      return [{ question: request.questionTexts.get(questionId) ?? null, answer, attachments }];
    });
    if (items.length === 0) continue;
    questionAnswers.push({
      id: requestId,
      turnId: request.first.turnId ?? answering?.turnId ?? null,
      createdAt: request.first.createdAt,
      items,
    });
  }
  return { questionAnswers, skipped };
}
