import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ScientSkillLoadTool, ScientSkillReadResourceTool, ScientSkillsListTool } from "./tools.ts";

it("emits object-only MCP input schemas for every Scient skill tool", () => {
  for (const tool of [ScientSkillsListTool, ScientSkillLoadTool, ScientSkillReadResourceTool]) {
    expect(Tool.getJsonSchema(tool)).toMatchObject({ type: "object" });
  }
  expect(Tool.getJsonSchema(ScientSkillsListTool)).toEqual({
    type: "object",
    additionalProperties: false,
  });
});
