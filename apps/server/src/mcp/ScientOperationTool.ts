import type { OperationDefinition } from "@scientfactory/operations";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

export type OperationMetadata = Pick<
  OperationDefinition,
  "id" | "family" | "scope" | "requiredCapabilities" | "approval" | "documentation"
>;

/** Adapter annotation: the existing domain schemas remain the single source. */
export class ScientOperation extends Context.Service<ScientOperation, OperationMetadata>()(
  "t3/mcp/ScientOperationTool/ScientOperation",
) {}

export function operationDefinitionForTool(tool: Tool.Any): OperationDefinition {
  const metadata = Context.getOrUndefined(tool.annotations, ScientOperation);
  if (!metadata) throw new Error(`Missing Scient operation definition: ${tool.name}`);
  return {
    ...metadata,
    version: 1,
    title: Context.getOrUndefined(tool.annotations, Tool.Title) ?? tool.name,
    description: Tool.getDescription(tool) ?? "",
    input: tool.parametersSchema,
    output: tool.successSchema,
    failure: tool.failureSchema,
    effects: {
      readOnly: Context.get(tool.annotations, Tool.Readonly),
      destructive: Context.get(tool.annotations, Tool.Destructive),
      idempotent: Context.get(tool.annotations, Tool.Idempotent),
      openWorld: Context.get(tool.annotations, Tool.OpenWorld),
    },
  };
}
