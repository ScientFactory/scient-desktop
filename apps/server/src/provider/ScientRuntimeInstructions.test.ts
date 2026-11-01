import { assert, describe, it } from "@effect/vitest";

import { buildScientRuntimeInstructions } from "./ScientRuntimeInstructions.ts";

describe("Scient runtime instructions", () => {
  // Every harness name takes the same interpolation path.
  it.each(["Codex"])("keeps the Scient identity for the %s harness", (harness) => {
    const instructions = buildScientRuntimeInstructions({ harness });
    assert.include(instructions, `running in Scient through the ${harness} harness.`);
    assert.include(instructions, "embed images, video, and audio");
    assert.include(instructions, "Markdown image syntax with absolute file paths");
    assert.include(instructions, "open it in Scient's files viewer.");
    assert.notInclude(instructions, "undefined");
  });

  it("names Scient with the model's display name and slug", () => {
    const instructions = buildScientRuntimeInstructions({
      harness: "OpenCode",
      model: "open-code-model",
      modelName: "Friendly Model",
      reasoningEffort: "high",
    });
    assert.include(
      instructions,
      "running in Scient through the OpenCode harness, as Friendly Model (model slug: open-code-model) with high reasoning effort.",
    );
    assert.notInclude(instructions, "T3 Code");
  });
});
