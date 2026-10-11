import { assert, describe, it } from "@effect/vitest";

import {
  buildScientRuntimeInstructions,
  SCIENT_PULL_REQUEST_LINKING_INSTRUCTIONS,
} from "./ScientRuntimeInstructions.ts";

describe("Scient runtime instructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity", "Muse"])(
    "keeps the Scient identity for the %s harness",
    (harness) => {
      const instructions = buildScientRuntimeInstructions({ harness });
      assert.include(instructions, `running in Scient through the ${harness} harness.`);
      assert.include(instructions, "embed images and videos");
      assert.include(instructions, "Markdown with absolute file paths");
      assert.notInclude(instructions, "undefined");
    },
  );

  it("keeps app identity and PR workflow copy outside the generic provider package", () => {
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
    assert.include(instructions, SCIENT_PULL_REQUEST_LINKING_INSTRUCTIONS);
    assert.include(instructions, "When the Scient MCP server exposes link_pull_request");
    assert.include(instructions, "with the full PR URL immediately after creating a PR");
    assert.include(instructions, "For a stack, call it for every layer");
    assert.include(instructions, "call list_thread_pull_requests and link any PR");
    assert.include(instructions, "Scient wakes you when checks finish");
    assert.notInclude(instructions, "T3 Code");
  });
});
