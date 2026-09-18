import type { ScientToolName } from "../mcp/ScientOperationCatalog.ts";

/**
 * Canonical Scient tool names stay provider-independent. Adapters may project
 * them into the exact name their runtime exposes to the model.
 */
export interface ScientToolProjection {
  readonly name: (name: ScientToolName) => string;
  readonly providerNativeSkillTool: boolean;
  readonly deferred: boolean;
}

export const CANONICAL_SCIENT_TOOL_PROJECTION: ScientToolProjection = {
  name: (name) => name,
  providerNativeSkillTool: false,
  deferred: false,
};

export const CLAUDE_SCIENT_TOOL_PROJECTION: ScientToolProjection = {
  name: (name) => `mcp__t3-code__${name}`,
  providerNativeSkillTool: true,
  deferred: false,
};

export function scientToolProjectionForProvider(provider: string): ScientToolProjection {
  return provider === "claudeAgent"
    ? CLAUDE_SCIENT_TOOL_PROJECTION
    : CANONICAL_SCIENT_TOOL_PROJECTION;
}
