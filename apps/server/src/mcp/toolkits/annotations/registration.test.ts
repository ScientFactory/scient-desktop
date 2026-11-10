import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";

import { ScientAnnotationsToolkitRegistrationLive } from "../../McpHttpServer.ts";

const TestLayer = ScientAnnotationsToolkitRegistrationLive.pipe(
  Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers annotation tools that read, write and undo without reaching the network", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.filter(({ tool }) => tool.name.startsWith("scient_annotations_"));
    expect(
      Object.fromEntries(
        tools.map(({ tool }) => [
          tool.name,
          [tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint],
        ]),
      ),
    ).toEqual({
      scient_annotations_read: [true, false],
      scient_annotations_add: [false, false],
      scient_annotations_update: [false, false],
      scient_annotations_remove: [false, true],
      scient_annotations_restore: [false, false],
    });
    for (const { tool } of tools) expect(tool.annotations?.openWorldHint).toBe(false);
  }).pipe(Effect.provide(TestLayer)),
);
