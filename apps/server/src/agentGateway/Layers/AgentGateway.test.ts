import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type AutomationDefinition,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { AutomationRepositoryLive } from "../../persistence/Layers/AutomationRepository.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  automationAllowedCapabilitiesForDefinition,
  makeAutomationOperationGrantSnapshot,
} from "../../scientOperations/automationAuthority.ts";
import type { ScientOperationResultReceipt } from "../../scientOperations/authority.ts";
import { makeEphemeralScientOperationExecutor } from "../../scientOperations/Layers/ScientOperationExecutor.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import { mcpToolResultJson } from "../protocol.ts";
import type { AgentGatewayCredentialsShape } from "../Services/AgentGatewayCredentials.ts";
import type { ToolEntry } from "../toolRuntime.ts";
import { makeAutomationAuthorityResolver } from "./AgentGateway.ts";

const layer = it.layer(
  AutomationRepositoryLive.pipe(
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const readTool: ToolEntry = {
  operation: "project.context.read",
  decodeInput: () => ({}),
  definition: {
    name: "scient_test_read",
    description: "Test read.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  handler: () => Effect.succeed(mcpToolResultJson({ read: true })),
};

const writeTool: ToolEntry = {
  operation: "thread.message.send",
  decodeInput: () => ({ threadId: "thread-target", message: "test", mode: "queue" }),
  definition: {
    name: "scient_test_write",
    description: "Test write.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  handler: () => Effect.succeed(mcpToolResultJson({ wrote: true })),
};

function automationInput(projectId: ProjectId, schedule: AutomationDefinition["schedule"]) {
  return {
    projectId,
    name: "Gateway provenance test",
    prompt: "Run the exact authorized task.",
    schedule,
    modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
    maxRuntimeSeconds: 3_600,
  };
}

function seedActiveRun(input: {
  readonly key: string;
  readonly schedule?: AutomationDefinition["schedule"];
  readonly projectedTurnId: TurnId;
  readonly projectedPendingMessageId: MessageId | null;
}) {
  return Effect.gen(function* () {
    const automationRepository = yield* AutomationRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const issuedAt = new Date(Date.now() - 1_000).toISOString();
    const automationId = AutomationId.makeUnsafe(`automation:${input.key}`);
    const runId = AutomationRunId.makeUnsafe(`automation-run:${input.key}`);
    const projectId = ProjectId.makeUnsafe(`project:${input.key}`);
    const threadId = ThreadId.makeUnsafe(`thread:${input.key}`);
    const grantedMessageId = MessageId.makeUnsafe(`message:${input.key}:granted`);
    const definition = yield* automationRepository.createDefinition({
      id: automationId,
      input: automationInput(projectId, input.schedule ?? { type: "manual" }),
      now: issuedAt,
    });
    const allowedCapabilities = automationAllowedCapabilitiesForDefinition(definition);
    const operationGrant = makeAutomationOperationGrantSnapshot({
      definition,
      runId,
      threadId,
      pendingMessageId: grantedMessageId,
      allowedCapabilities,
      issuedAt,
    });
    yield* automationRepository.createRun({
      id: runId,
      automationId,
      projectId,
      threadId,
      messageId: grantedMessageId,
      trigger: { type: "scheduled" },
      scheduledFor: issuedAt,
      permissionSnapshot: {
        provider: definition.modelSelection.provider,
        modelSelection: definition.modelSelection,
        ...(definition.providerOptions ? { providerOptions: definition.providerOptions } : {}),
        completionPolicyVersion: definition.completionPolicyVersion,
        runtimeMode: definition.runtimeMode,
        interactionMode: definition.interactionMode,
        worktreeMode: definition.worktreeMode,
        allowedCapabilities,
        operationGrant,
        createdAt: issuedAt,
      },
      now: issuedAt,
    });
    yield* automationRepository.markRunStarted({
      id: runId,
      threadId,
      messageId: grantedMessageId,
      threadCreateCommandId: CommandId.makeUnsafe(`command:${input.key}:thread`),
      turnStartCommandId: CommandId.makeUnsafe(`command:${input.key}:turn`),
      startedAt: issuedAt,
    });
    yield* projectionTurnRepository.upsertByTurnId({
      threadId,
      turnId: input.projectedTurnId,
      pendingMessageId: input.projectedPendingMessageId,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: null,
      state: "running",
      requestedAt: issuedAt,
      startedAt: issuedAt,
      completedAt: null,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
    });
    return { definition, runId, projectId, threadId, grantedMessageId, automationRepository };
  });
}

function deniedTransport(input: {
  readonly shell: OrchestrationThreadShell;
  readonly resolveAutomationAuthority: ReturnType<typeof makeAutomationAuthorityResolver>;
  readonly receipts: ScientOperationResultReceipt[];
}) {
  const identity = {
    sessionKey: "gateway-session:production-resolver-test",
    threadId: input.shell.id,
    provider: "codex" as const,
    issuedAt: 0,
    capabilities: ["project:context:read", "thread:list", "thread:read", "thread:drive"] as const,
  };
  const credentials = {
    verifySession: (token: string) => (token === "valid-token" ? identity : null),
    bindWriteAuthority: (_token: string, turnId: string) => ({ ...identity, turnId }),
    verifyWriteAuthority: () => true,
    acquireWriteLease: () => ({ sessionKey: identity.sessionKey, release: () => undefined }),
    subscribeSessionRevocations: () => () => undefined,
  } as unknown as AgentGatewayCredentialsShape;
  const snapshotQuery = {
    getThreadShellById: () => Effect.succeed(Option.some(input.shell)),
  } as unknown as ProjectionSnapshotQueryShape;
  return makeAgentGatewayMcpTransport({
    credentials,
    snapshotQuery,
    tools: [readTool, writeTool],
    instructions: "test",
    requireThreadShell: () => Effect.succeed(input.shell),
    operationExecutor: makeEphemeralScientOperationExecutor({
      recordReceipt: (receipt) => input.receipts.push(receipt),
    }),
    resolveAutomationAuthority: input.resolveAutomationAuthority,
  });
}

function assertReadAndWriteDenied(input: {
  readonly shell: OrchestrationThreadShell;
  readonly resolveAutomationAuthority: ReturnType<typeof makeAutomationAuthorityResolver>;
}) {
  return Effect.gen(function* () {
    const receipts: ScientOperationResultReceipt[] = [];
    const transport = deniedTransport({ ...input, receipts });
    for (const name of ["scient_test_read", "scient_test_write"]) {
      const response = yield* transport({
        authorizationHeader: "Bearer valid-token",
        body: {
          jsonrpc: "2.0",
          id: name,
          method: "tools/call",
          params: { name, arguments: {} },
        },
      });
      assert.strictEqual(response.status, 403);
      assert.match(JSON.stringify(response.body), /automation_authority_inactive/);
    }
    assert.strictEqual(receipts.length, 0);
    assert.isFalse(
      receipts.some(
        (receipt) => receipt.authorityGeneration === "gateway-session:production-resolver-test",
      ),
    );
  });
}

layer("AgentGateway automation provenance", (it) => {
  it.effect("denies an active run when a replacement turn carries a different message", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const turnId = TurnId.makeUnsafe("turn:replacement-provenance");
      const seeded = yield* seedActiveRun({
        key: "replacement-provenance",
        projectedTurnId: turnId,
        projectedPendingMessageId: MessageId.makeUnsafe("message:replacement-provenance:other"),
      });
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
      const shell = {
        id: seeded.threadId,
        projectId: seeded.projectId,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        session: { providerName: "codex", status: "running" },
        latestTurn: { turnId, state: "running" },
      } as unknown as OrchestrationThreadShell;

      yield* assertReadAndWriteDenied({
        shell,
        resolveAutomationAuthority: makeAutomationAuthorityResolver({
          automationRepository: seeded.automationRepository,
          projectionTurnRepository,
          projectionThreadMessageRepository,
        }),
      });
    }),
  );

  it.effect("denies an active run when latest-turn or pending-message proof is absent", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      for (const scenario of ["missing-latest-turn", "null-pending-message"] as const) {
        const turnId = TurnId.makeUnsafe(`turn:${scenario}`);
        const seeded = yield* seedActiveRun({
          key: scenario,
          projectedTurnId: turnId,
          projectedPendingMessageId:
            scenario === "null-pending-message"
              ? null
              : MessageId.makeUnsafe(`message:${scenario}`),
        });
        const projectionTurnRepository = yield* ProjectionTurnRepository;
        const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
        const shell = {
          id: seeded.threadId,
          projectId: seeded.projectId,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          session: { providerName: "codex", status: "running" },
          latestTurn:
            scenario === "missing-latest-turn" ? null : { turnId, state: "running" as const },
        } as unknown as OrchestrationThreadShell;

        yield* assertReadAndWriteDenied({
          shell,
          resolveAutomationAuthority: makeAutomationAuthorityResolver({
            automationRepository: seeded.automationRepository,
            projectionTurnRepository,
            projectionThreadMessageRepository,
          }),
        });
      }
    }),
  );

  it.effect("never downgrades terminal automation turns to ordinary provider authority", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      for (const terminalStatus of ["cancelled", "interrupted"] as const) {
        const key = `terminal-${terminalStatus}-provenance`;
        const turnId = TurnId.makeUnsafe(`turn:${key}`);
        const seeded = yield* seedActiveRun({
          key,
          projectedTurnId: turnId,
          projectedPendingMessageId: MessageId.makeUnsafe(`message:${key}:granted`),
        });
        const projectionTurnRepository = yield* ProjectionTurnRepository;
        const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
        yield* projectionThreadMessageRepository.upsert({
          messageId: seeded.grantedMessageId,
          threadId: seeded.threadId,
          turnId,
          role: "user",
          text: "Run the automation task.",
          dispatchOrigin: "automation",
          isStreaming: false,
          source: "native",
          createdAt: new Date(Date.now() - 1_000).toISOString(),
          updatedAt: new Date().toISOString(),
        });
        if (terminalStatus === "cancelled") {
          yield* seeded.automationRepository.cancelRun({
            runId: seeded.runId,
            now: new Date().toISOString(),
          });
        } else {
          yield* seeded.automationRepository.markRunInterrupted({
            id: seeded.runId,
            turnId,
            finishedAt: new Date().toISOString(),
          });
        }
        // A conflicting later projection cannot erase the original automation
        // provenance and unlock ordinary provider authority.
        yield* projectionThreadMessageRepository.upsert({
          messageId: seeded.grantedMessageId,
          threadId: seeded.threadId,
          turnId,
          role: "user",
          text: "Run the automation task.",
          dispatchOrigin: "user",
          isStreaming: false,
          source: "native",
          createdAt: new Date(Date.now() - 1_000).toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const shell = {
          id: seeded.threadId,
          projectId: seeded.projectId,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          session: { providerName: "codex", status: "running" },
          latestTurn: { turnId, state: "running" },
        } as unknown as OrchestrationThreadShell;

        yield* assertReadAndWriteDenied({
          shell,
          resolveAutomationAuthority: makeAutomationAuthorityResolver({
            automationRepository: seeded.automationRepository,
            projectionTurnRepository,
            projectionThreadMessageRepository,
          }),
        });
      }
    }),
  );

  it.effect("denies terminal provenance when the projected pending message was cleared", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const key = "terminal-null-pending-provenance";
      const turnId = TurnId.makeUnsafe(`turn:${key}`);
      const seeded = yield* seedActiveRun({
        key,
        projectedTurnId: turnId,
        projectedPendingMessageId: null,
      });
      yield* seeded.automationRepository.cancelRun({
        runId: seeded.runId,
        now: new Date().toISOString(),
      });
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
      const shell = {
        id: seeded.threadId,
        projectId: seeded.projectId,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        session: { providerName: "codex", status: "running" },
        latestTurn: { turnId, state: "running" },
      } as unknown as OrchestrationThreadShell;

      yield* assertReadAndWriteDenied({
        shell,
        resolveAutomationAuthority: makeAutomationAuthorityResolver({
          automationRepository: seeded.automationRepository,
          projectionTurnRepository,
          projectionThreadMessageRepository,
        }),
      });
    }),
  );

  it.effect("denies terminal provider fallback when pending-message origin is unknown", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const automationRepository = yield* AutomationRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread:terminal-unknown-origin");
      const projectId = ProjectId.makeUnsafe("project:terminal-unknown-origin");
      const turnId = TurnId.makeUnsafe("turn:terminal-unknown-origin");
      const messageId = MessageId.makeUnsafe("message:terminal-unknown-origin");
      const createdAt = new Date(Date.now() - 1_000).toISOString();
      yield* projectionTurnRepository.upsertByTurnId({
        threadId,
        turnId,
        pendingMessageId: messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: createdAt,
        startedAt: createdAt,
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      yield* projectionThreadMessageRepository.upsert({
        messageId,
        threadId,
        turnId,
        role: "user",
        text: "A legacy message with ambiguous provenance.",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: createdAt,
      });
      const shell = {
        id: threadId,
        projectId,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        session: { providerName: "codex", status: "running" },
        latestTurn: { turnId, state: "running" },
      } as unknown as OrchestrationThreadShell;

      yield* assertReadAndWriteDenied({
        shell,
        resolveAutomationAuthority: makeAutomationAuthorityResolver({
          automationRepository,
          projectionTurnRepository,
          projectionThreadMessageRepository,
        }),
      });
    }),
  );

  it.effect("keeps verified ordinary provider messages on provider fallback", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const automationRepository = yield* AutomationRepository;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread:ordinary-provider-origin");
      const projectId = ProjectId.makeUnsafe("project:ordinary-provider-origin");
      const turnId = TurnId.makeUnsafe("turn:ordinary-provider-origin");
      const messageId = MessageId.makeUnsafe("message:ordinary-provider-origin");
      const createdAt = new Date(Date.now() - 1_000).toISOString();
      yield* projectionTurnRepository.upsertByTurnId({
        threadId,
        turnId,
        pendingMessageId: messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId: null,
        state: "running",
        requestedAt: createdAt,
        startedAt: createdAt,
        completedAt: null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
      yield* projectionThreadMessageRepository.upsert({
        messageId,
        threadId,
        turnId,
        role: "user",
        text: "An ordinary provider request.",
        dispatchOrigin: "user",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: createdAt,
      });
      const shell = {
        id: threadId,
        projectId,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        session: { providerName: "codex", status: "running" },
        latestTurn: { turnId, state: "running" },
      } as unknown as OrchestrationThreadShell;
      const receipts: ScientOperationResultReceipt[] = [];
      const transport = deniedTransport({
        shell,
        receipts,
        resolveAutomationAuthority: makeAutomationAuthorityResolver({
          automationRepository,
          projectionTurnRepository,
          projectionThreadMessageRepository,
        }),
      });

      const response = yield* transport({
        authorizationHeader: "Bearer valid-token",
        body: {
          jsonrpc: "2.0",
          id: "ordinary-provider-read",
          method: "tools/call",
          params: { name: "scient_test_read", arguments: {} },
        },
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(receipts.length, 1);
      assert.strictEqual(
        receipts[0]?.authorityGeneration,
        "gateway-session:production-resolver-test",
      );
    }),
  );

  it.effect("keeps a due one-shot grant valid after scheduler disablement only", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const turnId = TurnId.makeUnsafe("turn:one-shot-policy");
      const runAt = new Date(Date.now() - 1_000).toISOString();
      const seeded = yield* seedActiveRun({
        key: "one-shot-policy",
        schedule: { type: "once", runAt },
        projectedTurnId: turnId,
        projectedPendingMessageId: MessageId.makeUnsafe("message:one-shot-policy:granted"),
      });
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
      const resolver = makeAutomationAuthorityResolver({
        automationRepository: seeded.automationRepository,
        projectionTurnRepository,
        projectionThreadMessageRepository,
      });

      yield* seeded.automationRepository.disableDefinition({
        id: seeded.definition.id,
        now: new Date().toISOString(),
      });
      const authority = yield* resolver({
        threadId: seeded.threadId,
        projectId: seeded.projectId,
        provider: "codex",
        turnId,
        now: Date.now(),
      });
      assert.strictEqual(authority?.actor.kind, "automation-run");

      const currentDefinition = yield* seeded.automationRepository.getDefinitionById({
        id: seeded.definition.id,
      });
      assert.isTrue(Option.isSome(currentDefinition));
      if (Option.isSome(currentDefinition)) {
        yield* seeded.automationRepository.saveDefinition({
          ...currentDefinition.value,
          prompt: "A genuinely changed task.",
          updatedAt: new Date(Date.now() + 1).toISOString(),
        });
      }
      const changed = yield* Effect.option(
        resolver({
          threadId: seeded.threadId,
          projectId: seeded.projectId,
          provider: "codex",
          turnId,
          now: Date.now(),
        }),
      );
      assert.isTrue(Option.isNone(changed));
    }),
  );
});
