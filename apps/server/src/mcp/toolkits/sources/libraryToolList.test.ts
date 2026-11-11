import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import budget from "../../../provider/agentContextBudget.scient.json" with { type: "json" };
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import {
  ScientSourcesBackend,
  type ScientSourcesBackendKind,
} from "../../../scient/sources/SourcesBackend.ts";
import { ScientSourcesToolkitRegistrationLive } from "../../McpHttpServer.ts";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The Sources tools as the budget test measures the whole list: what the model sees. */
const sourcesToolBytes = (backend: ScientSourcesBackendKind) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return utf8Bytes(
      JSON.stringify(
        server.tools
          .filter(({ tool }) => tool.name.startsWith("scient_sources_"))
          .map(({ tool }) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
      ),
    );
  }).pipe(
    Effect.provide(
      ScientSourcesToolkitRegistrationLive.pipe(
        Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
        Layer.provide(Layer.succeed(ScientSourcesBackend, backend)),
        Layer.provideMerge(McpServer.McpServer.layer),
      ),
    ),
  );

// The switch (5e) moves this number into agentContextBudget.scient.json; the same tools are
// swapped one for one, so the whole list grows by exactly the Sources tools' difference.
it.effect("measures the tool list the library backend advertises", () =>
  Effect.gen(function* () {
    const project = yield* sourcesToolBytes("project");
    const library = yield* sourcesToolBytes("library");
    expect({
      mcpToolListJsonBytes: budget.mcpToolListJsonBytes,
      libraryMcpToolListJsonBytes: budget.mcpToolListJsonBytes - project + library,
    }).toEqual({ mcpToolListJsonBytes: 110_523, libraryMcpToolListJsonBytes: 111_496 });
  }),
);
