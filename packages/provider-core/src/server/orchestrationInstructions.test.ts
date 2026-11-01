import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

// SCIENT-FORK:START — host copy composes through the shared delivery conditions.
describe("host orchestration copy", () => {
  it("only exposes a system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false, false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true, false), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("composes upstream ACP policy and preserves slash commands and state gating", () => {
    const prompt = "Inspect the repository.";
    const defaultState = {
      interactionMode: "default",
      hasT3Mcp: true,
      hasDeviceTools: false,
    } as const;
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
      state: { interactionMode: "default", hasT3Mcp: false, hasDeviceTools: false },
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
      state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true },
      content: {
        wrapperElement: "host_instructions",
        rewrite: (text) => text.replaceAll("T3 Code", "Host"),
      },
    });
    assert.include(injected, "<host_instructions>");
    assert.include(injected, "Host interaction mode: Default");
    assert.include(injected, "Host browser");
    assert.include(injected, "Host devices");
    assert.include(injected, "acp-mcp-call");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);

    const hostPrompt = (orchestrationDelivered: boolean, deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt,
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered,
        deviceInstructionsDelivered,
        instructions: "Host orchestration help",
        deviceInstructions: "Host device help",
        wrapperElement: "host_orchestration",
      });
    const firstRun = hostPrompt(false, false);
    assert.include(firstRun, "<host_orchestration>Host orchestration help\nHost device help");
    assert.notInclude(firstRun, "T3 Code orchestration");
    assert.equal(
      hostPrompt(true, false),
      `<host_orchestration>Host device help</host_orchestration>\n\n<user_request>\n${prompt}\n</user_request>`,
    );
    assert.equal(hostPrompt(true, true), prompt);
  });
});
// SCIENT-FORK:END
