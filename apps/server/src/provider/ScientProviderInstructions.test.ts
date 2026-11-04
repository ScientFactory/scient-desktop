import { assert, describe, it } from "@effect/vitest";

import { buildScientPromptAwareness } from "./ScientAwareness.ts";

import {
  buildScientAcpPromptWithInstructions,
  buildScientOrchestrationPrompt,
  buildScientOrchestrationSystemPrompt,
  SCIENT_DEVICE_TOOL_INSTRUCTIONS,
  SCIENT_ORCHESTRATION_INSTRUCTIONS,
} from "./ScientProviderInstructions.ts";

describe("Scient provider instruction composition", () => {
  it("keeps prompt delivery and system prompt gates in the shared core composer", () => {
    const prompt = "Inspect the repository.";
    const scientPrompt = (input: {
      readonly hasT3Mcp?: boolean;
      readonly hasDeviceTools?: boolean;
      readonly orchestrationDelivered?: boolean;
      readonly deviceInstructionsDelivered?: boolean;
    }) =>
      buildScientOrchestrationPrompt({
        prompt,
        hasT3Mcp: input.hasT3Mcp ?? true,
        hasDeviceTools: input.hasDeviceTools ?? false,
        orchestrationDelivered: input.orchestrationDelivered ?? false,
        deviceInstructionsDelivered: input.deviceInstructionsDelivered ?? false,
      });
    const firstRun = scientPrompt({});
    assert.include(firstRun, "<scient_orchestration_instructions>");
    assert.include(firstRun, SCIENT_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.notInclude(firstRun, "## Scient devices");
    assert.include(firstRun, `<user_request>\n${prompt}\n</user_request>`);
    assert.include(scientPrompt({ hasDeviceTools: true }), SCIENT_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(scientPrompt({ orchestrationDelivered: true }), prompt);
    const deviceOnly = scientPrompt({ hasDeviceTools: true, orchestrationDelivered: true });
    assert.include(deviceOnly, "<scient_orchestration_instructions>");
    assert.include(deviceOnly, SCIENT_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(deviceOnly, SCIENT_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(
      scientPrompt({
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: true,
      }),
      prompt,
    );
    assert.equal(scientPrompt({ hasT3Mcp: false, hasDeviceTools: true }), prompt);
    assert.equal(buildScientOrchestrationSystemPrompt(false), undefined);
    assert.equal(buildScientOrchestrationSystemPrompt(true), SCIENT_ORCHESTRATION_INSTRUCTIONS);
  });

  it("preserves ACP slash commands, mode changes, and MCP-dependent instruction injection", () => {
    const prompt = "Continue.";
    const defaultState = {
      interactionMode: "default",
      hasT3Mcp: true,
      hasDeviceTools: false,
    } as const;
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
      state: { interactionMode: "plan", hasT3Mcp: true, hasDeviceTools: false },
      previousState: defaultState,
    });
    assert.include(planPrompt, "Scient interaction mode: Plan");
    // The browser text comes with awareness, gated on the browser grant.
    assert.notInclude(planPrompt, "Scient browser");
    assert.include(planPrompt, "Scient orchestration");
    assert.include(planPrompt, "<scient_instructions>");
    const withoutMcp = buildScientAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false, hasDeviceTools: false },
    });
    assert.include(withoutMcp, "Scient interaction mode: Default");
    assert.notInclude(withoutMcp, "Scient browser");
    assert.notInclude(withoutMcp, "Scient orchestration");

    const withMcpAfterDisabled = buildScientAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true },
      previousState: { interactionMode: "default", hasT3Mcp: false, hasDeviceTools: false },
    });
    assert.include(withMcpAfterDisabled, "Scient orchestration");
    assert.include(withMcpAfterDisabled, SCIENT_DEVICE_TOOL_INSTRUCTIONS);
  });

  it("sends first-run awareness with the orchestration text and not after it", () => {
    const awareness = buildScientPromptAwareness(new Set(["compute"]));
    const firstRun = buildScientOrchestrationPrompt({
      prompt: "Go.",
      hasT3Mcp: true,
      hasDeviceTools: false,
      orchestrationDelivered: false,
      deviceInstructionsDelivered: false,
      awareness,
    });
    assert.include(firstRun, `<scient_orchestration_instructions>${awareness}\n\n## Scient`);
    assert.include(firstRun, "## Scient Compute");
    assert.equal(
      buildScientOrchestrationPrompt({
        prompt: "Go.",
        hasT3Mcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        awareness,
      }),
      "Go.",
    );
  });

  it("puts prompt-delivered awareness, with its gated browser text, inside the instructions", () => {
    const awareness = buildScientPromptAwareness(new Set(["preview", "device"]));
    const text = buildScientAcpPromptWithInstructions(
      {
        prompt: "Continue.",
        state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true },
      },
      awareness,
    );
    assert.include(text, `<scient_instructions>\n## Scient interaction mode: Default`);
    assert.include(text, `${awareness}\n\n## Scient orchestration`);
    assert.equal(text.split("## Scient browser").length, 2);
    assert.equal(text.split("## Scient devices").length, 2);
    assert.include(text, "</scient_instructions>\n\n<user_request>\nContinue.\n</user_request>");
  });
});
