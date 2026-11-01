import { expect, it } from "vite-plus/test";

import {
  T3_MCP_TOOL_NAMES,
  resolveT3McpSummaryAction,
  resolveT3McpToolDefinition,
  resolveT3McpToolName,
  resolveT3McpToolPresentation,
} from "./t3McpToolPresentation.ts";

it("resolves only a caller's exact known tool inventory", () => {
  const names = new Set(["scient_skill_load"]);
  for (const prefix of ["", "mcp__scient__", "mcp__t3-code__", "t3-code.", "scient/"]) {
    expect(resolveT3McpToolName(`${prefix}scient_skill_load`, names)).toBe("scient_skill_load");
    expect(resolveT3McpToolName(`${prefix}scient_skill_load_extra`, names)).toBeNull();
    expect(resolveT3McpToolName(`${prefix}preview_open`, names)).toBeNull();
  }
  expect(resolveT3McpToolName("mcp__foreign__scient_skill_load", names)).toBeNull();
});

// regression: 794ff29ed2 merge: complete orchestration v2 alignment with Scient main
it("recognizes owned and historical tools across provider prefixes and completion suffixes", () => {
  for (const tool of T3_MCP_TOOL_NAMES) {
    const presentation = resolveT3McpToolPresentation(tool);
    for (const prefix of [
      "mcp__scient__",
      "scient.",
      "scient/",
      "mcp_scient_",
      "mcp__t3-code__",
      "mcp__t3_code__",
      "mcp__t3code__",
      "T3-code.",
      "t3_code/",
      "t3code:",
      "mcp_t3-code_",
      "T3 Code ",
      "t3-code · ",
    ]) {
      expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
        presentation,
      );
    }
    expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
  }
});

it("presents Scient's action tools by the action each call ran", () => {
  expect(
    resolveT3McpToolDefinition("mcp__scient__scient_thread_transfer", { action: "merge_back" })
      ?.displayName,
  ).toBe(resolveT3McpToolDefinition("t3_thread_merge_back")?.displayName);
  expect(resolveT3McpSummaryAction("mcp__scient__scient_queue", { action: "list" })).toBe(
    "queue-list",
  );
  expect(resolveT3McpSummaryAction("scient_pending_request", { action: "read" })).toBe(
    "question-read",
  );
  expect(
    resolveT3McpSummaryAction("scient_thread_configure", { modelSelection: { model: "m" } }),
  ).toBe("thread-configure");
  expect(resolveT3McpSummaryAction("scient_thread_configure", {})).toBe("thread-configuration");
});
