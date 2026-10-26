import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("generic provider orchestration instructions", () => {
  it("injects first-run prompt fallback only with MCP on the first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes a system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("composes upstream ACP policy and preserves slash commands and state gating", () => {
    const prompt = "Inspect the repository.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;
    const injected = t3AcpPromptWithInstructions({ prompt, state: defaultState });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<t3_code_instructions>");
    assert.include(injected, "preview_status");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(t3AcpPromptWithInstructions({ prompt: "/help", state: defaultState }), "/help");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );

    const planAfterDefault = t3AcpPromptWithInstructions({
      prompt,
      state: { ...defaultState, interactionMode: "plan" },
      previousState: defaultState,
    });
    assert.include(planAfterDefault, "T3 Code interaction mode: Plan");

    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
      previousState: defaultState,
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });

  it("allows a host to rewrite the shared text without replacing prompt conditions", () => {
    const prompt = "Continue with T3 Code.";
    const injected = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: true },
      content: {
        wrapperElement: "host_instructions",
        rewrite: (text) => text.replaceAll("T3 Code", "Host"),
      },
    });
    assert.include(injected, "<host_instructions>");
    assert.include(injected, "Host interaction mode: Default");
    assert.include(injected, "Host browser");
    assert.include(injected, "acp-mcp-call");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);

    const secondRun = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 2,
      hasT3Mcp: true,
      instructions: "Host orchestration help",
      wrapperElement: "host_orchestration",
    });
    assert.equal(secondRun, prompt);
  });
});
