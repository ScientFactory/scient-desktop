import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
  type T3AcpPromptWithInstructionsInput,
} from "@t3tools/provider-core/server/orchestrationInstructions";

import { scientAgentCopy } from "./ScientAgentCopy.ts";

/** Upstream's orchestration rules in Scient's copy; one Codex entry each. */
export const SCIENT_ORCHESTRATION_SECTIONS: ReadonlyArray<string> =
  T3_CODE_ORCHESTRATION_SECTIONS.map(scientAgentCopy);

export const SCIENT_ORCHESTRATION_INSTRUCTIONS = `

${SCIENT_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

/** Upstream's device rules in Scient's copy, for sessions holding the `device` capability. */
export const SCIENT_DEVICE_TOOL_INSTRUCTIONS = scientAgentCopy(T3_CODE_DEVICE_TOOL_INSTRUCTIONS);

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = scientAgentCopy(
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
);

// Upstream keeps this note private in ClaudeAdapterV2.ts (CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS);
// this is its exact text. Claude Code defers MCP tools behind ToolSearch.
const CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS = `

### Background work you wait on

To wait for a background command or Monitor you started (tests, a build), call \`t3_background_wait\` with its task ID before you end your turn. Do not mark work you leave running, or PRs. T3 MCP tools are deferred: load one with ToolSearch before you call it.
`;

export const SCIENT_CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS = scientAgentCopy(
  CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS,
);

/**
 * ACP has no system/developer prompt field, so send Scient's copy of the shared
 * context in the first user prompt and whenever the tools or interaction mode change.
 */
export function buildScientAcpPromptWithInstructions(
  input: T3AcpPromptWithInstructionsInput,
): string {
  return t3AcpPromptWithInstructions({
    ...input,
    content: {
      wrapperElement: "scient_instructions",
      rewrite: scientAgentCopy,
      orchestration: SCIENT_ORCHESTRATION_INSTRUCTIONS,
    },
  });
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the prompt until it is delivered, and again after compaction.
 * Keep the wrapper explicit so it cannot be mistaken for text authored by the user.
 */
export function buildScientOrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  return t3OrchestrationPrompt({
    ...input,
    instructions: SCIENT_ORCHESTRATION_INSTRUCTIONS,
    deviceInstructions: SCIENT_DEVICE_TOOL_INSTRUCTIONS,
    wrapperElement: "scient_orchestration_instructions",
  });
}

/**
 * OpenCode's per-message Scient awareness already carries the device block for
 * sessions holding `device`, so this system text stays orchestration only.
 */
export const buildScientOrchestrationSystemPrompt = (hasT3Mcp: boolean): string | undefined =>
  t3OrchestrationSystemPrompt(hasT3Mcp, false) === undefined
    ? undefined
    : SCIENT_ORCHESTRATION_INSTRUCTIONS;
