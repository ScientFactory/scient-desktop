import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import { ScientComputeToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";

const TestLayer = ScientComputeToolkitRegistrationLive.pipe(
  Layer.provide(
    Layer.mock(ComputeMcpGateway)({
      runtimeInventory: () => Effect.succeed({ languages: [] }),
    }),
  ),
  Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers the Compute tools with object input schemas", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const compute = server.tools.filter(({ tool }) => tool.name.startsWith("scient_compute_"));
    expect(compute.map(({ tool }) => tool.name).toSorted()).toEqual([
      "scient_compute_control",
      "scient_compute_inventory",
      "scient_compute_output",
      "scient_compute_run",
      "scient_compute_sessions",
      "scient_compute_setup",
      "scient_compute_variables",
    ]);
    for (const { tool } of compute) expect(tool.inputSchema.type).toBe("object");
  }).pipe(Effect.provide(TestLayer)),
);
