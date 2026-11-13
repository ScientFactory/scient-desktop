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
import {
  ScientSourcesToolkitRegistrationLive,
  ScientSystematicReviewsToolkitRegistrationLive,
} from "../../McpHttpServer.ts";

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The Sources and review tools as the budget test measures the whole list: what the model sees. */
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
      Layer.mergeAll(
        ScientSourcesToolkitRegistrationLive,
        ScientSystematicReviewsToolkitRegistrationLive,
      ).pipe(
        Layer.provide(Layer.succeed(WorkspaceBindingResolver, workspaceResolverForTest(new Map()))),
        Layer.provide(Layer.succeed(ScientSourcesBackend, backend)),
        Layer.provideMerge(McpServer.McpServer.layer),
      ),
    ),
  );

// The budget file holds the library backend's list; the project backend swaps the same tools one
// for one, so its whole list differs by exactly the Sources tools' difference.
it.effect("measures the tool list each backend advertises", () =>
  Effect.gen(function* () {
    const project = yield* sourcesToolBytes("project");
    const library = yield* sourcesToolBytes("library");
    expect({
      mcpToolListJsonBytes: budget.mcpToolListJsonBytes,
      projectMcpToolListJsonBytes: budget.mcpToolListJsonBytes - library + project,
    }).toEqual({ mcpToolListJsonBytes: 114_703, projectMcpToolListJsonBytes: 110_848 });
  }),
);
