import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer } from "effect/ai";

import { ScientComputeToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { ScientComputeToolkit } from "./tools.ts";

const TestLayer = ScientComputeToolkitRegistrationLive.pipe(
  Layer.provide(
    Layer.mock(ComputeMcpGateway)({
      runtimeInventory: () => Effect.succeed({ languages: [] }),
    }),
  ),
  Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it("accepts JSON values in fresh notebook runs and sweep settings", () => {
  const parameters = { threshold: 0.7, plot: true, method: "pr", bands: [1, 2] };
  const decode = Schema.decodeUnknownSync(
    ScientComputeToolkit.tools.scient_notebook_run.parametersSchema,
  );
  for (const settings of [{ parameters }, { sweep: [parameters] }]) {
    const input = { path: "threshold.ipynb", ...settings };
    expect(decode(input)).toEqual(input);
  }
});

it("accepts ordinary JSON values in saved file parameters", () => {
  const decode = Schema.decodeUnknownSync(
    ScientComputeToolkit.tools.scient_compute_run_file.parametersSchema,
  );
  const input = {
    path: "analysis.R",
    parameters: { threshold: 0.7, plot: true, bands: [1, 2], notes: { label: null } },
  };
  expect(decode(input)).toEqual(input);
});

it.effect("registers the Compute tools with object input schemas", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const compute = server.tools.filter(
      ({ tool }) => tool.name.startsWith("scient_compute_") || tool.name.startsWith("scient_data_"),
    );
    expect(compute.map(({ tool }) => tool.name).toSorted()).toEqual([
      "scient_compute_control",
      "scient_compute_inventory",
      "scient_compute_output",
      "scient_compute_run",
      "scient_compute_run_file",
      "scient_compute_sessions",
      "scient_compute_setup",
      "scient_compute_variables",
      "scient_data_materialize_view",
      "scient_data_preview_view",
      "scient_data_profile",
    ]);
    for (const { tool } of compute) expect(tool.inputSchema.type).toBe("object");
    const exportTool = server.tools.find(({ tool }) => tool.name === "scient_results_export")?.tool;
    expect(exportTool?.inputSchema).toMatchObject({
      properties: { revision: expect.any(Object), path: expect.any(Object) },
    });
    expect(exportTool?.inputSchema.required ?? []).not.toContain("revision");
    for (const name of ["scient_results_export", "scient_results_verify"]) {
      expect(server.tools.find(({ tool }) => tool.name === name)?.tool.inputSchema.type).toBe(
        "object",
      );
    }
  }).pipe(Effect.provide(TestLayer)),
);
