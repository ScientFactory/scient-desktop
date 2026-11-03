import { expect, it } from "@effect/vitest";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";

import { hostMcpTools } from "./McpHttpServer.ts";
import { scientTools } from "./ScientOperationCatalog.ts";

it("names every listed tool in the work log", () => {
  const unnamed = [...hostMcpTools, ...scientTools]
    .map((tool) => tool.name)
    .filter((name) => resolveT3McpToolDefinition(name) === null);
  expect(unnamed).toEqual([]);
});
