// @effect-diagnostics nodeBuiltinImport:off -- Verify declared documentation owners exist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { hasOperationCapabilities, makeOperationRegistry } from "@scientfactory/operations";
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
import { ScientSourcesToolkit } from "./toolkits/sources/tools.ts";

const ScientSourcesListTool = ScientSourcesToolkit.tools.scient_sources_list;
import { ScientSkillLoadTool } from "./toolkits/skills/tools.ts";
import { PreviewSnapshotTool } from "./toolkits/preview/tools.ts";

it("describes every mounted tool without replacing its schema", () => {
  expect(scientOperationCatalog.list()).toHaveLength(scientTools.length);
  for (const tool of [
    ScientPdfBuildTool,
    ScientComputeToolkit.tools.scient_compute_inventory,
    ScientSourcesListTool,
    ScientSkillLoadTool,
    PreviewSnapshotTool,
  ]) {
    const operation = scientOperationCatalog.forTool(tool.name)!;
    expect(operation.input).toBe(tool.parametersSchema);
    expect(operation.output).toBe(tool.successSchema);
    expect(operation.failure).toBe(tool.failureSchema);
    expect(scientOperationCatalog.get(operation.id)).toBe(operation);
    expect(Tool.getJsonSchema(tool).type).toBe("object");
  }
  for (const operation of scientOperationCatalog.list()) {
    expect(operation.version).toBe(1);
    expect(
      NodeFS.existsSync(
        NodePath.resolve(import.meta.dirname, "../../../..", operation.documentation),
      ),
      operation.documentation,
    ).toBe(true);
  }
  expect(scientOperationCatalog.forTool("mcp__t3-code__scient_pdf_build")).toBeUndefined();
  expect(scientOperationCatalog.get("retired-or-unknown-operation")).toBeUndefined();
});

it("preserves automatic Sources writes independently of the Browser grant", () => {
  const baseline = new Set(["documents:build", "sources:read", "sources:write"] as const);
  const available = scientOperationCatalog
    .list()
    .filter((operation) => hasOperationCapabilities(operation, baseline));
  expect(available).toHaveLength(12);
  expect(available.filter((operation) => operation.family === "sources")).toHaveLength(9);
  expect(available.some((operation) => operation.family === "browser")).toBe(false);
  for (const operation of scientOperationCatalog.list().filter((op) => op.family === "sources")) {
    expect(operation.requiredCapabilities.includes("sources:write")).toBe(
      !operation.effects.readOnly,
    );
    expect(operation.approval).toBe(
      operation.effects.readOnly ? "session-grant" : "explicit-user-request-guidance",
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
        family: "sources",
        scope: "workspace",
        requiredCapabilities: ["sources:read"],
        approval: "session-grant",
        documentation: "docs/user/sources.md",
      }),
    ]),
  ).toThrow("Duplicate Scient operation");
  expect(() =>
    makeOperationRegistry([
      {
        ...scientOperationCatalog.get("sources.list")!,
        version: 0,
      },
    ]),
  ).toThrow("positive integer version");
});

it("keeps new native browser actions behind the captured Preview grant", () => {
  for (const [tool, id] of [
    ["preview_dialog", "browser.dialog"],
    ["preview_hover", "browser.hover"],
    ["preview_select", "browser.select"],
    ["preview_drag", "browser.drag"],
    ["preview_upload", "browser.upload"],
  ]) {
    const operation = scientOperationCatalog.forTool(tool!)!;
    expect(operation.id).toBe(id);
    expect(operation.family).toBe("browser");
    expect(operation.scope).toBe("thread");
    expect(operation.requiredCapabilities).toEqual(["preview"]);
    expect(operation.approval).toBe("session-grant");
    expect(hasOperationCapabilities(operation, new Set())).toBe(false);
    expect(hasOperationCapabilities(operation, new Set(["preview"] as const))).toBe(true);
  }
});
