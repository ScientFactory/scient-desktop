import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ScientSkillListInput } from "./tools.ts";

it("accepts only bounded object inputs for the skill list", () => {
  const accepts = Schema.is(ScientSkillListInput);
  expect(accepts({})).toBe(true);
  expect(accepts([])).toBe(false);
  expect(accepts({ query: "pdf", offset: 20, limit: 100 })).toBe(true);
  for (const invalid of [{ limit: 0 }, { offset: -1 }, { query: "x".repeat(201) }]) {
    expect(accepts(invalid)).toBe(false);
  }
});
