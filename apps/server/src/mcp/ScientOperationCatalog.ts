// SCIENT-FORK:START — Scient Accounts: register account operation definitions.
import { ScientAccountsToolkit } from "../scient/accounts/agent/tools.ts";
// SCIENT-FORK:END
import { makeOperationRegistry } from "@scientfactory/operations";
import type { Tool } from "effect/ai";

import { operationDefinitionForTool } from "./ScientOperationTool.ts";
import { ScientAnnotationsToolkit } from "./toolkits/annotations/tools.ts";
import { ScientComputeToolkit } from "./toolkits/compute/tools.ts";
import { ScientDocumentsToolkit } from "./toolkits/documents/tools.ts";
import { ScientOverleafToolkit } from "./toolkits/overleaf/tools.ts";
import { ScientReferencesToolkit } from "./toolkits/references/tools.ts";
import {
  ScientSystematicReviewsLibraryToolkit,
  ScientSystematicReviewsToolkit,
} from "./toolkits/systematicReviews/tools.ts";
import { ScientSkillsToolkit } from "./toolkits/skills/tools.ts";
import { ScientSourcesLibraryToolkit, ScientSourcesToolkit } from "./toolkits/sources/tools.ts";
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
  ...Object.values(ScientSourcesToolkit.tools),
  ...Object.values(ScientReferencesToolkit.tools),
  ...Object.values(ScientSystematicReviewsToolkit.tools),
  ...Object.values(ScientAnnotationsToolkit.tools),
  ...Object.values(ScientSkillsToolkit.tools),
  ...Object.values(ScientDocumentsToolkit.tools),
  ...Object.values(ScientOverleafToolkit.tools),
  ...Object.values(ScientComputeToolkit.tools),
  ...Object.values(ScientThreadsToolkit.tools),
];
export type ScientToolName = (typeof scientTools)[number]["name"];

/** Library-backend definitions of listed tools: same names and operations, other schemas. */
export const scientToolVariants: ReadonlyArray<Tool.Any> = [
  ...Object.values(ScientSourcesLibraryToolkit.tools),
  ...Object.values(ScientSystematicReviewsLibraryToolkit.tools),
].filter((tool) => !(scientTools as ReadonlyArray<Tool.Any>).includes(tool));
export const scientOperationCatalog = makeScientOperationCatalog(scientTools);
