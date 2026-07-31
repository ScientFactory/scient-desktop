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
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  resolveAutomationOperationAuthority,
  ScientAutomationOperationAuthorityError,
} from "../../scientOperations/automationAuthority.ts";
import { ScientOperationExecutor } from "../../scientOperations/Services/ScientOperationExecutor.ts";
import { SYNARA_GATEWAY_HARNESS_POLICY } from "../harnessPolicy.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { makeThreadReadTools } from "../threadReadTools.ts";
import { makeThreadWriteTools } from "../threadWriteTools.ts";
import { GatewayToolError } from "../toolRuntime.ts";

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const operationExecutor = yield* ScientOperationExecutor;
  const automationRepository = yield* AutomationRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

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
    ...makeThreadWriteTools({
      snapshotQuery,
      orchestrationEngine,
      subscribeSessionRevocations: credentials.subscribeSessionRevocations,
    }),
  ];

  const automationAuthorityFailure = (message: string) =>
    new GatewayToolError("automation_authority_inactive", message);

  const resolveAutomationAuthority = (scope: {
    readonly threadId: Parameters<typeof projectionTurnRepository.getByTurnId>[0]["threadId"];
    readonly projectId: string;
    readonly provider: Parameters<
      typeof resolveAutomationOperationAuthority
    >[0]["caller"]["provider"];
    readonly turnId: Parameters<typeof projectionTurnRepository.getByTurnId>[0]["turnId"];
    readonly now: number;
  }) =>
    Effect.gen(function* () {
      const turnOption = yield* projectionTurnRepository
        .getByTurnId({ threadId: scope.threadId, turnId: scope.turnId })
        .pipe(
          Effect.mapError(() =>
            automationAuthorityFailure(
              "Scient could not verify this automation turn's persisted origin.",
            ),
          ),
        );
      if (Option.isNone(turnOption)) {
        const activeRun = yield* automationRepository
          .getRunByThreadId({ threadId: scope.threadId })
          .pipe(
            Effect.mapError(() =>
              automationAuthorityFailure(
                "Scient could not verify the active automation run for this thread.",
              ),
            ),
          );
        if (Option.isSome(activeRun)) {
          return yield* Effect.fail(
            automationAuthorityFailure(
              "An active automation run has no exact projected authorizing turn.",
            ),
          );
        }
        return null;
      }
      const pendingMessageId = turnOption.value.pendingMessageId;
      if (pendingMessageId === null) return null;
      const runOption = yield* automationRepository
        .getRunByMessageId({ messageId: pendingMessageId })
        .pipe(
          Effect.mapError(() =>
            automationAuthorityFailure(
              "Scient could not verify the automation run for this pending message.",
            ),
          ),
        );
      if (Option.isNone(runOption)) return null;
      const definitionOption = yield* automationRepository
        .getDefinitionById({ id: runOption.value.automationId })
        .pipe(
          Effect.mapError(() =>
            automationAuthorityFailure("Scient could not verify the automation definition."),
          ),
        );
      if (Option.isNone(definitionOption)) {
        return yield* Effect.fail(
          automationAuthorityFailure("The automation definition no longer exists."),
        );
      }
      return yield* Effect.try({
        try: () =>
          resolveAutomationOperationAuthority({
            definition: definitionOption.value,
            run: runOption.value,
            turn: turnOption.value,
            caller: {
              projectId: scope.projectId,
              threadId: scope.threadId,
              provider: scope.provider,
              turnId: scope.turnId,
            },
            now: scope.now,
          }),
        catch: (error) =>
          error instanceof ScientAutomationOperationAuthorityError
            ? automationAuthorityFailure(error.message)
            : automationAuthorityFailure("Scient could not validate automation authority."),
      });
    });

  return {
    handleMcpPost: makeAgentGatewayMcpTransport({
      credentials,
      snapshotQuery,
      tools,
      instructions: SYNARA_GATEWAY_HARNESS_POLICY,
      requireThreadShell,
      operationExecutor,
      resolveAutomationAuthority,
    }),
  } satisfies AgentGatewayShape;
});

export const AgentGatewayLive = Layer.effect(AgentGateway, makeAgentGateway);
