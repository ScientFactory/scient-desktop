import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "./ScientAwareness.ts";
// SCIENT-FORK:START Scient instruction owners
import { SCIENT_ORCHESTRATION_SECTIONS } from "./ScientProviderInstructions.ts";
import { buildScientRuntimeInstructions } from "./ScientRuntimeInstructions.ts";
// SCIENT-FORK:END Scient instruction owners

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

// SCIENT-FORK:START split Scient-authored paragraphs at the provider's byte boundary.
function scientCodexContextSections(text: string): ReadonlyArray<string> {
  const sections: string[] = [];
  for (const paragraph of text.trim().split("\n\n")) {
    const previous = sections.at(-1);
    const combined = previous === undefined ? paragraph : previous + "\n\n" + paragraph;
    if (Buffer.byteLength(combined, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
      if (previous === undefined) sections.push(combined);
      else sections[sections.length - 1] = combined;
    } else {
      sections.push(paragraph);
    }
  }
  return sections;
}
// SCIENT-FORK:END

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  /**
   * Exact capabilities granted to this provider session. The awareness
   * composer never infers tool availability from a server URL.
   */
  capabilities?: ReadonlySet<McpCapability>,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    // SCIENT-FORK:START Scient additional context entries
    ...Object.fromEntries(
      SCIENT_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildScientRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...Object.fromEntries(
      scientCodexContextSections(buildScientAwareness(capabilities)).map((value, index) => [
        index === 0 ? "scient_awareness" : `scient_awareness_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value },
      ]),
    ),
    // SCIENT-FORK:END Scient additional context entries
  };
}
