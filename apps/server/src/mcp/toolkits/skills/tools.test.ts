import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";
import * as Schema from "effect/Schema";

import {
  ScientSkillListInput,
  ScientSkillLoadTool,
  ScientSkillReadResourceTool,
  ScientSkillsListTool,
} from "./tools.ts";

it("emits object-only MCP input schemas for every Scient skill tool", () => {
  for (const tool of [ScientSkillsListTool, ScientSkillLoadTool, ScientSkillReadResourceTool]) {
    expect(Tool.getJsonSchema(tool)).toMatchObject({ type: "object" });
  }
  const accepts = Schema.is(ScientSkillListInput);
  expect(accepts({})).toBe(true);
  expect(accepts([])).toBe(false);
  expect(accepts({ query: "pdf", offset: 20, limit: 50 })).toBe(true);
  for (const invalid of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { query: "x".repeat(201) }]) {
    expect(accepts(invalid)).toBe(false);
  }
});
