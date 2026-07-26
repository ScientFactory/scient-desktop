/**
 * AgentGatewayLive - Live layer wiring the Synara agent gateway read surface.
 *
 * Composes the credential service, the read-model snapshot query, and the
 * read/coordination tools into the MCP streamable-HTTP transport served by the
 * `POST /mcp` route. This slice serves the read tools only; the drive tools
 * (send/interrupt) land in their own reviewed slice.
 *
 * @module agentGateway/Layers/AgentGateway
 */
import { ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SYNARA_GATEWAY_HARNESS_POLICY } from "../harnessPolicy.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { makeThreadReadTools } from "../threadReadTools.ts";

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const requireThreadShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new Error(`Thread "${threadId}" was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const tools = makeThreadReadTools({ snapshotQuery, requireThreadShell });

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
