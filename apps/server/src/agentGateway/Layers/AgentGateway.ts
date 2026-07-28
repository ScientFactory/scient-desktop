/**
 * AgentGatewayLive - Live layer wiring the Scient agent gateway read + drive
 * surface.
 *
 * Composes the credential service, the read-model snapshot query, the
 * orchestration engine, and the read/coordination and drive tools into the MCP
 * streamable-HTTP transport served by the `POST /mcp` route. Read tools observe
 * sibling threads; drive tools (send/interrupt) dispatch orchestration commands
 * and are admitted only while the caller's own turn is active.
 *
 * @module agentGateway/Layers/AgentGateway
 */
import { ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SYNARA_GATEWAY_HARNESS_POLICY } from "../harnessPolicy.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { makeThreadReadTools } from "../threadReadTools.ts";
import { makeThreadWriteTools } from "../threadWriteTools.ts";

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const requireThreadShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new Error(`Thread "${threadId}" was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const tools = [
    ...makeThreadReadTools({ snapshotQuery, requireThreadShell }),
    ...makeThreadWriteTools({ snapshotQuery, orchestrationEngine, requireThreadShell }),
  ];

  return {
    handleMcpPost: makeAgentGatewayMcpTransport({
      credentials,
      snapshotQuery,
      tools,
      instructions: SYNARA_GATEWAY_HARNESS_POLICY,
      requireThreadShell,
    }),
  } satisfies AgentGatewayShape;
});

export const AgentGatewayLive = Layer.effect(AgentGateway, makeAgentGateway);
