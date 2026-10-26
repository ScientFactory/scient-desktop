import { assert, describe, it } from "@effect/vitest";

import {
  buildScientAcpPromptWithInstructions,
  buildScientOrchestrationPromptForFirstRun,
  buildScientOrchestrationSystemPrompt,
  SCIENT_ORCHESTRATION_INSTRUCTIONS,
} from "./ScientProviderInstructions.ts";

describe("Scient provider instruction composition", () => {
  it("keeps first-run and system prompt gates in the shared core composer", () => {
    const prompt = "Inspect the repository.";
    const firstRun = buildScientOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });
    assert.include(firstRun, "<scient_orchestration_instructions>");
    assert.include(firstRun, SCIENT_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.include(firstRun, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      buildScientOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      buildScientOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
    assert.equal(buildScientOrchestrationSystemPrompt(false), undefined);
    assert.equal(buildScientOrchestrationSystemPrompt(true), SCIENT_ORCHESTRATION_INSTRUCTIONS);
  });

  it("preserves ACP slash commands, mode changes, and MCP-dependent instruction injection", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;
    assert.equal(
      buildScientAcpPromptWithInstructions({ prompt: "/help", state: defaultState }),
      "/help",
    );
    assert.equal(
      buildScientAcpPromptWithInstructions({
        prompt,
        state: defaultState,
        previousState: defaultState,
      }),
      prompt,
    );
    const planPrompt = buildScientAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "plan", hasT3Mcp: true },
      previousState: defaultState,
    });
    assert.include(planPrompt, "Scient interaction mode: Plan");
    assert.include(planPrompt, "Scient browser");
    assert.include(planPrompt, "Scient orchestration");
    assert.include(planPrompt, "<scient_instructions>");
    const withoutMcp = buildScientAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "Scient interaction mode: Default");
    assert.notInclude(withoutMcp, "Scient browser");
    assert.notInclude(withoutMcp, "Scient orchestration");

    const withMcpAfterDisabled = buildScientAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: true },
      previousState: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withMcpAfterDisabled, "Scient browser");
    assert.include(withMcpAfterDisabled, "Scient orchestration");
  });
});
