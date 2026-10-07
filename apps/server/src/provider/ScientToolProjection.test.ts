import { describe, expect, it } from "vite-plus/test";

import {
  CANONICAL_SCIENT_TOOL_PROJECTION,
  CLAUDE_SCIENT_TOOL_PROJECTION,
  scientToolProjectionForProvider,
} from "./ScientToolProjection.ts";

describe("Scient tool projection", () => {
  it("keeps canonical names for providers that expose canonical tools", () => {
    expect(scientToolProjectionForProvider("codex")).toBe(CANONICAL_SCIENT_TOOL_PROJECTION);
    expect(scientToolProjectionForProvider("opencode")).toBe(CANONICAL_SCIENT_TOOL_PROJECTION);
  });

  it("uses Claude's exact qualified MCP names", () => {
    expect(scientToolProjectionForProvider("claudeAgent")).toBe(CLAUDE_SCIENT_TOOL_PROJECTION);
    expect(CLAUDE_SCIENT_TOOL_PROJECTION).toMatchObject({
      providerNativeSkillTool: true,
      deferred: false,
    });
  });
});
