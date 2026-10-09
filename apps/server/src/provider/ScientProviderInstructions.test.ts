import { assert, describe, it } from "@effect/vitest";

import {
  buildScientAcpPromptWithInstructions,
  buildScientOrchestrationPromptForFirstRun,
  buildScientOrchestrationSystemPrompt,
  SCIENT_BROWSER_TOOL_INSTRUCTIONS,
  SCIENT_ORCHESTRATION_INSTRUCTIONS,
} from "./ScientProviderInstructions.ts";

describe("Scient provider instruction composition", () => {
  it("owns the Scient policy text while keeping legacy MCP wire identifiers exact", () => {
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level Scient conversations");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      SCIENT_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `scient_thread_send` on `childThreadId`",
    );
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "Scient orchestration");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "Scient MCP server");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "scient_thread_launch");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "call `orchestrator_capabilities({})`");
    assert.include(
      SCIENT_ORCHESTRATION_INSTRUCTIONS,
      "tools.mcp__scient__orchestrator_capabilities({})",
    );
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "T3_ACP_MCP_NODE");
    assert.include(SCIENT_ORCHESTRATION_INSTRUCTIONS, "T3_ACP_MCP_ENTRYPOINT");
    assert.notInclude(SCIENT_ORCHESTRATION_INSTRUCTIONS, "mcp__t3_code__");
    assert.notInclude(SCIENT_ORCHESTRATION_INSTRUCTIONS, "T3 Code orchestration");
    assert.notInclude(SCIENT_ORCHESTRATION_INSTRUCTIONS, "T3 Code collaborative browser");
    assert.include(SCIENT_BROWSER_TOOL_INSTRUCTIONS, "Scient collaborative browser");
    assert.include(SCIENT_BROWSER_TOOL_INSTRUCTIONS, "preview_wait_for");
    assert.include(SCIENT_BROWSER_TOOL_INSTRUCTIONS, "profileId");
    assert.include(SCIENT_BROWSER_TOOL_INSTRUCTIONS, "owner is `unclaimed`");
    assert.include(SCIENT_BROWSER_TOOL_INSTRUCTIONS, "while it is `human`");
    assert.include(SCIENT_BROWSER_TOOL_INSTRUCTIONS, "After two failed preview attempts");
    assert.include(SCIENT_BROWSER_TOOL_INSTRUCTIONS, "documented workflow");

    const generated = [
      SCIENT_ORCHESTRATION_INSTRUCTIONS,
      SCIENT_BROWSER_TOOL_INSTRUCTIONS,
      buildScientAcpPromptWithInstructions({
        prompt: "Inspect the repository.",
        state: { interactionMode: "default", hasT3Mcp: true },
      }),
      buildScientOrchestrationPromptForFirstRun({
        prompt: "Inspect the repository.",
        runOrdinal: 1,
        hasT3Mcp: true,
      }),
    ].join("\n");
    assert.notInclude(generated, "T3 Code");
    assert.notInclude(generated, "T3 preview tools");
    assert.notInclude(generated, "mcp__t3_code__");
    assert.include(generated, "Scient");
    assert.include(generated, "orchestrator_capabilities");
  });

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
    assert.include(planPrompt, "Scient collaborative browser");
    assert.include(planPrompt, "Scient orchestration");
    assert.include(planPrompt, "<scient_instructions>");
    const withoutMcp = buildScientAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "Scient interaction mode: Default");
    assert.notInclude(withoutMcp, "Scient collaborative browser");
    assert.notInclude(withoutMcp, "Scient orchestration");

    const withMcpAfterDisabled = buildScientAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: true },
      previousState: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withMcpAfterDisabled, "Scient collaborative browser");
    assert.include(withMcpAfterDisabled, "Scient orchestration");
  });
});
