import { McpSchema } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { FailureOwner } from "@scientfactory/analytics";
import type { ServerProvider } from "@t3tools/contracts";

import { browserSite } from "./BrowserSite.ts";
import { toolFailureAttribution } from "./FailureAttribution.ts";
import { catalogModelLabel, toolOutcome } from "./ProviderDimensions.ts";

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const TOOL_IDENTIFIERS: Readonly<Record<string, string>> = {
  scient_thread_send: "t3_thread_send",
  scient_thread_transfer: "t3_thread_transfer",
  scient_queue: "t3_queue",
  scient_pending_request: "t3_pending_request",
};

/** Keep upstream metric identifiers and decode Effect's declared JSON-text results. */
export function scientMcpAnalyticsInput(
  tool: string,
  result: McpSchema.CallToolResult | undefined,
) {
  if (result?.structuredContent !== undefined || result?.content.length !== 1)
    return { tool: TOOL_IDENTIFIERS[tool] ?? tool, result };
  const content = result.content[0];
  if (content?.type !== "text") return { tool: TOOL_IDENTIFIERS[tool] ?? tool, result };
  try {
    const structuredContent = decodeResult(content.text);
    return { tool: TOOL_IDENTIFIERS[tool] ?? tool, result: { ...result, structuredContent } };
  } catch {
    return { tool: TOOL_IDENTIFIERS[tool] ?? tool, result };
  }
}

const ERROR_CODE_NAMES: Readonly<Record<string, string>> = {
  PreviewAutomationNoAvailableHostError: "no_host",
};
const MAX_ERROR_CODE_LENGTH = 48;

/**
 * A short snake_case code for a failure's closed code or error tag:
 * `PreviewAutomationTimeoutError` becomes `timeout`. Messages are never read.
 */
export function closedErrorCode(value: string): string {
  const named = ERROR_CODE_NAMES[value];
  if (named !== undefined) return named;
  const name = value.replace(/^PreviewAutomation(?=[A-Z])/u, "").replace(/(?<=.)Error$/u, "");
  const code = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toLowerCase()
    .slice(0, MAX_ERROR_CODE_LENGTH)
    .replace(/^_+|_+$/gu, "");
  return code === "" ? "unknown" : code;
}

/** What a tool's declared failure said about itself before the MCP result kept only its message. */
export interface ToolFailureFacts {
  tag?: string;
  failureClass?: string;
  /** Why the call ended with no result, when the caller explains it rather than Scient. */
  unresulted?: "invalid_params" | "interrupted" | undefined;
  /** A browser call's site, action and unfinished stage: closed values reported with its failure. */
  browser?: BrowserCallFacts;
}

// A type, not an interface, so a tool outcome that carries it stays a plain property record.
export type BrowserCallFacts = {
  site?: string;
  action?: string;
  pendingStage?: string;
};

const isInvalidParams = Schema.is(McpSchema.InvalidParams);

/**
 * Effect's MCP server turns a handler's own failures into results; a call ends with no result
 * when its arguments are refused (InvalidParams, which the agent sees) or it is cancelled.
 */
export function unresultedToolFailure(cause: Cause.Cause<unknown>): ToolFailureFacts["unresulted"] {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted";
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && isInvalidParams(error.value) ? "invalid_params" : undefined;
}

/** One tool call's failure facts, written where the typed failure is still in hand. */
export class ToolFailureNote extends Context.Reference<ToolFailureFacts | undefined>(
  "scient/telemetry/ToolFailureNote",
  { defaultValue: () => undefined },
) {}

const stringOf = (value: unknown, key: string) =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>)[key] === "string"
    ? ((value as Record<string, unknown>)[key] as string)
    : undefined;

/**
 * A browser host that answered a timeout found the page not ready; one that never answered
 * overran. A lost tab says why control went, and a refused element says whether its ref was stale.
 * An execution failure stays unclassified: the host gives a script that threw on the page and a
 * failed browser call the same tag, so neither can be told to be the agent's code.
 */
function browserFailureClass(error: unknown): string | undefined {
  switch (stringOf(error, "_tag")) {
    case "PreviewAutomationTimeoutError":
      return stringOf(error, "remoteTag") === undefined ? "host_overrun" : "page_not_ready";
    case "PreviewAutomationControlInterruptedError": {
      const reason = stringOf(error, "reason");
      return reason === undefined ? undefined : `control_${closedErrorCode(reason)}`;
    }
    case "PreviewAutomationInvalidSelectorError": {
      if ((error as { staleRef?: unknown }).staleRef === true) return "stale_ref";
      const kind = stringOf(error, "selectorKind");
      return kind === undefined ? undefined : `bad_${kind}`;
    }
    default:
      return undefined;
  }
}

/** The first stage a timed-out snapshot still waited for, such as `page_state`. */
function browserPendingStage(error: unknown): string | undefined {
  const stages = (error as { pendingStages?: unknown } | null)?.pendingStages;
  return Array.isArray(stages) && typeof stages[0] === "string"
    ? closedErrorCode(stages[0])
    : undefined;
}

const CLASS_OWNERS: Readonly<Record<string, FailureOwner>> = {
  page_not_ready: "external",
  host_overrun: "scient",
  control_human_control: "external",
  control_agent_mismatch: "input",
  control_unclaimed_tab: "input",
  control_tab_required: "input",
  control_dialog_pending: "input",
  control_tab_limit: "input",
  control_closed: "cancelled",
  control_interrupted: "cancelled",
  stale_ref: "input",
  bad_locator: "input",
  bad_selector: "input",
  // Scient installs this browser itself; a call that gives up while it installs is Scient's to wait out.
  preview_browser_installing: "scient",
  // The caller's own script threw on the page (the browser reported its exception).
  script_exception: "code",
  // A message to a thread that cannot take one: archived, or no run to steer.
  thread_archived: "input",
  no_steerable_run: "input",
  // Scient could not read its own thread projections, or a task command left no task behind.
  projection_load_failed: "scient",
  task_projection_missing: "scient",
  // "unavailable" can be the browser or the Accounts store; neither is proven here.
  accounts_unavailable: "unknown",
};

const notedClasses = new WeakMap<object, string>();

/**
 * Marks a broad failure built from a more specific cause with that cause's closed class, for the
 * failure note to read. `failureClass` must be a fixed label, never text from the cause.
 */
export function withFailureClass<E extends object>(error: E, failureClass: string): E {
  notedClasses.set(error, closedErrorCode(failureClass));
  return error;
}

/**
 * A browser host's execution failure says it was the page script's own exception only through
 * this fixed detail; any other remote failure keeps its unowned class.
 */
export function withRemoteFailureClass<E extends object>(
  error: E,
  remote: { readonly _tag: string; readonly detail?: unknown },
): E {
  const detail = remote.detail;
  return remote._tag === "PreviewAutomationExecutionError" &&
    typeof detail === "object" &&
    detail !== null &&
    (detail as { readonly failureClass?: unknown }).failureClass === "script_exception"
    ? withFailureClass(error, "script_exception")
    : error;
}

/** An Accounts error without its own class says only its broad reason. */
function accountsFailureClass(error: unknown): string | undefined {
  if (stringOf(error, "_tag") !== "AccountsError") return undefined;
  const reason = stringOf(error, "reason");
  return reason === undefined ? undefined : `accounts_${closedErrorCode(reason)}`;
}

/** Codes whose owner is exact, whatever a generic pattern would say. */
const CODE_OWNERS: Readonly<Record<string, FailureOwner>> = {
  // Watching a pull request that already merged, or naming one without a host to find it on.
  pull_request_not_open: "input",
  pull_request_host_required: "input",
  // A script result larger than the cap; the caller can ask for less.
  result_too_large: "input",
};

export const noteToolFailure = Effect.fn("ScientMcpAnalytics.noteToolFailure")(function* (
  error: unknown,
) {
  const note = yield* ToolFailureNote;
  if (note === undefined) return;
  const tag = stringOf(error, "code") ?? stringOf(error, "_tag");
  const failureClass =
    stringOf(error, "failureClass") ??
    (typeof error === "object" && error !== null ? notedClasses.get(error) : undefined) ??
    browserFailureClass(error) ??
    accountsFailureClass(error);
  if (tag !== undefined) note.tag = tag;
  if (failureClass !== undefined) note.failureClass = failureClass;
  const pendingStage = browserPendingStage(error);
  if (pendingStage !== undefined) note.browser = { ...note.browser, pendingStage };
});

/** Keeps a failure's own closed reason where a handler folds it into a broader code. */
export const noteToolFailureClass = Effect.fn("ScientMcpAnalytics.noteToolFailureClass")(function* (
  failureClass: string,
) {
  const note = yield* ToolFailureNote;
  if (note !== undefined) note.failureClass = closedErrorCode(failureClass);
});

/**
 * T3's tool outcome with a closed error code. Effect's MCP server sends a declared failure that
 * has a message as that text alone, so its tag comes from the call's failure note.
 */
export function scientToolOutcome(
  result: McpSchema.CallToolResult | undefined,
  facts: ToolFailureFacts = {},
): {
  readonly outcome: string;
  readonly errorCode?: string;
  readonly failureClass?: string;
  readonly failureOwner?: string;
} & BrowserCallFacts {
  const outcome = toolOutcome(result);
  if (outcome.outcome !== "error") return outcome;
  if (outcome.errorCode === "exception")
    return facts.unresulted === undefined
      ? { ...outcome, failureOwner: "scient", ...facts.browser }
      : {
          outcome: "error",
          errorCode: facts.unresulted,
          failureOwner: toolFailureAttribution(facts.unresulted).failureOwner,
          ...facts.browser,
        };
  // The note was written from the typed failure, which a wrapper's tag may only generalize.
  const reported =
    facts.tag ??
    (outcome.errorCode === "unknown"
      ? stringOf(result?.structuredContent, "_tag")
      : outcome.errorCode);
  const errorCode = reported === undefined ? "unknown" : closedErrorCode(reported);
  return {
    outcome: "error",
    errorCode,
    ...(facts.failureClass === undefined ? {} : { failureClass: facts.failureClass }),
    failureOwner: toolFailureOwner(errorCode, facts.failureClass),
    ...facts.browser,
  };
}

function toolFailureOwner(errorCode: string, failureClass: string | undefined): string {
  const owned =
    (failureClass === undefined ? undefined : CLASS_OWNERS[failureClass]) ?? CODE_OWNERS[errorCode];
  if (owned !== undefined) return owned;
  const fromCode = toolFailureAttribution(errorCode).failureOwner;
  return fromCode === "unknown" && failureClass !== undefined
    ? toolFailureAttribution(failureClass).failureOwner
    : fromCode;
}

const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const MAX_TRACKED_THREADS = 1_000;
const MAX_CALLS_PER_THREAD = 10_000;

/** One browser tool call as the turn summary counts it: closed values and times only. */
export interface BrowserCall {
  readonly at: number;
  readonly tool: string;
  readonly durationMs: number;
  readonly failed: boolean;
  readonly errorCode?: string | undefined;
  readonly site?: string | undefined;
  /** The browser's own error for a page that did not load, such as -105 for an unknown host. */
  readonly loadErrorCode?: number | undefined;
  /** The page needs another account or sign-in. */
  readonly accountsNote?: boolean | undefined;
}

/**
 * Browser tool calls per thread, kept in memory until the thread's turn completes. Agents call
 * these tools in loops, so they are counted here and reported once on the turn instead of one
 * event per call.
 */
export class BrowserToolCallLedger {
  private readonly calls = new Map<string, Array<BrowserCall>>();
  /**
   * The site each thread's tabs last showed, for failures whose result names none: keyed by
   * thread and tab, and by thread alone for the tab a call without a tabId acts on.
   */
  private readonly sites = new Map<string, string>();

  record(threadId: string, call: BrowserCall, tabId?: string): void {
    let entries = this.calls.get(threadId);
    if (entries === undefined) {
      if (this.calls.size >= MAX_TRACKED_THREADS) {
        const oldest = this.calls.keys().next().value;
        if (oldest !== undefined) this.calls.delete(oldest);
      }
      entries = [];
      this.calls.set(threadId, entries);
    }
    if (entries.length >= MAX_CALLS_PER_THREAD) entries.shift();
    entries.push(call);
    if (call.site === undefined) return;
    for (const key of [threadId, ...(tabId === undefined ? [] : [`${threadId}\u0000${tabId}`])]) {
      this.sites.delete(key);
      if (this.sites.size >= MAX_TRACKED_THREADS * 2) {
        const oldest = this.sites.keys().next().value;
        if (oldest !== undefined) this.sites.delete(oldest);
      }
      this.sites.set(key, call.site);
    }
  }

  lastSite(threadId: string, tabId?: string): string | undefined {
    return this.sites.get(tabId === undefined ? threadId : `${threadId}\u0000${tabId}`);
  }

  /** The calls a thread made up to `until`; later ones belong to its next turn. */
  take(
    threadId: string,
    until: number,
  ): {
    readonly calls: number;
    readonly failures: number;
    readonly entries: ReadonlyArray<BrowserCall>;
  } {
    const entries = this.calls.get(threadId) ?? [];
    const taken = entries.filter((entry) => entry.at <= until);
    const kept = entries.filter((entry) => entry.at > until);
    if (kept.length === 0) this.calls.delete(threadId);
    else this.calls.set(threadId, kept);
    return {
      calls: taken.length,
      failures: taken.filter((entry) => entry.failed).length,
      entries: taken,
    };
  }

  clear(): void {
    this.calls.clear();
    this.sites.clear();
  }
}

export class BrowserToolCalls extends Context.Reference<BrowserToolCallLedger>(
  "scient/telemetry/BrowserToolCalls",
  { defaultValue: () => new BrowserToolCallLedger() },
) {}

/** Summary tool groups; `preview_wait_for` reports as `waitFor`. */
const SUMMARY_TOOLS: Readonly<Record<string, string>> = {
  preview_open: "open",
  preview_navigate: "navigate",
  preview_snapshot: "snapshot",
  preview_act: "act",
  preview_evaluate: "evaluate",
  preview_wait_for: "waitFor",
  preview_status: "status",
};
// Two lists of long host names must still fit the 16 KB event limit.
const MAX_SUMMARY_VALUES = 16;

const percentile = (sorted: ReadonlyArray<number>, share: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;

/** Most frequent first, at most MAX_SUMMARY_VALUES. */
const byFrequency = <A extends string | number>(values: ReadonlyArray<A>): Array<A> => {
  const counts = new Map<A, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, MAX_SUMMARY_VALUES)
    .map(([value]) => value);
};

/**
 * What a turn's browser work looked like: how many calls of each kind, how long they took, which
 * failed and whether the agent got past them, and which sites it worked on.
 */
export function browserTurnSummary(
  entries: ReadonlyArray<BrowserCall>,
): Readonly<Record<string, number | boolean | ReadonlyArray<string | number>>> {
  const durations = entries.map((entry) => entry.durationMs).toSorted((a, b) => a - b);
  const groups: Record<string, number> = {};
  let recoveredFailures = 0;
  let streak = 0;
  let longestFailureStreak = 0;
  entries.forEach((entry, index) => {
    const group = SUMMARY_TOOLS[entry.tool] ?? "other";
    groups[`${group}Calls`] = (groups[`${group}Calls`] ?? 0) + 1;
    groups[`${group}Ms`] = (groups[`${group}Ms`] ?? 0) + entry.durationMs;
    if (!entry.failed) {
      streak = 0;
      return;
    }
    groups[`${group}Failures`] = (groups[`${group}Failures`] ?? 0) + 1;
    streak += 1;
    longestFailureStreak = Math.max(longestFailureStreak, streak);
    if (entries.slice(index + 1).some((later) => later.tool === entry.tool && !later.failed))
      recoveredFailures += 1;
  });
  const failures = entries.filter((entry) => entry.failed);
  const sites = byFrequency(entries.flatMap((entry) => (entry.site ? [entry.site] : [])));
  const failedSites = byFrequency(failures.flatMap((entry) => (entry.site ? [entry.site] : [])));
  const errorCodes = byFrequency(failures.flatMap((entry) => entry.errorCode ?? []));
  const loadErrorCodes = byFrequency(entries.flatMap((entry) => entry.loadErrorCode ?? []));
  return {
    calls: entries.length,
    failures: failures.length,
    recoveredFailures,
    longestFailureStreak,
    endedOnFailure: entries.at(-1)?.failed === true,
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) ?? 0,
    ...groups,
    siteCount: new Set(entries.flatMap((entry) => entry.site ?? [])).size,
    ...(sites.length === 0 ? {} : { sites }),
    ...(failedSites.length === 0 ? {} : { failedSites }),
    ...(errorCodes.length === 0 ? {} : { errorCodes }),
    loadErrors: entries.filter((entry) => entry.loadErrorCode !== undefined).length,
    ...(loadErrorCodes.length === 0 ? {} : { loadErrorCodes }),
    accountNotes: entries.filter((entry) => entry.accountsNote === true).length,
  };
}

const ACTION_PATTERN = /^[A-Za-z]{1,32}$/u;

/**
 * Notes one finished browser call on its thread's ledger, and gives its failure, if any, the
 * site and action it worked on. Only the host of an address is kept.
 */
export function recordBrowserCall(
  ledger: BrowserToolCallLedger,
  threadId: string,
  call: {
    readonly tool: string;
    readonly args: unknown;
    readonly result: McpSchema.CallToolResult | undefined;
    readonly failure: ToolFailureFacts;
    readonly startedAt: number;
    readonly endedAt: number;
  },
): void {
  const outcome = scientToolOutcome(call.result, call.failure);
  const args = fieldsOf(call.args);
  const content = fieldsOf(call.result?.structuredContent);
  const target = fieldsOf(args.target);
  const tabId =
    typeof args.tabId === "string"
      ? args.tabId
      : typeof content.tabId === "string"
        ? content.tabId
        : undefined;
  const site =
    browserSite(content.url) ??
    browserSite(fieldsOf(content.toolIcon).pageUrl) ??
    browserSite(args.url) ??
    browserSite(target.url) ??
    ledger.lastSite(threadId, typeof args.tabId === "string" ? args.tabId : undefined);
  const action =
    call.tool === "preview_act" &&
    typeof args.action === "string" &&
    ACTION_PATTERN.test(args.action)
      ? args.action
      : undefined;
  const loadErrorCode = fieldsOf(content.loadError).code;
  if (outcome.outcome !== "ok")
    call.failure.browser = {
      ...call.failure.browser,
      ...(site === undefined ? {} : { site }),
      ...(action === undefined ? {} : { action }),
    };
  ledger.record(
    threadId,
    {
      at: call.endedAt,
      tool: call.tool,
      durationMs: Math.max(0, call.endedAt - call.startedAt),
      failed: outcome.outcome !== "ok",
      errorCode: outcome.errorCode,
      site,
      ...(typeof loadErrorCode === "number" && Number.isInteger(loadErrorCode)
        ? { loadErrorCode }
        : {}),
      ...(typeof content.accountsNote === "string" ? { accountsNote: true } : {}),
    },
    tabId,
  );
}

export const isBrowserTool = (tool: string) => tool.startsWith("preview_");

/**
 * What a refused `delegate_task` asked to run on, in the fields a started task reports. An
 * instance id becomes its driver; a model outside the reviewed catalogs is `other`, never its text.
 */
export function refusedDelegateTarget(
  tool: string,
  args: unknown,
  outcome: { readonly outcome: string },
  providers: ReadonlyArray<ServerProvider>,
): { readonly targetProvider?: string; readonly targetModel?: string } {
  if (tool !== "delegate_task" || outcome.outcome !== "error") return {};
  const target = fieldsOf(fieldsOf(args).target);
  const instanceId = target.providerInstanceId;
  const driver =
    typeof instanceId === "string"
      ? (providers.find((provider) => provider.instanceId === instanceId)?.driver ?? "unknown")
      : typeof target.driverKind === "string"
        ? (providers.find((provider) => provider.driver === target.driverKind)?.driver ?? "unknown")
        : undefined;
  const model =
    typeof target.model === "string"
      ? (catalogModelLabel(providers, target.model) ?? "other")
      : undefined;
  return {
    ...(driver === undefined ? {} : { targetProvider: driver }),
    ...(model === undefined ? {} : { targetModel: model }),
  };
}
