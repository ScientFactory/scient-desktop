import { describe, expect, it } from "vite-plus/test";
import { McpSchema } from "effect/ai";

import { scientMcpAnalyticsInput } from "./ScientMcpAnalytics.ts";
import { toolOutcome } from "./ProviderDimensions.ts";

describe("Scient MCP analytics input", () => {
  it("retains metric identifiers and decodes the declared JSON-text result", () => {
    const input = scientMcpAnalyticsInput(
      "scient_thread_transfer",
      new McpSchema.CallToolResult({
        content: [{ type: "text", text: '{"targetThreadId":"synthetic-child"}' }],
      }),
    );
    expect(input.tool).toBe("t3_thread_transfer");
    expect(input.result?.structuredContent).toEqual({ targetThreadId: "synthetic-child" });
  });

  it("preserves failure codes without treating declared failures as successful handoffs", () => {
    const input = scientMcpAnalyticsInput(
      "scient_queue",
      new McpSchema.CallToolResult({
        isError: true,
        content: [
          { type: "text", text: '{"_tag":"OrchestratorMcpFailure","code":"capability_denied"}' },
        ],
      }),
    );
    expect(toolOutcome(input.result)).toEqual({
      outcome: "error",
      errorCode: "capability_denied",
    });
  });

  it("leaves structured results, plain text, multi-part content, and exceptions unchanged", () => {
    for (const result of [
      undefined,
      new McpSchema.CallToolResult({
        structuredContent: { sequence: 1 },
        content: [{ type: "text", text: '{"sequence":2}' }],
      }),
      new McpSchema.CallToolResult({ content: [{ type: "text", text: "not json" }] }),
      new McpSchema.CallToolResult({
        content: [
          { type: "text", text: "{}" },
          { type: "text", text: "{}" },
        ],
      }),
    ]) {
      expect(scientMcpAnalyticsInput("delegate_task", result)).toEqual({
        tool: "delegate_task",
        result,
      });
    }
  });
});
