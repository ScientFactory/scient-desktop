import {
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
  type T3AcpPromptWithInstructionsInput,
} from "@t3tools/provider-core/server/orchestrationInstructions";

import { scientAgentCopy } from "./ScientAgentCopy.ts";

/**
 * Scient keeps proactive visuals: upstream now renders HTML visuals only when
 * asked. Each section stays under Codex's 4,000-byte context entry cap.
 */
const SCIENT_ORCHESTRATION_ADDITIONS: ReadonlyArray<string> = [
  `### Scient visuals

When a chart, table, diagram, image collage, or mockup would say more than prose, show it without being asked: check its HTML with \`html_preview\`, then publish it with \`html_render\` before your final reply. Do not announce or restate it.`,
];

/** Upstream's orchestration rules in Scient's names, then Scient's additions; one Codex entry each. */
export const SCIENT_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  ...T3_CODE_ORCHESTRATION_SECTIONS.map(scientAgentCopy),
  ...SCIENT_ORCHESTRATION_ADDITIONS,
];

export const SCIENT_ORCHESTRATION_INSTRUCTIONS = `

${SCIENT_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

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
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
export function buildScientOrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return t3OrchestrationPromptForFirstRun({
    ...input,
    instructions: SCIENT_ORCHESTRATION_INSTRUCTIONS,
    wrapperElement: "scient_orchestration_instructions",
  });
}

export const buildScientOrchestrationSystemPrompt = (hasT3Mcp: boolean): string | undefined =>
  t3OrchestrationSystemPrompt(hasT3Mcp) === undefined
    ? undefined
    : SCIENT_ORCHESTRATION_INSTRUCTIONS;
