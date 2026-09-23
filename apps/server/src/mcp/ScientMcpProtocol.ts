import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, type Tool } from "effect/unstable/ai";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { AgentInvocationContext } from "../scient/operations/AgentInvocationContext.ts";
import { listAvailableScientOperations } from "../scient/operations/AgentOperationDispatcher.ts";
import { WorkspaceBindingResolver } from "../scient/projectScope/WorkspaceBindingResolver.ts";
import { scientOperationCatalog } from "./ScientOperationCatalog.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { scientInvocationForMcp } from "./ScientMcpInvocation.ts";

class ScientToolList extends RpcMiddleware.Service<ScientToolList>()("scient/mcp/ToolList") {}
// The adapter owns the dated wire schema. Inspect only the fields needed for
// filtering; do not replace its plain result with the public authoring model.
const isToolListResult = Schema.is(
  Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
);

/** Host tools keep their own handlers and admission. Declare their actual Tool
 * objects at composition, never infer ownership from an unrecognized name. */
export function makeScientToolListLayer(
  hostTools: ReadonlyArray<Tool.Any> = [],
  deviceTools: ReadonlyArray<Tool.Any> = [],
) {
  const hostNames = new Set<string>();
  for (const tool of hostTools) {
    if (hostNames.has(tool.name) || scientOperationCatalog.forTool(tool.name))
      throw new Error(`Ambiguous MCP tool ownership: ${tool.name}`);
    hostNames.add(tool.name);
  }
  const deviceNames = new Set<string>();
  for (const tool of deviceTools) {
    if (!hostNames.has(tool.name))
      throw new Error(`MCP device tool is not declared as a host tool: ${tool.name}`);
    deviceNames.add(tool.name);
  }
  return Layer.effect(
    ScientToolList,
    Effect.gen(function* () {
      const resolver = yield* WorkspaceBindingResolver;
      return ScientToolList.of((effect) =>
        Effect.gen(function* () {
          const result = yield* effect;
          if (!isToolListResult(result))
            return yield* Effect.die(new Error("Expected the registered ListTools result."));
          const listed = result;
          const mcpInvocation = yield* Effect.withFiber((fiber) =>
            Effect.succeed(Context.getUnsafe(fiber.context, McpInvocationContext)),
          );
          const invocation = scientInvocationForMcp(mcpInvocation);
          const hasDeviceAccess = mcpInvocation.capabilities.has("device");
          const available = yield* listAvailableScientOperations().pipe(
            Effect.provideService(WorkspaceBindingResolver, resolver),
            Effect.provideService(AgentInvocationContext, invocation),
          );
          const ids = new Set(available.map((operation) => operation.id));
          for (const tool of listed.tools) {
            if (!scientOperationCatalog.forTool(tool.name) && !hostNames.has(tool.name))
              return yield* Effect.die(new Error(`Undeclared MCP tool ownership: ${tool.name}`));
          }
          const filtered = {
            ...listed,
            tools: listed.tools.filter((tool) => {
              const operation = scientOperationCatalog.forTool(tool.name);
              return operation === undefined
                ? hostNames.has(tool.name) && (!deviceNames.has(tool.name) || hasDeviceAccess)
                : ids.has(operation.id);
            }),
          };
          // RPC middleware erases the handler success type to an opaque marker.
          // This middleware is attached only to ListTools, checked above, and returns
          // the same schema. No request, error, or protocol payload is widened.
          return filtered as unknown as RpcMiddleware.SuccessValue;
        }),
      );
    }),
  );
}

/** Preserve Effect's protocol and add only request-scoped tool discovery. */
const protocol = McpProtocol.v2025_06_18;
const listTools = protocol.clientRpcs.requests.get("tools/list");
if (!listTools) throw new Error("The selected MCP protocol has no tool discovery RPC.");

export const ScientMcpProtocol: McpProtocol.ProtocolAdapter = {
  ...protocol,
  // The public adapter erases the RPC union. Rebuilding from that map cannot
  // recover its generic handler union; restore only the adapter's erased shape.
  // The original RPC schemas and client middleware are retained and tested.
  clientRpcs: RpcGroup.make(...protocol.clientRpcs.requests.values()).merge(
    RpcGroup.make(listTools).middleware(ScientToolList),
  ) as unknown as McpProtocol.ErasedClientRpcGroup,
};
