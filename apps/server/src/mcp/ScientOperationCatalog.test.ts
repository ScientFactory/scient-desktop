import { expect, it } from "@effect/vitest";
import { hasOperationCapabilities, makeOperationRegistry } from "@scientfactory/operations";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import {
  scientOperationCatalog,
  makeScientOperationCatalog,
  scientTools,
} from "./ScientOperationCatalog.ts";
import { ScientOperation } from "./ScientOperationTool.ts";
import { ScientComputeToolkit } from "./toolkits/compute/tools.ts";
import { ScientPdfBuildTool } from "./toolkits/documents/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ScientSourcesToolkit } from "./toolkits/sources/tools.ts";
import { ScientSkillLoadTool } from "./toolkits/skills/tools.ts";

const ScientSourcesListTool = ScientSourcesToolkit.tools.scient_sources_list;

it("describes every mounted tool by its own annotation", () => {
  expect(scientOperationCatalog.list()).toHaveLength(scientTools.length);
  for (const tool of [
    ScientPdfBuildTool,
    ScientComputeToolkit.tools.scient_compute_inventory,
    ScientSourcesListTool,
    ScientSkillLoadTool,
  ]) {
    const operation = scientOperationCatalog.forTool(tool.name)!;
    expect(operation).toBe(Context.getOrUndefined(tool.annotations, ScientOperation));
    expect(scientOperationCatalog.get(operation.id)).toBe(operation);
    expect(Tool.getJsonSchema(tool).type).toBe("object");
  }
  expect(scientOperationCatalog.forTool("mcp__t3-code__scient_pdf_build")).toBeUndefined();
  expect(scientOperationCatalog.get("retired-or-unknown-operation")).toBeUndefined();
});

it("leaves upstream's browser tools to upstream's host registration", () => {
  for (const tool of Object.values(PreviewToolkit.tools))
    expect(scientOperationCatalog.forTool(tool.name)).toBeUndefined();
});

it("preserves automatic Sources writes independently of the Browser grant", () => {
  const baseline = new Set(["documents:build", "sources:read", "sources:write"] as const);
  const available = scientOperationCatalog
    .list()
    .filter((operation) => hasOperationCapabilities(operation, baseline));
  // 3 document builds, 8 Overleaf tools (no grant of their own), 10 Sources tools and the Compute
  // inventory, which any agent may read.
  expect(available).toHaveLength(22);
  const sources = Object.values(ScientSourcesToolkit.tools);
  expect(sources).toHaveLength(10);
  for (const tool of sources) {
    const operation = scientOperationCatalog.forTool(tool.name)!;
    expect(available).toContain(operation);
    expect(operation.requiredCapabilities.includes("sources:write")).toBe(
      !Context.get(tool.annotations, Tool.Readonly),
    );
  }
});

it("rejects ambiguous IDs, duplicate transport names and tools without operation ownership", () => {
  expect(() =>
    makeOperationRegistry([
      scientOperationCatalog.get("sources.list")!,
      scientOperationCatalog.get("sources.list")!,
    ]),
  ).toThrow("Duplicate Scient operation");
  expect(() => makeScientOperationCatalog([ScientSourcesListTool, ScientSourcesListTool])).toThrow(
    "Duplicate Scient tool",
  );
  const unowned = Tool.make("unowned", { parameters: Schema.Struct({}) });
  expect(() => makeScientOperationCatalog([unowned])).toThrow(
    "Missing Scient operation definition",
  );
  expect(() =>
    makeScientOperationCatalog([
      ScientSourcesListTool,
      unowned.annotate(ScientOperation, {
        id: "sources.list",
        scope: "workspace",
        requiredCapabilities: ["sources:read"],
      }),
    ]),
  ).toThrow("Duplicate Scient operation");
  expect(() =>
    makeOperationRegistry([{ id: "", scope: "thread", requiredCapabilities: [] }]),
  ).toThrow("require an ID");
});
