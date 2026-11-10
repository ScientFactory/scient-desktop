import type { McpSchema } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toolOutcome } from "./ProviderDimensions.ts";

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

export const noteToolFailure = Effect.fn("ScientMcpAnalytics.noteToolFailure")(function* (
  error: unknown,
) {
  const note = yield* ToolFailureNote;
  if (note === undefined) return;
  const tag = stringOf(error, "code") ?? stringOf(error, "_tag");
  const failureClass = stringOf(error, "failureClass");
  if (tag !== undefined) note.tag = tag;
  if (failureClass !== undefined) note.failureClass = failureClass;
});

/**
 * T3's tool outcome with a closed error code. Effect's MCP server sends a declared failure that
 * has a message as that text alone, so its tag comes from the call's failure note.
 */
export function scientToolOutcome(
  result: McpSchema.CallToolResult | undefined,
  facts: ToolFailureFacts = {},
): { readonly outcome: string; readonly errorCode?: string; readonly failureClass?: string } {
  const outcome = toolOutcome(result);
  if (outcome.outcome !== "error" || outcome.errorCode === "exception") return outcome;
  const tag = stringOf(result?.structuredContent, "_tag") ?? facts.tag;
  const reported = outcome.errorCode === "unknown" ? tag : outcome.errorCode;
  return {
    outcome: "error",
    errorCode: reported === undefined ? "unknown" : closedErrorCode(reported),
    ...(facts.failureClass === undefined ? {} : { failureClass: facts.failureClass }),
  };
}

const MAX_TRACKED_THREADS = 1_000;
const MAX_CALLS_PER_THREAD = 10_000;

/**
 * Browser tool calls per thread, kept in memory until the thread's turn completes. Agents call
 * these tools in loops, so they are counted here and reported once on the turn instead of one
 * event per call.
 */
export class BrowserToolCallLedger {
  private readonly calls = new Map<
    string,
    Array<{ readonly at: number; readonly failed: boolean }>
  >();

  record(threadId: string, at: number, failed: boolean): void {
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
    entries.push({ at, failed });
  }

  /** The calls a thread made up to `until`; later ones belong to its next turn. */
  take(threadId: string, until: number): { readonly calls: number; readonly failures: number } {
    const entries = this.calls.get(threadId) ?? [];
    const taken = entries.filter((entry) => entry.at <= until);
    const kept = entries.filter((entry) => entry.at > until);
    if (kept.length === 0) this.calls.delete(threadId);
    else this.calls.set(threadId, kept);
    return { calls: taken.length, failures: taken.filter((entry) => entry.failed).length };
  }

  clear(): void {
    this.calls.clear();
  }
}

export class BrowserToolCalls extends Context.Reference<BrowserToolCallLedger>(
  "scient/telemetry/BrowserToolCalls",
  { defaultValue: () => new BrowserToolCallLedger() },
) {}

export const isBrowserTool = (tool: string) => tool.startsWith("preview_");
