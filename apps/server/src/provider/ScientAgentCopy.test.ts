import { assert, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";
import { hostMcpTools } from "../mcp/McpHttpServer.ts";
import { scientTools } from "../mcp/ScientOperationCatalog.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { SCIENT_AGENT_COPY_DIFFERENCES, scientAgentToolCopy } from "./ScientAgentCopy.ts";
import { buildScientAwareness } from "./ScientAwareness.ts";
import {
  buildScientAcpPromptWithInstructions,
  buildScientOrchestrationPrompt,
  buildScientOrchestrationSystemPrompt,
  SCIENT_CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS,
  SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  SCIENT_ORCHESTRATION_INSTRUCTIONS,
} from "./ScientProviderInstructions.ts";
import { buildScientRuntimeInstructions } from "./ScientRuntimeInstructions.ts";

const capabilities = new Set<McpCapability>([
  "preview",
  "device",
  "compute:inventory",
  "documents:build",
  "skills:read",
]);
const runtime = (harness: string) =>
  buildScientRuntimeInstructions({ harness, model: "model-1", reasoningEffort: "high" });
const awareness = buildScientAwareness(capabilities);
const prompt = "Inspect the repository.";

// The fields the MCP server lists for a tool, before Scient's tools/list rewrite.
const listedTools = [...hostMcpTools, ...scientTools].map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool),
  inputSchema: Tool.getJsonSchemaFromSchema(Schema.toCodecJson(tool.parametersSchema)),
  outputSchema: Tool.getJsonSchemaFromSchema(Schema.toCodecJson(tool.successSchema)),
  annotations: { title: Context.getOrUndefined(tool.annotations, Tool.Title) },
}));

// Everything each provider's agent is told, by the channel its adapter uses.
const agentText: Record<string, string> = {
  "MCP tools/list": JSON.stringify(listedTools.map(scientAgentToolCopy)),
  codex: Object.values(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }, capabilities))
    .map((entry) => entry.value)
    .join("\n"),
  claudeAgent: [
    awareness,
    runtime("Claude Code"),
    SCIENT_ORCHESTRATION_INSTRUCTIONS + SCIENT_CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS,
    SCIENT_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  ].join("\n"),
  "acp, acpRegistry": [
    ...(["default", "plan"] as const).map((interactionMode) =>
      buildScientAcpPromptWithInstructions({
        prompt,
        state: { interactionMode, hasT3Mcp: true, hasDeviceTools: true },
      }),
    ),
    awareness,
    runtime("ACP"),
  ].join("\n"),
  cursor: [
    buildScientOrchestrationPrompt({
      prompt,
      hasT3Mcp: true,
      hasDeviceTools: true,
      orchestrationDelivered: false,
      deviceInstructionsDelivered: false,
    }),
    runtime("Cursor"),
  ].join("\n"),
  opencode: [buildScientOrchestrationSystemPrompt(true), awareness, runtime("OpenCode")].join("\n"),
  "pi, omp, scient": [SCIENT_ORCHESTRATION_INSTRUCTIONS, awareness, runtime("Pi")].join("\n"),
  "droid, grok, muse, antigravity": [awareness, runtime("Droid")].join("\n"),
};

// T3's product and tool names; `t3-thread://` links and `T3_*` variables are compatibility names.
const T3_NAME = /\bT3\b|\bt3_[a-z]|\bt3-code\b|mcp__t3[-_]/g;

it("gives every provider's agent Scient's names, built from upstream's current copy", () => {
  for (const [channel, text] of Object.entries(agentText)) {
    const leaks = [...text.matchAll(T3_NAME)].map(({ index }) =>
      text.slice(Math.max(0, index - 60), index + 40),
    );
    assert.deepStrictEqual(leaks, [], `${channel} shows T3 names`);
    assert.include(text, "Scient", channel);
  }
  assert.include(agentText["MCP tools/list"], "scient_thread_launch");

  // A deliberate difference must still match upstream's text, or it silently stops applying.
  const upstream = [JSON.stringify(listedTools), T3_CODE_ORCHESTRATION_INSTRUCTIONS].join("\n");
  for (const [upstreamText] of SCIENT_AGENT_COPY_DIFFERENCES)
    assert.include(upstream, upstreamText, "stale Scient agent-copy difference");
});
