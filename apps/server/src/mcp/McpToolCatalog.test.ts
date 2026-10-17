import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { ScientDocumentsToolkit } from "./toolkits/documents/tools.ts";
import { ScientComputeToolkit } from "./toolkits/compute/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ScientSkillsToolkit } from "./toolkits/skills/tools.ts";
import { ScientSourcesToolkit } from "./toolkits/sources/tools.ts";
import { ScientThreadsToolkit } from "./toolkits/threads/tools.ts";

import * as attachmentTools from "./toolkits/attachment/tools.ts";
import * as computeTools from "./toolkits/compute/tools.ts";
import * as deviceTools from "./toolkits/device/tools.ts";
import * as documentsTools from "./toolkits/documents/tools.ts";
import * as environmentTools from "./toolkits/environment/tools.ts";
import * as htmlTools from "./toolkits/html/tools.ts";
import * as orchestratorTools from "./toolkits/orchestrator/tools.ts";
import * as previewTools from "./toolkits/preview/tools.ts";
import * as previewControlsTools from "./toolkits/previewControls/tools.ts";
import * as projectTools from "./toolkits/project/tools.ts";
import * as pullRequestsTools from "./toolkits/pullRequests/tools.ts";
import * as skillsTools from "./toolkits/skills/tools.ts";
import * as sourcesTools from "./toolkits/sources/tools.ts";
import * as threadTools from "./toolkits/thread/tools.ts";
import * as threadsTools from "./toolkits/threads/tools.ts";
import * as worktreeTools from "./toolkits/worktree/tools.ts";

const tools: ReadonlyArray<Tool.Any> = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(ScientSourcesToolkit.tools),
  ...Object.values(ScientSkillsToolkit.tools),
  ...Object.values(ScientDocumentsToolkit.tools),
  ...Object.values(ScientComputeToolkit.tools),
  ...Object.values(ScientThreadsToolkit.tools),
];

it("publishes a provider-compatible MCP tool catalog", () => {
  const names = tools.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);

  for (const tool of tools) {
    const inputSchema = Tool.getJsonSchema(tool) as { readonly type?: unknown };
    expect(inputSchema.type, `${tool.name} must accept a JSON object`).toBe("object");
  }
});

// Strict validators (Meta's API among them) reject octal escapes such as `\0`,
// lookarounds and backreferences in JSON Schema patterns. `\x00` is portable.
const NON_PORTABLE_PATTERN = /\\[0-9]|\\k<|\(\?<?[=!]/u;

function schemaPatterns(schema: unknown, found: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) schemaPatterns(item, found);
  } else if (schema !== null && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "pattern" && typeof value === "string") found.push(value);
      else schemaPatterns(value, found);
    }
  }
  return found;
}

it("publishes only regex patterns that strict JSON Schema validators accept", () => {
  const toolkitModules: ReadonlyArray<object> = [
    attachmentTools,
    computeTools,
    deviceTools,
    documentsTools,
    environmentTools,
    htmlTools,
    orchestratorTools,
    previewTools,
    previewControlsTools,
    projectTools,
    pullRequestsTools,
    skillsTools,
    sourcesTools,
    threadTools,
    threadsTools,
    worktreeTools,
  ];
  const allTools = new Set<Tool.Any>();
  for (const module of toolkitModules) {
    for (const value of Object.values(module)) {
      if (Tool.isUserDefined(value)) allTools.add(value);
      else if (value !== null && typeof value === "function" && "tools" in value) {
        for (const tool of Object.values(value.tools as Record<string, unknown>)) {
          if (Tool.isUserDefined(tool)) allTools.add(tool);
        }
      }
    }
  }
  const patterns = [...allTools].flatMap((tool) =>
    schemaPatterns(Tool.getJsonSchema(tool)).map((pattern) => ({ tool: tool.name, pattern })),
  );
  expect(patterns.some(({ pattern }) => pattern.includes("\\x00"))).toBe(true);
  for (const { tool, pattern } of patterns) {
    expect(pattern, `${tool} pattern ${pattern}`).not.toMatch(NON_PORTABLE_PATTERN);
  }
});
