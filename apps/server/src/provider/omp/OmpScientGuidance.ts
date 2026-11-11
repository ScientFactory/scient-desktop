import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "../ScientAwareness.ts";
import { SCIENT_ORCHESTRATION_INSTRUCTIONS } from "../ScientProviderInstructions.ts";
import { buildScientRuntimeInstructions } from "../ScientRuntimeInstructions.ts";
import type { OmpTarget } from "./OmpTarget.ts";

// The shared rules name Claude's and Codex's native tools. OMP's `task` offers a `model`
// argument only when `task.perCallModel` is on, which is off by default.
const OMP_NATIVE_SUBAGENT_INSTRUCTIONS = `### Your native subagents

Your native subagent tool is \`task\`. Use it only for a child on a model it offers: your current model, unless \`task\` lists a \`model\` argument. Any other model is a \`delegate_task\`.`;

/**
 * What Scient appends to an OMP session's system prompt: the same awareness,
 * runtime and, where the session may delegate, orchestration rules Claude's carries.
 */
export function buildOmpScientGuidance(input: {
  readonly target: Pick<OmpTarget, "name">;
  /** Absent when the session has no Scient tool session. */
  readonly capabilities: ReadonlySet<McpCapability> | undefined;
}): string {
  return [
    buildScientAwareness(input.capabilities),
    buildScientRuntimeInstructions({ harness: input.target.name }),
    ...(input.capabilities?.has("orchestration") === true
      ? [SCIENT_ORCHESTRATION_INSTRUCTIONS.trim(), OMP_NATIVE_SUBAGENT_INSTRUCTIONS]
      : []),
  ].join("\n\n");
}
