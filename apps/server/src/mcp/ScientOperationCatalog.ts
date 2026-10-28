// SCIENT-FORK:START — Scient Accounts: register account operation definitions.
import { ScientAccountsToolkit } from "../scient/accounts/agent/tools.ts";
// SCIENT-FORK:END
import { makeOperationRegistry } from "@scientfactory/operations";
import type { Tool } from "effect/ai";

import { operationDefinitionForTool } from "./ScientOperationTool.ts";
import { ScientComputeToolkit } from "./toolkits/compute/tools.ts";
import { ScientDocumentsToolkit } from "./toolkits/documents/tools.ts";
import { ScientOverleafToolkit } from "./toolkits/overleaf/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ScientSkillsToolkit } from "./toolkits/skills/tools.ts";
import { ScientSourcesToolkit } from "./toolkits/sources/tools.ts";
import { ScientThreadsToolkit } from "./toolkits/threads/tools.ts";

export function makeScientOperationCatalog(tools: ReadonlyArray<Tool.Any>) {
  const byName = new Map<string, string>();
  const definitions = tools.map((tool) => {
    const operation = operationDefinitionForTool(tool);
    if (byName.has(tool.name)) throw new Error(`Duplicate Scient tool: ${tool.name}`);
    byName.set(tool.name, operation.id);
    return operation;
  });
  const registry = makeOperationRegistry(definitions);
  return {
    ...registry,
    forTool: (name: string) => {
      const id = byName.get(name);
      return id === undefined ? undefined : registry.get(id);
    },
  };
}

/** Compose existing domain adapters; do not maintain another list of tool names. */
export const scientTools = [
  // SCIENT-FORK:START — Scient Accounts: include account tools in discovery.
  ...Object.values(ScientAccountsToolkit.tools),
  // SCIENT-FORK:END
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(ScientSourcesToolkit.tools),
  ...Object.values(ScientSkillsToolkit.tools),
  ...Object.values(ScientDocumentsToolkit.tools),
  ...Object.values(ScientOverleafToolkit.tools),
  ...Object.values(ScientComputeToolkit.tools),
  ...Object.values(ScientThreadsToolkit.tools),
];
export type ScientToolName = (typeof scientTools)[number]["name"];
export const scientOperationCatalog = makeScientOperationCatalog(scientTools);
