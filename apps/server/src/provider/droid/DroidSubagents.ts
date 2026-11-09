/**
 * ACP exposes Droid Task calls, not child steps. Foreground cancellation may repeat the same empty
 * call ID. A background Task before 1.2.0 completes at once and reports later only through
 * TaskOutput; from 1.2.0 its call stays open until the sub-agent ends, possibly after the turn.
 * Derive one subagent presentation per Task and suppress its duplicate tool row.
 */
import * as Predicate from "effect/Predicate";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

interface DroidSubagentLinkage {
  readonly taskId: string;
  readonly taskType: "subagent";
  readonly title: string;
  readonly toolUseId: string;
  readonly role?: string;
}
interface DroidTaskEvent<T, P> {
  readonly type: T;
  readonly turnId: string | undefined;
  readonly payload: DroidSubagentLinkage & P;
}
export type DroidSubagentEvent =
  | DroidTaskEvent<"task.started", { readonly description: string }>
  | DroidTaskEvent<
      "task.progress",
      { readonly description: string; readonly summary: string; readonly status: "running" }
    >
  | DroidTaskEvent<
      "task.updated",
      {
        readonly status: "cancelled" | "interrupted" | "idle";
        readonly error?: string;
        readonly description?: string;
      }
    >
  | DroidTaskEvent<
      "task.completed",
      { readonly status: "completed" | "failed"; readonly summary?: string }
    >;
type TaskEvent<T extends DroidSubagentEvent["type"]> = Extract<
  DroidSubagentEvent,
  { readonly type: T }
>;

interface DroidSubagent {
  readonly toolCallId: string;
  readonly title: string;
  readonly role: string | undefined;
  readonly turnId: string | undefined;
  /** `background`: launched to run on its own; see `reportsEnd`. */
  state: "running" | "background" | "ended";
  /** Droid ends the Task call itself when the sub-agent ends, even after the turn. */
  reportsEnd: boolean;
}

interface DroidSubagentWait {
  readonly subagent: DroidSubagent | undefined;
  readonly block: boolean;
  readonly timeoutMillis: number | undefined;
}

export interface DroidSubagentTracker {
  /** By the `Task` tool call id, which is also the task id. Ended ones stay, to recognize a re-announced call. */
  readonly subagents: Map<string, DroidSubagent>;
  /** By Droid's own task id, which `TaskOutput` and `TaskStop` name. */
  readonly background: Map<string, DroidSubagent>;
  /** `TaskOutput` calls that have not returned, by tool call id. */
  readonly waits: Map<string, DroidSubagentWait>;
}

export const makeDroidSubagentTracker = (): DroidSubagentTracker => ({
  subagents: new Map(),
  background: new Map(),
  waits: new Map(),
});

/** Ended sub-agents kept to recognize late or repeated reports; a long session stays bounded. */
const MAX_TRACKED_SUBAGENTS = 200;
const SUMMARY_MAX_CHARS = 2_000;

const DROID_SUBAGENT_STEPS_NOTE = "Droid reports a sub-agent's steps only when it finishes.";
const BACKGROUND_NOTE =
  "Running in the background. Droid reports on it only when it finishes or the main agent checks.";

const record = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
const bounded = (value: string): string =>
  value.length <= SUMMARY_MAX_CHARS ? value : `${value.slice(0, SUMMARY_MAX_CHARS - 1)}…`;

/** Nested `Task` sub-agents: Droid names the sub-agent type, or titles the call "Task". */
function isDroidNestedTaskToolCall(input: {
  readonly title?: string | null | undefined;
  readonly rawInput?: unknown;
}): boolean {
  const subagentType = record(input.rawInput)?.subagent_type;
  if (typeof subagentType === "string") return subagentType.trim().length > 0;
  return (input.title ?? "").trim().toLowerCase() === "task";
}

/** Droid's id for a sub-agent's own session, which 1.2.0 reports as the call starts. */
const childSessionId = (toolCall: AcpToolCallState) =>
  text(record(record(toolCall.data.meta)?.subagent_session_info)?.session_id);

function isDroidTaskOutputToolCall(title: string | undefined, rawInput: unknown): boolean {
  if ((title ?? "").trim().toLowerCase() === "taskoutput") return true;
  const input = record(rawInput);
  return typeof input?.task_id === "string" && "block" in input;
}

/** What the tool call returned or failed with, as Droid wrote it. */
function toolCallText(toolCall: AcpToolCallState): string | undefined {
  const output = text(record(toolCall.data.rawOutput)?.text);
  if (output) return output;
  const content = toolCall.data.content;
  if (Array.isArray(content)) {
    const parts = content.flatMap((entry) => {
      const part = text(record(record(entry)?.content)?.text);
      return part ? [part] : [];
    });
    if (parts.length > 0) return parts.join("\n");
  }
  return text(toolCall.detail);
}

const withoutErrorPrefix = (value: string) => value.replace(/^Error:\s*/u, "");

/** `600000` → `10 min`, `90000` → `90 s`. */
function formatWait(millis: number): string {
  return millis % 60_000 === 0 ? `${millis / 60_000} min` : `${Math.round(millis / 1_000)} s`;
}

const linkage = (subagent: DroidSubagent) => ({
  taskId: subagent.toolCallId,
  taskType: "subagent" as const,
  title: subagent.title,
  toolUseId: subagent.toolCallId,
  ...(subagent.role ? { role: subagent.role } : {}),
});

const progress = (subagent: DroidSubagent, summary: string): TaskEvent<"task.progress"> => ({
  type: "task.progress",
  turnId: subagent.turnId,
  payload: { ...linkage(subagent), description: subagent.title, summary, status: "running" },
});

const ended = (
  subagent: DroidSubagent,
  outcome:
    | { readonly status: "completed" | "failed"; readonly summary: string | undefined }
    | {
        readonly status: "cancelled" | "interrupted" | "idle";
        readonly error?: string | undefined;
        readonly description?: string | undefined;
      },
): DroidSubagentEvent => {
  subagent.state = "ended";
  if ("summary" in outcome) {
    return {
      type: "task.completed",
      turnId: subagent.turnId,
      payload: {
        ...linkage(subagent),
        status: outcome.status,
        ...(outcome.summary ? { summary: bounded(outcome.summary) } : {}),
      },
    };
  }
  return {
    type: "task.updated",
    turnId: subagent.turnId,
    payload: {
      ...linkage(subagent),
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.description ? { description: outcome.description } : {}),
    },
  };
};

/** The fields of a `TaskOutput` answer: a header of `Name: value` lines, then the report. */
function parseTaskReport(report: string) {
  const field = (name: string) =>
    text(new RegExp(`^${name}:[ \\t]*(.*)$`, "imu").exec(report)?.[1]);
  const latest = /^Latest progress:[ \t]*([\s\S]*)$/imu.exec(report)?.[1];
  const body = report
    .split(/\n\s*\n/u)
    .slice(1)
    .join("\n\n");
  return {
    status: field("Status")?.toLowerCase(),
    description: field("Description"),
    detail: text(latest) ?? text(body),
  };
}

const RUNNING_STATUSES = new Set(["running", "pending", "in_progress", "in progress", "queued"]);
const COMPLETED_STATUSES = new Set(["completed", "complete", "done", "finished", "succeeded"]);
const FAILED_STATUSES = new Set(["failed", "error", "errored", "timed_out", "timed out"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "killed", "stopped", "aborted"]);

interface DroidSubagentToolCall {
  readonly events: ReadonlyArray<DroidSubagentEvent>;
  /**
   * The tool row to show: `unchanged` for a call that is not about a
   * sub-agent, `none` for a `Task` call (its sub-agent row replaces it), or
   * the `TaskOutput` call saying which sub-agent the main agent waits for.
   */
  readonly item: "unchanged" | "none" | AcpToolCallState;
}

/**
 * Folds one tool call report into the tracker. Call it with the runtime's
 * merged state for the call, in arrival order.
 */
export function observeDroidSubagentToolCall(
  tracker: DroidSubagentTracker,
  toolCall: AcpToolCallState,
  turnId: string | undefined,
): DroidSubagentToolCall {
  const id = toolCall.toolCallId;
  const rawInput = record(toolCall.data.rawInput);
  // The state's title is a display summary ("Tool" for a TaskStop); Droid's own is in data.
  const nativeTitle = text(toolCall.data.title) ?? toolCall.title;
  const known = tracker.subagents.get(id);
  if (known || isDroidNestedTaskToolCall({ title: nativeTitle, rawInput })) {
    // Droid announces a cancelled call again and fails it again: one sub-agent, already ended.
    if (known?.state === "ended") return { events: [], item: "none" };
    const events: Array<DroidSubagentEvent> = [];
    const subagent: DroidSubagent = known ?? {
      toolCallId: id,
      title: text(rawInput?.description) ?? "Sub-agent",
      role: text(rawInput?.subagent_type),
      turnId,
      state: "running",
      reportsEnd: false,
    };
    if (!known) {
      tracker.subagents.set(id, subagent);
      if (tracker.subagents.size > MAX_TRACKED_SUBAGENTS) {
        const oldest = [...tracker.subagents.values()].find((entry) => entry.state === "ended");
        if (oldest) {
          tracker.subagents.delete(oldest.toolCallId);
          for (const [alias, entry] of tracker.background)
            if (entry === oldest) tracker.background.delete(alias);
        }
      }
      events.push(
        {
          type: "task.started",
          turnId,
          payload: { ...linkage(subagent), description: subagent.title },
        },
        progress(subagent, DROID_SUBAGENT_STEPS_NOTE),
      );
    }
    const droidId = childSessionId(toolCall);
    if (droidId) tracker.background.set(droidId, subagent);
    const result = toolCallText(toolCall);
    // Droid 1.2.0 keeps a background call open, with this text, until the sub-agent ends.
    if (
      toolCall.status === "inProgress" &&
      subagent.state === "running" &&
      result !== undefined &&
      /^Running in background\b/iu.test(result)
    ) {
      subagent.state = "background";
      subagent.reportsEnd = true;
      events.push(progress(subagent, BACKGROUND_NOTE));
    } else if (toolCall.status === "completed") {
      // Before 1.2.0 a background launch completes the call with this acknowledgement.
      const launched = result !== undefined && /^Task launched in background\b/iu.test(result);
      const backgroundId = launched ? text(/^task_id:[ \t]*(\S+)/imu.exec(result)?.[1]) : undefined;
      if (backgroundId && subagent.state === "running") {
        subagent.state = "background";
        tracker.background.set(backgroundId, subagent);
        events.push(progress(subagent, BACKGROUND_NOTE));
      } else if (!launched) {
        events.push(ended(subagent, { status: "completed", summary: result }));
      }
    } else if (toolCall.status === "failed") {
      const reason = result ? withoutErrorPrefix(result) : undefined;
      events.push(
        reason && /\bcancell?ed\b/iu.test(reason)
          ? ended(subagent, { status: "cancelled", error: reason })
          : ended(subagent, { status: "failed", summary: reason }),
      );
    }
    return { events, item: "none" };
  }

  if ((nativeTitle ?? "").trim().toLowerCase() === "taskstop")
    return observeDroidTaskStop(tracker, toolCall, rawInput);

  const pending = tracker.waits.get(id);
  if (!pending && !isDroidTaskOutputToolCall(nativeTitle, rawInput)) {
    return { events: [], item: "unchanged" };
  }
  const wait: DroidSubagentWait = pending ?? {
    subagent: tracker.background.get(text(rawInput?.task_id) ?? ""),
    block: rawInput?.block === true,
    timeoutMillis:
      typeof rawInput?.timeout === "number" && rawInput.timeout > 0 ? rawInput.timeout : undefined,
  };
  const settled = toolCall.status === "completed" || toolCall.status === "failed";
  if (settled) tracker.waits.delete(id);
  else tracker.waits.set(id, wait);

  const result = toolCallText(toolCall);
  const report = toolCall.status === "completed" && result ? parseTaskReport(result) : undefined;
  const events: Array<DroidSubagentEvent> = [];
  const subagent = wait.subagent;
  if (subagent && subagent.state !== "ended" && report?.status) {
    if (RUNNING_STATUSES.has(report.status)) {
      events.push(progress(subagent, report.detail ?? BACKGROUND_NOTE));
    } else if (COMPLETED_STATUSES.has(report.status)) {
      events.push(ended(subagent, { status: "completed", summary: report.detail }));
    } else if (FAILED_STATUSES.has(report.status)) {
      events.push(ended(subagent, { status: "failed", summary: report.detail }));
    } else if (CANCELLED_STATUSES.has(report.status)) {
      events.push(
        ended(subagent, {
          status: "cancelled",
          ...(report.detail ? { error: report.detail } : {}),
        }),
      );
    }
  }
  const name = subagent?.title ?? report?.description;
  const about = name ? `sub-agent · ${name}` : "a sub-agent";
  const limit =
    wait.block && wait.timeoutMillis !== undefined
      ? ` (up to ${formatWait(wait.timeoutMillis)})`
      : "";
  const title = wait.block
    ? toolCall.status === "completed"
      ? `Waited for ${about}`
      : `Waiting for ${about}${limit}`
    : toolCall.status === "completed"
      ? `Checked ${about}`
      : `Checking ${about}`;
  const { detail: _detail, ...rest } = toolCall;
  return {
    events,
    item: {
      ...rest,
      title,
      // The row's label is its detail when it has one: only a failure keeps Droid's text.
      ...(toolCall.status === "failed" && result ? { detail: withoutErrorPrefix(result) } : {}),
    },
  };
}

/**
 * The main agent stopping a sub-agent. A stop Droid has not confirmed leaves
 * it open; its own call then fails ("No output available"), already ended.
 */
function observeDroidTaskStop(
  tracker: DroidSubagentTracker,
  toolCall: AcpToolCallState,
  rawInput: Record<string, unknown> | undefined,
): DroidSubagentToolCall {
  const subagent = tracker.background.get(text(rawInput?.task_id) ?? "");
  const result = toolCallText(toolCall);
  const stopped =
    toolCall.status === "completed" &&
    result !== undefined &&
    /\bstopped successfully\b/iu.test(result);
  const events =
    subagent !== undefined && subagent.state !== "ended" && stopped
      ? [ended(subagent, { status: "cancelled", error: "Droid stopped this sub-agent." })]
      : [];
  const about = subagent ? `sub-agent · ${subagent.title}` : "a sub-agent";
  const { detail: _detail, ...rest } = toolCall;
  return {
    events,
    item: {
      ...rest,
      title: stopped ? `Stopped ${about}` : `Stopping ${about}`,
      // Anything but a confirmed stop keeps Droid's own words.
      ...(!stopped && result ? { detail: withoutErrorPrefix(result) } : {}),
    },
  };
}

/** Why the sub-agents that are still open end now. */
export type DroidSubagentsEnd = "stop" | "turn-ended" | "session-ended";

/** True for a background sub-agent's open call, which Droid ends only when the sub-agent does. */
export function droidSubagentOutlivesTurn(
  tracker: DroidSubagentTracker,
  toolCallId: string,
): boolean {
  const subagent = tracker.subagents.get(toolCallId);
  return subagent?.state === "background" && subagent.reportsEnd;
}

/** Ends the sub-agents Droid will not report on any more. */
export function endDroidSubagents(
  tracker: DroidSubagentTracker,
  reason: DroidSubagentsEnd,
): ReadonlyArray<DroidSubagentEvent> {
  tracker.waits.clear();
  const events: Array<DroidSubagentEvent> = [];
  for (const subagent of tracker.subagents.values()) {
    if (subagent.state === "ended") continue;
    if (reason === "turn-ended" && subagent.state === "background" && subagent.reportsEnd) continue;
    const foreground = subagent.state === "running";
    if (reason === "stop") {
      events.push(
        ended(
          subagent,
          foreground
            ? { status: "cancelled", error: "Cancelled when you stopped the turn." }
            : {
                status: "interrupted",
                error: "Scient closed this Droid session and can no longer follow this sub-agent.",
              },
        ),
      );
    } else if (reason === "turn-ended") {
      events.push(
        ended(
          subagent,
          foreground
            ? {
                status: "interrupted",
                error: "The turn ended before Droid reported this sub-agent's result.",
              }
            : {
                status: "idle",
                description: "The turn ended. Droid has not reported this sub-agent's result.",
              },
        ),
      );
    } else {
      events.push(ended(subagent, { status: "interrupted", error: "The Droid session ended." }));
    }
  }
  return events;
}

/**
 * What the idle watchdog must allow for: sub-agents still open (Droid is
 * silent while they work), and the longest wait Droid announced for a
 * blocking `TaskOutput` (`unbounded` when it named no limit). `background`:
 * the open ones that outlive the prompt that launched them.
 */
export function droidSubagentActivity(tracker: DroidSubagentTracker): {
  readonly open: number;
  readonly background: number;
  readonly announcedWaitMillis: number | "unbounded" | undefined;
} {
  let open = 0;
  let background = 0;
  for (const subagent of tracker.subagents.values()) {
    if (subagent.state !== "ended") open += 1;
    if (subagent.state === "background") background += 1;
  }
  let announcedWaitMillis: number | "unbounded" | undefined;
  for (const wait of tracker.waits.values()) {
    if (!wait.block) continue;
    announcedWaitMillis =
      wait.timeoutMillis === undefined || announcedWaitMillis === "unbounded"
        ? "unbounded"
        : Math.max(announcedWaitMillis ?? 0, wait.timeoutMillis);
  }
  return { open, background, announcedWaitMillis };
}
