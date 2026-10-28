import { expect, it } from "@effect/vitest";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { buildScientAwareness } from "./ScientAwareness.ts";
import { SCIENT_ORCHESTRATION_INSTRUCTIONS } from "./ScientProviderInstructions.ts";
import budget from "./agentContextBudget.scient.json" with { type: "json" };

// Every capability with an awareness block, so a session granted all of them is measured.
const ALL_AWARENESS_CAPABILITIES: ReadonlySet<McpCapability> = new Set([
  "preview",
  "compute:inventory",
  "device",
  "documents:build",
  "skills:read",
]);

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

// The agent-context-budget workflow compares these values with main's as well.
it("Scient agent context matches the committed budget", () => {
  const measured = {
    scientAwarenessAllCapabilitiesBytes: utf8Bytes(
      buildScientAwareness(ALL_AWARENESS_CAPABILITIES),
    ),
    scientOrchestrationBytes: utf8Bytes(SCIENT_ORCHESTRATION_INSTRUCTIONS),
    codexAdditionalContextAllCapabilitiesBytes: utf8Bytes(
      Object.values(
        buildCodexAdditionalContext(
          { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
          ALL_AWARENESS_CAPABILITIES,
        ),
      )
        .map((entry) => entry.value)
        .join(""),
    ),
  };

  expect(measured).toEqual(budget);
});
