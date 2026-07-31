import {
  AutomationId,
  AutomationRunId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type AutomationDefinition,
  type AutomationRun,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { ProjectionTurnById } from "../persistence/Services/ProjectionTurns.ts";
import {
  automationAllowedCapabilitiesForDefinition,
  makeAutomationOperationGrantSnapshot,
  resolveAutomationOperationAuthority,
  SCIENT_AUTOMATION_OPERATION_RUNTIME_EPOCH_HASH,
  ScientAutomationOperationAuthorityError,
} from "./automationAuthority.ts";

const NOW = "2026-07-31T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const AUTOMATION_ID = AutomationId.makeUnsafe("automation:a1");
const RUN_ID = AutomationRunId.makeUnsafe("automation-run:a1");
const PROJECT_ID = ProjectId.makeUnsafe("project:a1");
const THREAD_ID = ThreadId.makeUnsafe("thread:a1");
const MESSAGE_ID = MessageId.makeUnsafe("message:a1");
const TURN_ID = TurnId.makeUnsafe("turn:a1");

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: AUTOMATION_ID,
    projectId: PROJECT_ID,
    sourceThreadId: null,
    name: "A1 automation",
    prompt: "Inspect the project.",
    schedule: { type: "manual" },
    enabled: true,
    nextRunAt: null,
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    worktreeMode: "worktree",
    mode: "standalone",
    targetThreadId: null,
    maxIterations: null,
    stopOnError: true,
    completionPolicy: { type: "none" },
    completionPolicyVersion: 0,
    completionPolicyUpdatedAt: NOW,
    minimumIntervalSeconds: 60,
    maxRuntimeSeconds: 300,
    retryPolicy: { type: "none" },
    misfirePolicy: "coalesce",
    acknowledgedRisks: [],
    iterationCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function run(input?: {
  readonly definition?: AutomationDefinition;
  readonly allowedCapabilities?: AutomationRun["permissionSnapshot"]["allowedCapabilities"];
  readonly runtimeEpochHash?: string;
  readonly overrides?: Partial<AutomationRun>;
}): AutomationRun {
  const automation = input?.definition ?? definition();
  const allowedCapabilities =
    input?.allowedCapabilities ?? automationAllowedCapabilitiesForDefinition(automation);
  const operationGrant = makeAutomationOperationGrantSnapshot({
    definition: automation,
    runId: RUN_ID,
    threadId: THREAD_ID,
    pendingMessageId: MESSAGE_ID,
    allowedCapabilities,
    issuedAt: NOW,
    runtimeEpochHash: input?.runtimeEpochHash ?? SCIENT_AUTOMATION_OPERATION_RUNTIME_EPOCH_HASH,
  });
  return {
    id: RUN_ID,
    automationId: AUTOMATION_ID,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    turnId: null,
    trigger: { type: "manual" },
    status: "running",
    scheduledFor: NOW,
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    startedAt: NOW,
    finishedAt: null,
    threadCreateCommandId: null,
    turnStartCommandId: null,
    messageId: MESSAGE_ID,
    error: null,
    result: null,
    permissionSnapshot: {
      provider: "codex",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      completionPolicyVersion: 0,
      runtimeMode: "approval-required",
      interactionMode: "default",
      worktreeMode: "worktree",
      allowedCapabilities,
      operationGrant,
      createdAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...input?.overrides,
  };
}

function turn(overrides: Partial<ProjectionTurnById> = {}): ProjectionTurnById {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    pendingMessageId: MESSAGE_ID,
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: null,
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    checkpointTurnCount: null,
    checkpointRef: null,
    checkpointStatus: null,
    checkpointFiles: [],
    ...overrides,
  };
}

function resolve(input?: {
  readonly definition?: AutomationDefinition;
  readonly run?: AutomationRun;
  readonly turn?: ProjectionTurnById;
  readonly projectId?: string;
  readonly threadId?: ThreadId;
  readonly provider?: "codex" | "claudeAgent";
  readonly turnId?: TurnId;
  readonly now?: number;
  readonly runtimeEpochHash?: string;
}) {
  const automation = input?.definition ?? definition();
  return resolveAutomationOperationAuthority({
    definition: automation,
    run: input?.run ?? run({ definition: automation }),
    turn: input?.turn ?? turn(),
    caller: {
      projectId: input?.projectId ?? PROJECT_ID,
      threadId: input?.threadId ?? THREAD_ID,
      provider: input?.provider ?? "codex",
      turnId: input?.turnId ?? TURN_ID,
    },
    now: input?.now ?? NOW_MS + 1_000,
    runtimeEpochHash: input?.runtimeEpochHash ?? SCIENT_AUTOMATION_OPERATION_RUNTIME_EPOCH_HASH,
  });
}

describe("automation operation authority", () => {
  it("binds the narrow grant to the exact automation, project, thread, message, and turn", () => {
    const authority = resolve();

    expect(authority.actor).toEqual({
      kind: "automation-run",
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
      grantVersion: 1,
      automationVersion: run().permissionSnapshot.operationGrant?.automationVersion,
      threadId: THREAD_ID,
      pendingMessageId: MESSAGE_ID,
      authorizingTurnId: TURN_ID,
    });
    expect(authority.projectIds).toEqual([PROJECT_ID]);
    expect(authority.capabilities).toEqual([
      "project:context:read",
      "thread:drive",
      "thread:list",
      "thread:read",
    ]);
    expect(authority.capabilities).not.toContain("automation:run");
    expect(authority.capabilities.some((capability) => capability.startsWith("browser:"))).toBe(
      false,
    );
    expect(authority.capabilities.some((capability) => capability.includes("file"))).toBe(false);
    expect(authority.capabilities.some((capability) => capability.includes("scientific"))).toBe(
      false,
    );
    expect(authority.capabilities).not.toContain("export:run");
  });

  it("rejects a permission snapshot that no longer carries the definition policy", () => {
    const narrowedRun = run({ allowedCapabilities: [] });
    expect(() => resolve({ run: narrowedRun })).toThrow(ScientAutomationOperationAuthorityError);
  });

  it.each([
    ["cancelled run", () => resolve({ run: run({ overrides: { status: "cancelled" } }) })],
    [
      "replaced definition",
      () => {
        const original = definition();
        return resolve({
          definition: definition({ prompt: "Replacement prompt" }),
          run: run({ definition: original }),
        });
      },
    ],
    [
      "previous runtime",
      () =>
        resolve({
          run: run({ runtimeEpochHash: `sha256:${"a".repeat(64)}` }),
        }),
    ],
    ["expired lease", () => resolve({ now: NOW_MS + 301_000 })],
    ["wrong project", () => resolve({ projectId: ProjectId.makeUnsafe("project:other") })],
    ["wrong provider", () => resolve({ provider: "claudeAgent" })],
    [
      "changed permission snapshot",
      () =>
        resolve({
          run: run({
            overrides: {
              permissionSnapshot: { ...run().permissionSnapshot, runtimeMode: "full-access" },
            },
          }),
        }),
    ],
    ["replaced turn", () => resolve({ turnId: TurnId.makeUnsafe("turn:replacement") })],
    [
      "wrong pending message",
      () =>
        resolve({
          turn: turn({ pendingMessageId: MessageId.makeUnsafe("message:other") }),
        }),
    ],
  ])("fails closed for %s", (_name, attempt) => {
    expect(attempt).toThrow(ScientAutomationOperationAuthorityError);
  });

  it("is stable across provider-session replacement for the same exact provider turn", () => {
    const first = resolve();
    const replacementSession = resolve();
    expect(replacementSession).toEqual(first);
    expect(() => resolve({ turnId: TurnId.makeUnsafe("turn:replacement") })).toThrow(
      ScientAutomationOperationAuthorityError,
    );
  });
});
