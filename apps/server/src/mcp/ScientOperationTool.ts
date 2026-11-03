import type { OperationDefinition } from "@scientfactory/operations";
import * as Context from "effect/Context";
import type { Tool } from "effect/ai";

export type { OperationDefinition } from "@scientfactory/operations";

/** Adapter annotation: the Tool keeps its own schemas, title and hints. */
export class ScientOperation extends Context.Service<ScientOperation, OperationDefinition>()(
  "t3/mcp/ScientOperationTool/ScientOperation",
) {}

export function operationDefinitionForTool(tool: Tool.Any): OperationDefinition {
  const operation = Context.getOrUndefined(tool.annotations, ScientOperation);
  if (!operation) throw new Error(`Missing Scient operation definition: ${tool.name}`);
  return operation;
}
