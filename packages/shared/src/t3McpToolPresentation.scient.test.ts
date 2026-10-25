import { expect, it } from "vite-plus/test";

import { resolveT3McpToolName } from "./t3McpToolPresentation.ts";

it("resolves only a caller's exact known tool inventory", () => {
  const names = new Set(["scient_skill_load"]);
  for (const prefix of ["", "mcp__scient__", "mcp__t3-code__", "t3-code.", "scient/"]) {
    expect(resolveT3McpToolName(`${prefix}scient_skill_load`, names)).toBe("scient_skill_load");
    expect(resolveT3McpToolName(`${prefix}scient_skill_load_extra`, names)).toBeNull();
    expect(resolveT3McpToolName(`${prefix}preview_open`, names)).toBeNull();
  }
  expect(resolveT3McpToolName("mcp__foreign__scient_skill_load", names)).toBeNull();
});
