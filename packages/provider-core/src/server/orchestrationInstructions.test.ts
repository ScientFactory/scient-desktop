import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("generic provider orchestration instructions", () => {
  it("keeps the upstream T3 orchestration policy as its package default", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

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
    assert.include(injected, "T3 Code collaborative browser");
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
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });

  it("allows a host to override text without replacing shared prompt conditions", () => {
    const prompt = "Continue.";
    const content = {
      wrapperElement: "host_instructions",
      defaultMode: "Host default mode",
      planMode: "Host plan mode",
      browserTools: "Host browser help",
      orchestration: "Host orchestration help",
    };
    const injected = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: true },
      content,
    });
    assert.include(injected, "<host_instructions>");
    assert.include(injected, "Host default mode");
    assert.include(injected, "Host browser help");
    assert.include(injected, "Host orchestration help");

    const secondRun = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 2,
      hasT3Mcp: true,
      instructions: "Host orchestration help",
      wrapperElement: "host_orchestration",
    });
    assert.equal(secondRun, prompt);
    assert.equal(t3OrchestrationSystemPrompt(false, "Host orchestration help"), undefined);
    assert.equal(
      t3OrchestrationSystemPrompt(true, "Host orchestration help"),
      "Host orchestration help",
    );
  });
});
