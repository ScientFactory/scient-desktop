import type { McpSchema } from "effect/ai";
import * as Schema from "effect/Schema";

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const TOOL_IDENTIFIERS: Readonly<Record<string, string>> = {
  scient_thread_send: "t3_thread_send",
  scient_thread_fork: "t3_thread_fork",
  scient_thread_merge_back: "t3_thread_merge_back",
  scient_queue_edit: "t3_queue_edit",
  scient_queue_promote_to_steer: "t3_queue_promote_to_steer",
  scient_pending_request_respond: "t3_pending_request_respond",
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
