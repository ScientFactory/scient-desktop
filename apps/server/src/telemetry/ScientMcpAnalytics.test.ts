import { describe, expect, it } from "vite-plus/test";
import { McpSchema } from "effect/ai";

import {
  BrowserToolCallLedger,
  closedErrorCode,
  scientMcpAnalyticsInput,
  scientToolOutcome,
} from "./ScientMcpAnalytics.ts";
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

  it.each([
    ["PreviewAutomationTimeoutError", "timeout"],
    ["PreviewAutomationNoAvailableHostError", "no_host"],
    ["McpCapabilityUnavailableError", "mcp_capability_unavailable"],
    ["capability_denied", "capability_denied"],
    ["build-failed", "build_failed"],
    [`${"Very".repeat(20)}LongError`, "very_".repeat(9) + "ver"],
  ])("closes the failure name %s as %s", (name, code) => {
    expect(closedErrorCode(name)).toBe(code);
  });

  it("names a failure from its top-level tag or the call's failure note, never its message", () => {
    const tagged = scientMcpAnalyticsInput(
      "preview_act",
      new McpSchema.CallToolResult({
        isError: true,
        content: [
          { type: "text", text: '{"_tag":"PreviewAutomationInvalidSelectorError","selector":"x"}' },
        ],
      }),
    );
    expect(scientToolOutcome(tagged.result)).toEqual({
      outcome: "error",
      errorCode: "invalid_selector",
      failureOwner: "input",
    });
    const messageOnly = new McpSchema.CallToolResult({
      isError: true,
      content: [{ type: "text", text: "Preview automation timed out after 5000ms." }],
    });
    expect(scientToolOutcome(messageOnly)).toEqual({
      outcome: "error",
      errorCode: "unknown",
      failureOwner: "unknown",
    });
    expect(
      scientToolOutcome(messageOnly, {
        tag: "PreviewAutomationTimeoutError",
        failureClass: "timeout",
      }),
    ).toEqual({
      outcome: "error",
      errorCode: "timeout",
      failureClass: "timeout",
      failureOwner: "unknown",
    });
    expect(scientToolOutcome(undefined, { tag: "Ignored" })).toEqual({
      outcome: "error",
      errorCode: "exception",
      failureOwner: "scient",
    });
    expect(
      scientToolOutcome(
        new McpSchema.CallToolResult({ structuredContent: { _tag: "Ready" }, content: [] }),
      ),
    ).toEqual({ outcome: "ok" });
  });

  it("counts a thread's browser calls up to its turn's end and keeps later ones for the next", () => {
    const ledger = new BrowserToolCallLedger();
    ledger.record("thread-a", 10, false);
    ledger.record("thread-a", 20, true);
    ledger.record("thread-b", 15, true);
    ledger.record("thread-a", 40, false);
    expect(ledger.take("thread-a", 30)).toEqual({ calls: 2, failures: 1 });
    expect(ledger.take("thread-a", 50)).toEqual({ calls: 1, failures: 0 });
    expect(ledger.take("thread-a", 50)).toEqual({ calls: 0, failures: 0 });
    expect(ledger.take("thread-b", 50)).toEqual({ calls: 1, failures: 1 });
  });
});
