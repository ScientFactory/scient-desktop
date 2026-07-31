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
import { ThreadId, type ProviderKind, type TurnId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import type { AutomationRepositoryShape } from "../../persistence/Services/AutomationRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import type { ProjectionTurnRepositoryShape } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionThreadMessageRepositoryShape } from "../../persistence/Services/ProjectionThreadMessages.ts";
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

const automationAuthorityFailure = (message: string) =>
  new GatewayToolError("automation_authority_inactive", message);

/**
 * Resolve automation provenance from the thread-owned active run first.
 *
 * Only a positively verified absence of an active run permits the ordinary
 * provider-authority fallback. Once an active run exists, missing or replaced
 * turn/message provenance fails closed.
 */
export function makeAutomationAuthorityResolver(input: {
  readonly automationRepository: AutomationRepositoryShape;
  readonly projectionTurnRepository: ProjectionTurnRepositoryShape;
  readonly projectionThreadMessageRepository: ProjectionThreadMessageRepositoryShape;
}) {
  return (scope: {
    readonly threadId: ThreadId;
    readonly projectId: string;
    readonly provider: ProviderKind;
    readonly turnId: TurnId | null;
    readonly now: number;
  }) =>
    Effect.gen(function* () {
      const runOption = yield* input.automationRepository
        .getRunByThreadId({ threadId: scope.threadId })
        .pipe(
          Effect.mapError(() =>
            automationAuthorityFailure(
              "Scient could not verify the active automation run for this thread.",
            ),
          ),
        );
      if (scope.turnId === null) {
        if (Option.isNone(runOption)) return null;
        return yield* Effect.fail(
          automationAuthorityFailure(
            "An active automation run has no exact projected authorizing turn.",
          ),
        );
      }
      const turnId = scope.turnId;
      const turnOption = yield* input.projectionTurnRepository
        .getByTurnId({ threadId: scope.threadId, turnId })
        .pipe(
          Effect.mapError(() =>
            automationAuthorityFailure(
              "Scient could not verify this automation turn's persisted origin.",
            ),
          ),
        );
      if (Option.isNone(turnOption)) {
        if (Option.isNone(runOption)) {
          return yield* Effect.fail(
            automationAuthorityFailure(
              "Scient could not prove that this provider turn has no automation origin.",
            ),
          );
        }
        return yield* Effect.fail(
          automationAuthorityFailure(
            "An active automation run has no exact projected authorizing turn.",
          ),
        );
      }
      if (Option.isNone(runOption)) {
        const pendingMessageId = turnOption.value.pendingMessageId;
        if (pendingMessageId === null) {
          return yield* Effect.fail(
            automationAuthorityFailure(
              "Scient could not prove that this provider turn has no automation message origin.",
            ),
          );
        }
        const messageOption = yield* input.projectionThreadMessageRepository
          .getByMessageId({ messageId: pendingMessageId })
          .pipe(
            Effect.mapError(() =>
              automationAuthorityFailure(
                "Scient could not verify this turn's immutable dispatch origin.",
              ),
            ),
          );
        if (Option.isNone(messageOption)) {
          return yield* Effect.fail(
            automationAuthorityFailure(
              "Scient could not prove that this pending message has no automation origin.",
            ),
          );
        }
        const message = messageOption.value;
        if (
          message.threadId !== scope.threadId ||
          (message.turnId !== null && message.turnId !== turnId)
        ) {
          return yield* Effect.fail(
            automationAuthorityFailure(
              "The pending message does not belong to this exact provider thread and turn.",
            ),
          );
        }
        if (message.dispatchOrigin !== "user") {
          return yield* Effect.fail(
            automationAuthorityFailure(
              "This provider turn does not have explicit ordinary-user provenance and cannot use provider authority.",
            ),
          );
        }
        return null;
      }
      const run = runOption.value;
      const pendingMessageId = turnOption.value.pendingMessageId;
      if (pendingMessageId === null || run.messageId !== pendingMessageId) {
        return yield* Effect.fail(
          automationAuthorityFailure(
            "The active automation run does not own this turn's exact pending message.",
          ),
        );
      }
      const definitionOption = yield* input.automationRepository
        .getDefinitionById({ id: run.automationId })
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
            run,
            turn: turnOption.value,
            caller: {
              projectId: scope.projectId,
              threadId: scope.threadId,
              provider: scope.provider,
              turnId,
            },
            now: scope.now,
          }),
        catch: (error) =>
          error instanceof ScientAutomationOperationAuthorityError
            ? automationAuthorityFailure(error.message)
            : automationAuthorityFailure("Scient could not validate automation authority."),
      });
    });
}

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const operationExecutor = yield* ScientOperationExecutor;
  const automationRepository = yield* AutomationRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;

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

  const resolveAutomationAuthority = makeAutomationAuthorityResolver({
    automationRepository,
    projectionTurnRepository,
    projectionThreadMessageRepository,
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
