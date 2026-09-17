import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, type Tool, type Toolkit } from "effect/unstable/ai";

import { AgentInvocationContext } from "../scient/operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../scient/operations/AgentOperationDispatcher.ts";
import { WorkspaceBindingResolver } from "../scient/projectScope/WorkspaceBindingResolver.ts";
import { scientOperationCatalog, scientTools } from "./ScientOperationCatalog.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { scientInvocationForMcp } from "./ScientMcpInvocation.ts";

/** Intercepts registration, preserving Effect's schemas and result encoding. */
export const registerScientToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      for (const tool of Object.values(toolkit.tools)) {
        if (tool !== scientTools.find((registered) => registered.name === tool.name)) {
          return yield* Effect.die(new Error(`Unregistered Scient tool definition: ${tool.name}`));
        }
      }
      const server = yield* McpServer.McpServer;
      const resolver = yield* WorkspaceBindingResolver;
      const guarded = McpServer.McpServer.of({
        ...server,
        addTool: (registration) => {
          const operation = scientOperationCatalog.forTool(registration.tool.name);
          if (!operation)
            return Effect.die(new Error(`Unregistered Scient tool: ${registration.tool.name}`));
          return server.addTool({
            ...registration,
            handle: (payload) =>
              Effect.withFiber((fiber) => {
                const invocation = scientInvocationForMcp(
                  Context.getUnsafe(fiber.context, McpInvocationContext),
                );
                return dispatchScientOperation(operation.id, registration.handle(payload)).pipe(
                  Effect.provideService(WorkspaceBindingResolver, resolver),
                  Effect.provideService(AgentInvocationContext, invocation),
                  Effect.catchTags({
                    AgentOperationUnavailable: (error) =>
                      Effect.succeed(
                        new McpSchema.CallToolResult({
                          isError: true,
                          content: [{ type: "text", text: error.message }],
                        }),
                      ),
                    AgentWorkspaceError: (error) =>
                      Effect.succeed(
                        new McpSchema.CallToolResult({
                          isError: true,
                          content: [{ type: "text", text: error.message }],
                        }),
                      ),
                  }),
                );
              }),
          });
        },
      });
      yield* McpServer.registerToolkit(toolkit).pipe(
        Effect.provideService(McpServer.McpServer, guarded),
      );
    }),
  );
