import { terminalContextReference } from "../lib/composerContextRecords";
import { ensureInlineContextReferences } from "../lib/composerContextReferences";
import {
  boundAttachmentIds,
  planComposerTurn,
  snapshotComposerSend,
  withMessageContext,
  deriveAvailableRevertTurnCounts,
  deriveWorkspaceMutationId,
  presentThreadShellFromProjection,
} from "./ChatView.logic";
import { mergeDirectPreviewAnnotation } from "./ChatView.logic";
import { recallCheckoutIsRepo, rememberCheckoutIsRepo } from "./ChatView.logic";
import { ProviderDriverKind, type ServerProvider, type ModelSelection } from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type RightPanelSurface,
  pullRequestSurface,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";

import {
  CommandId,
  EnvironmentId,
  ComposerContextId,
  MessageId,
  NodeId,
  OrchestrationV2ProviderThread,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom, AsyncResult } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import type { Thread } from "../types";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";
import {
  getAntigravitySendBlockReason,
  restorePlanFollowUpComposer,
  resolveComposerProviderSelection,
  resolveDraftPromotionNavigationTarget,
  resolveForkTargetAfterAttempt,
  resolveThreadWorkspaceRoot,
  findRecordedWorktreeSetup,
  observeProactivePanelUserChoice,
  resolveWorktreeSetupProgress,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  threadKeysShareEnvironment,
  timelineHasEphemeralPreviewUrls,
  codexArtifactTemplatePromptToAppend,
  shouldRefocusComposerOnWindowFocus,
  shouldOpenProactivePullRequest,
  shouldRetargetThreadPullRequestPanel,
  shouldOpenProactiveTurnDiff,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  deriveLockedProvider,
  hasServerAcknowledgedLocalDispatch,
  resolveThreadMetadataUpdateForNextTurn,
  waitForRevertedMessage,
  prepareRevertedMessageAttachments,
} from "./ChatView.logic";
const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";
const helloWorldTemplate: CodexArtifactTemplate = {
  artifactKind: "document",
  displayName: "Hello World",
  skillDirectory: "/Users/test/.codex/skills/artifact-template-hello-world",
  skillName: "artifact-template-hello-world",
};
function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}
const completedTurn = {
  runId: RunId.make("turn-1"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};
const readySession = {
  status: "completed" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};
describe("resolveDraftPromotionNavigationTarget", () => {
  const serverThreadRef = {
    environmentId,
    threadId,
  };
  const preparingRun = {
    ...completedTurn,
    status: "preparing" as const,
    startedAt: null,
    completedAt: null,
  };
  it("stays on the draft until the server owns the send", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({
          latestRun: preparingRun,
        }),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread(),
        backgroundSubmissionPending: false,
      }),
    ).toBeNull();
  });
  it("promotes a persisted send while its worktree is still preparing", () => {
    const serverThread = makeThread({
      latestRun: preparingRun,
      latestUserMessageAt: now,
    });
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: false,
      }),
    ).toBe(serverThreadRef);
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: true,
      }),
    ).toBeNull();
  });
});
describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  const options: ModelSelection["options"] = [
    {
      id: "reasoningEffort",
      value: "high",
    },
    {
      id: "fastMode",
      value: true,
    },
  ];
  it.each([
    {
      label: "permuted options",
      current: {
        ...modelSelection,
        options,
      },
      next: {
        ...modelSelection,
        options: options.toReversed(),
      },
    },
    {
      label: "omitted to empty options",
      current: modelSelection,
      next: {
        ...modelSelection,
        options: [],
      },
    },
    {
      label: "empty to omitted options",
      current: {
        ...modelSelection,
        options: [],
      },
      next: modelSelection,
    },
  ])("does not write metadata for $label", ({ current, next }) => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: current,
        nextModelSelection: next,
        currentBranch: "feature/current",
      }),
    ).toBeNull();
  });
  it.each([
    {
      label: "provider instance",
      next: {
        ...modelSelection,
        instanceId: ProviderInstanceId.make("codex-other"),
        options,
      },
    },
    {
      label: "model",
      next: {
        ...modelSelection,
        model: "gpt-5.4-mini",
        options,
      },
    },
    {
      label: "string option value",
      next: {
        ...modelSelection,
        options: [
          {
            id: "reasoningEffort",
            value: "low",
          },
          options[1]!,
        ],
      },
    },
    {
      label: "boolean option value",
      next: {
        ...modelSelection,
        options: [
          options[0]!,
          {
            id: "fastMode",
            value: false,
          },
        ],
      },
    },
    {
      label: "option identity",
      next: {
        ...modelSelection,
        options: [
          options[0]!,
          {
            id: "otherMode",
            value: true,
          },
        ],
      },
    },
  ])("writes the exact selection when the $label changes", ({ next }) => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: {
          ...modelSelection,
          options,
        },
        nextModelSelection: next,
        currentBranch: "feature/current",
      }),
    ).toEqual({
      modelSelection: next,
    });
  });
  it("preserves checkout updates and worktree reset with equivalent model options", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: {
          ...modelSelection,
          options,
        },
        nextModelSelection: {
          ...modelSelection,
          options: options.toReversed(),
        },
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({
      branch: "feature/checkout",
      worktreePath: null,
    });
  });
  it("preserves simultaneous model and checkout updates", () => {
    const nextModelSelection = {
      ...modelSelection,
      model: "gpt-5.4-mini",
      options,
    };
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: {
          ...modelSelection,
          options,
        },
        nextModelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({
      modelSelection: nextModelSelection,
      branch: "feature/checkout",
      worktreePath: null,
    });
  });
});
describe("deriveComposerSendState", () => {
  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo [Terminal 1](t3-context://v1/terminal/ctx-expired) waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });
    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});
describe("resolveForkTargetAfterAttempt", () => {
  const attemptedTarget = {
    messageId: "message-1",
  };
  it("preserves the attempted target when the fork fails before acceptance", () => {
    expect(resolveForkTargetAfterAttempt(attemptedTarget, attemptedTarget, "not-accepted")).toBe(
      attemptedTarget,
    );
  });
  it("clears the attempted target once the fork is accepted", () => {
    expect(resolveForkTargetAfterAttempt(attemptedTarget, attemptedTarget, "accepted")).toBeNull();
  });
  it("does not clear a newer target when an older attempt completes", () => {
    const newerTarget = {
      messageId: "message-2",
    };
    expect(resolveForkTargetAfterAttempt(newerTarget, attemptedTarget, "accepted")).toBe(
      newerTarget,
    );
  });
});
describe("resolveThreadWorkspaceRoot", () => {
  it("prefers worktrees and project roots for project-backed threads", () => {
    expect(
      resolveThreadWorkspaceRoot({
        worktreePath: "/repo/worktree",
        projectCwd: "/repo",
      }),
    ).toBe("/repo/worktree");
  });
  it("has no workspace without a project or worktree", () => {
    expect(
      resolveThreadWorkspaceRoot({
        worktreePath: null,
        projectCwd: null,
      }),
    ).toBeUndefined();
  });
});
describe("hasServerAcknowledgedLocalDispatch", () => {
  it("acknowledges a settled newer background turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestRun: completedTurn,
        runtime: readySession,
      }),
      {
        submissionIntent: "background",
      },
    );
    const newerTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: newerTurn,
        runtime: {
          ...readySession,
          updatedAt: newerTurn.completedAt,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
  it("holds a first send while the thread shell still reports a preparing run", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const preparingRun = {
      ...completedTurn,
      status: "preparing" as const,
      startedAt: null,
      completedAt: null,
    };
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "disconnected",
        latestRun: preparingRun,
        runtime: {
          ...readySession,
          status: "preparing",
          activeRunId: preparingRun.runId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });
  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestRun: completedTurn,
        runtime: readySession,
      }),
    );
    const runningTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      status: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: RunId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: runningTurn.runId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
  it("acknowledges a steering message projected onto the current running run", () => {
    const runningRun = {
      ...completedTurn,
      status: "running" as const,
      completedAt: null,
    };
    const runningRuntime = {
      ...readySession,
      status: "running" as const,
      activeRunId: runningRun.runId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestRun: runningRun,
        runtime: runningRuntime,
      }),
      {
        latestUserMessageId: MessageId.make("message-before-steer"),
      },
    );
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningRun,
        latestUserMessageId: MessageId.make("message-steer"),
        runtime: runningRuntime,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});
describe("deriveCommittedServerUserMessageIds", () => {
  it("tracks only committed user turn items, not assistant rows or projection-only messages", () => {
    const turnStartId = MessageId.make("message-turn-start");
    const steerId = MessageId.make("message-steer");
    const assistantId = MessageId.make("message-assistant");
    const committedAt = DateTime.makeUnsafe("2026-06-26T17:50:15.180Z");
    const runId = RunId.make("run:thread:thread-1:ordinal:1");
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-turn-start"),
        item: {
          id: TurnItemId.make("turn-item:message-turn-start"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: turnStartId,
          inputIntent: "turn_start",
          text: "start",
          attachments: [],
        },
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-assistant"),
        item: {
          id: TurnItemId.make("turn-item:message-assistant"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          type: "assistant_message",
          messageId: assistantId,
          text: "working",
          streaming: false,
        },
      },
      {
        position: 2,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-steer"),
        item: {
          id: TurnItemId.make("turn-item:message-steer"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: steerId,
          inputIntent: "steer",
          text: "continue",
          attachments: [],
        },
      },
    ];
    expect(deriveCommittedServerUserMessageIds(visibleTurnItems)).toEqual(
      new Set([turnStartId, steerId]),
    );
  });
});
describe("proactive panels", () => {
  it("keeps a manual PR selection made after following a replacement while loading", () => {
    useRightPanelStore.setState({
      byThreadKey: {},
      userActionRevisionByThreadKey: {},
    });
    const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
    const panels = useRightPanelStore.getState();
    const oldPr = pullRequestSurface({
      projectId: "project-1",
      repository: "owner/repo",
      number: 1,
    });
    const replacement = pullRequestSurface({
      ...oldPr,
      number: 2,
    });
    const runId = RunId.make("turn-1");
    panels.openPullRequest(ref, oldPr);
    const loading = observeProactivePanelUserChoice(null, {
      threadKey: "env-1:thread-1",
      runningTurnId: runId,
      userActionRevision: panels.getUserActionRevision(ref),
    });
    expect(panels.openProactive(ref, replacement, loading.userActionRevision)).toBe(true);
    panels.activateSurface(ref, oldPr.id);
    const loaded = observeProactivePanelUserChoice(loading, {
      threadKey: loading.threadKey,
      runningTurnId: runId,
      userActionRevision: panels.getUserActionRevision(ref),
    });
    expect(panels.openProactive(ref, replacement, loaded.userActionRevision)).toBe(false);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual(
      oldPr,
    );
    expect(shouldOpenProactivePullRequest(loaded.targetKey, "owner/repo:2")).toBe(true);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: loaded.runningTurnId,
        runningTurnId: null,
        settledTurnId: runId,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(
      panels.openProactive(
        ref,
        {
          kind: "diff",
          turnId: runId,
        },
        loaded.userActionRevision,
      ),
    ).toBe(false);
  });
  it.each(["idle", "loading", "observed"] as const)(
    "captures a new run's choice once with initial state %s",
    (initialState) => {
      useRightPanelStore.setState({
        byThreadKey: {},
        userActionRevisionByThreadKey: {},
      });
      const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
      const panels = useRightPanelStore.getState();
      const firstRun = RunId.make("turn-1");
      const nextRun = RunId.make("turn-2");
      const initial = observeProactivePanelUserChoice(null, {
        threadKey: "env-1:thread-1",
        runningTurnId: initialState === "idle" ? null : firstRun,
        userActionRevision: panels.getUserActionRevision(ref),
      });
      panels.openFile(ref, "src/first.ts");
      const loadingNextTurn = observeProactivePanelUserChoice(
        {
          ...initial,
          ...(initialState === "observed"
            ? {
                runningTurnId: firstRun,
                targetKey: null,
              }
            : {}),
        },
        {
          threadKey: initial.threadKey,
          runningTurnId: nextRun,
          userActionRevision: panels.getUserActionRevision(ref),
        },
      );
      expect(
        panels.openProactive(
          ref,
          {
            kind: "diff",
            turnId: nextRun,
          },
          loadingNextTurn.userActionRevision,
        ),
      ).toBe(true);
      panels.openFile(ref, "src/second.ts");
      const loaded = observeProactivePanelUserChoice(loadingNextTurn, {
        threadKey: initial.threadKey,
        runningTurnId: nextRun,
        userActionRevision: panels.getUserActionRevision(ref),
      });
      expect(
        panels.openProactive(
          ref,
          {
            kind: "diff",
            turnId: nextRun,
          },
          loaded.userActionRevision,
        ),
      ).toBe(false);
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id,
      ).toBe("file:src/second.ts");
    },
  );
  it("follows a changed server PR link without replacing an unrelated open panel", () => {
    const previous = {
      projectId: ProjectId.make("project-1"),
      repository: "pingdotgg/t3code",
      number: 42,
      url: "https://github.com/pingdotgg/t3code/pull/42",
    };
    const current = {
      ...previous,
      number: 43,
      url: "https://github.com/pingdotgg/t3code/pull/43",
    };
    const surface = {
      id: "pull-request:previous",
      kind: "pull-request",
      projectId: previous.projectId,
      repository: "PingDotGG/T3Code",
      number: previous.number,
    } satisfies RightPanelSurface;
    expect(shouldRetargetThreadPullRequestPanel(previous, current, surface)).toBe(true);
    expect(shouldRetargetThreadPullRequestPanel(previous, previous, surface)).toBe(false);
    expect(shouldRetargetThreadPullRequestPanel(previous, null, surface)).toBe(false);
    expect(
      shouldRetargetThreadPullRequestPanel(previous, current, {
        ...surface,
        number: 99,
      }),
    ).toBe(false);
    expect(
      shouldRetargetThreadPullRequestPanel(previous, current, {
        ...surface,
        projectId: "another-project",
      }),
    ).toBe(false);
  });
});
describe("deriveLockedProvider", () => {
  const baselineAssistantMessageId = MessageId.make("fork-baseline-assistant");
  // The V2 shell's successor to the V1 `forkLineage` marker.
  const forkLineage = {
    rootThreadId: threadId,
    parentThreadId: ThreadId.make("origin-thread"),
    relationshipToParent: "fork" as const,
  };
  const forkBaselineRun = {
    ...completedTurn,
    assistantMessageId: baselineAssistantMessageId,
  };
  const lockedProviderFor = (overrides: Partial<Thread>) =>
    deriveLockedProvider({
      providers: [],
      thread: makeThread(overrides),
      selectedProvider: null,
      threadProvider: "codex",
    });
  it("leaves a pristine fork unlocked before its first provider turn", () => {
    expect(
      lockedProviderFor({
        lineage: forkLineage,
        latestRun: forkBaselineRun,
      }),
    ).toBeNull();
  });
  it("leaves an empty-baseline fork unlocked before its first provider turn", () => {
    // The fork inherited a transcript but no baseline run of its own, so it is
    // still provider-unbound even though it reads as started.
    expect(
      lockedProviderFor({
        lineage: forkLineage,
        latestRun: null,
        itemCount: 2,
      }),
    ).toBeNull();
  });
  it("keeps ordinary sessionless conversation history locked", () => {
    expect(
      lockedProviderFor({
        latestRun: completedTurn,
      }),
    ).toBe("codex");
  });
  it("locks a fork after its first provider session starts", () => {
    expect(
      lockedProviderFor({
        lineage: forkLineage,
        latestRun: forkBaselineRun,
        activeProviderThreadId: ProviderThreadId.make("provider-after-baseline"),
        runtime: {
          ...readySession,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
      }),
    ).toBe("claudeAgent");
  });
  it("fails closed when a sessionless fork has advanced beyond its baseline", () => {
    // Past the baseline the fork has bound its own provider thread, so the
    // provider is no longer selectable; it falls back to the thread's provider.
    expect(
      lockedProviderFor({
        lineage: forkLineage,
        latestRun: {
          ...completedTurn,
          assistantMessageId: MessageId.make("post-fork-assistant"),
        },
        activeProviderThreadId: ProviderThreadId.make("provider-after-baseline"),
      }),
    ).toBe("codex");
  });
});
describe("draft promotion during worktree setup", () => {
  const serverThreadRef = {
    environmentId,
    threadId,
  };
  it.each([null, "preparing", "starting"] as const)(
    "keeps the draft mounted until the server owns the send, with setup run %s",
    (status) => {
      const serverThread = makeThread({
        latestRun: status
          ? {
              ...completedTurn,
              status,
              startedAt: null,
              completedAt: null,
            }
          : null,
        latestUserMessageAt: null,
      });
      expect(
        resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending: false,
        }),
      ).toBeNull();
    },
  );
  it("promotes once the bootstrap persisted the user message, before any run", () => {
    const serverThread = makeThread({
      latestRun: null,
      latestUserMessageAt: now,
    });
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread,
        backgroundSubmissionPending: false,
      }),
    ).toEqual(serverThreadRef);
  });
  it("promotes when the provider starts the first run", () => {
    expect(
      resolveDraftPromotionNavigationTarget({
        serverThreadRef,
        serverThread: makeThread({
          latestRun: {
            ...completedTurn,
            status: "running" as const,
            completedAt: null,
          },
        }),
        backgroundSubmissionPending: false,
      }),
    ).toEqual(serverThreadRef);
  });
  it.each(["failed", "interrupted", "cancelled"] as const)(
    "promotes a startup that ends as %s before a run completes",
    (status) => {
      expect(
        resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread: makeThread({
            latestRun: {
              ...completedTurn,
              status,
              startedAt: null,
              completedAt: null,
            },
          }),
          backgroundSubmissionPending: false,
        }),
      ).toEqual(serverThreadRef);
    },
  );
});
describe("resolveThreadSwitchTimeline", () => {
  afterEach(() => {
    resetHeldThreadTimeline();
  });
  const held = {
    threadKey: "env-1:thread-a",
    entries: ["a1", "a2"],
  };
  it("paints a remembered destination instead of the last-viewed thread", () => {
    rememberReadyThreadTimeline(held);
    rememberReadyThreadTimeline({
      threadKey: "env-1:thread-b",
      entries: ["b1", "b2"],
    });
    expect(peekRememberedThreadTimeline<string[]>("env-1:thread-a")).toEqual(["a1", "a2"]);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual({
      entries: ["a1", "a2"],
      displayThreadKey: "env-1:thread-a",
    });
  });
  it("does not hold another environment's timeline across a jump", () => {
    rememberReadyThreadTimeline(held);
    expect(peekRememberedThreadTimeline<string[]>(held.threadKey)).toEqual(["a1", "a2"]);
    expect(threadKeysShareEnvironment("env-1:thread-a", "env-2:thread-b")).toBe(false);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-2:thread-b",
        nextEntries: [],
      }),
    ).toEqual({
      entries: [],
      displayThreadKey: "env-2:thread-b",
    });
  });
  it("does not remember a timeline that still has handoff blob previews", () => {
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "blob:handoff",
              },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "https://cdn.example/a.png",
              },
            ],
          },
        },
      ]),
    ).toBe(false);
  });
});
describe("resolveComposerProviderSelection", () => {
  const catalogModels: ServerProvider["models"] = [
    {
      slug: "gemini-pro",
      name: "Gemini Pro",
      isCustom: false,
      capabilities: null,
    },
  ];
  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: {
          status: "authenticated",
        },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }
  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: {
        instanceId,
        model: "default",
      },
      itemCount: 1,
    });
  }
  it.each([
    ["claudeAgent", "claude_work"],
    ["codex", "codex_work"],
    ["ollama", "local_models"],
  ])("keeps imported %s history selectable through its custom instance", (driver, instanceId) => {
    const importedEntry = entry(driver, instanceId);
    const entries = [entry(driver === "codex" ? "claudeAgent" : "codex"), importedEntry];
    const thread = importedThread(importedEntry.instanceId);
    const lockedProvider = deriveLockedProvider({
      thread,
      selectedProvider: entries[0]!.instanceId,
      threadProvider: thread.modelSelection.instanceId,
      providers: entries.map((entry) => entry.snapshot),
    });
    expect(thread.runtime).toBeNull();
    expect(lockedProvider).toBe(driver);
    expect(
      resolveComposerProviderSelection({
        entries,
        candidateInstanceIds: [thread.modelSelection.instanceId],
        lockedProvider,
        lockedInstanceId: thread.modelSelection.instanceId,
      }).selectedProviderEntry?.instanceId,
    ).toBe(importedEntry.instanceId);
  });
  it("keeps the session driver authoritative over instance and draft selections", () => {
    const selected = entry("claudeAgent", "claude_work");
    const sessionEntry = entry("ollama", "local_models");
    const thread = importedThread(selected.instanceId);
    expect(
      deriveLockedProvider({
        thread: {
          ...thread,
          runtime: {
            ...readySession,
            providerName: sessionEntry.driverKind,
            providerInstanceId: sessionEntry.instanceId,
          },
        },
        selectedProvider: selected.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: [selected.snapshot, sessionEntry.snapshot],
      }),
    ).toBe(sessionEntry.driverKind);
  });
  it.each(["missing", "disabled"] as const)(
    "does not move imported history to another driver when its instance is %s",
    (state) => {
      const imported = entry("claudeAgent", "claude_work", {
        enabled: false,
      });
      const other = entry("codex");
      const entries = state === "missing" ? [other] : [other, imported];
      const thread = importedThread(imported.instanceId);
      const lockedProvider = deriveLockedProvider({
        thread,
        selectedProvider: other.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: entries.map((entry) => entry.snapshot),
      });
      expect(lockedProvider).not.toBeNull();
      expect(
        resolveComposerProviderSelection({
          entries,
          candidateInstanceIds: [other.instanceId, imported.instanceId],
          lockedProvider,
          lockedInstanceId: imported.instanceId,
        }).selectedProviderEntry,
      ).toBeUndefined();
    },
  );
  it("keeps a signed-out selection instead of silently switching providers", () => {
    const signedOutEntry = entry("antigravity", "google_work", {
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      models: catalogModels,
    });
    const selection = resolveComposerProviderSelection({
      entries: [entry("codex"), signedOutEntry],
      candidateInstanceIds: [signedOutEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });
    expect(selection.selectedProviderEntry?.instanceId).toBe(signedOutEntry.instanceId);
    expect(
      getAntigravitySendBlockReason(selection.selectedProviderEntry?.snapshot, "gemini-pro"),
    ).toBe("Sign in to Antigravity in provider settings before sending.");
  });
  it("blocks a saved model that a ready catalog no longer lists", () => {
    const provider = entry("antigravity", "google_work", {
      status: "ready",
      models: catalogModels,
    }).snapshot;
    expect(getAntigravitySendBlockReason(provider, "saved-model-not-in-current-catalog")).toBe(
      "That Antigravity model is no longer available. Choose another model.",
    );
    expect(getAntigravitySendBlockReason(provider, "gemini-pro")).toBeNull();
  });
  it("allows a saved native model to retry after a provider error without changing it", () => {
    const provider = entry("antigravity", "google_work", {
      status: "error",
      models: catalogModels,
    }).snapshot;
    expect(
      getAntigravitySendBlockReason(provider, "saved-model-not-in-current-catalog"),
    ).toBeNull();
  });
  it("does not continue an existing Antigravity thread in another profile after deletion", () => {
    const missingInstanceId = ProviderInstanceId.make("google_work");
    const selection = resolveComposerProviderSelection({
      entries: [entry("antigravity")],
      candidateInstanceIds: [missingInstanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: missingInstanceId,
    });
    expect(selection.selectedProviderEntry).toBeUndefined();
    expect(selection.unavailableProviderInstanceId).toBe(missingInstanceId);
  });
  it("keeps the session's continuation group when another instance was selected", () => {
    const sessionEntry = entry("antigravity", "google_work", {
      enabled: false,
      continuation: {
        groupKey: "work-profile",
      },
    });
    const anotherEntry = entry("antigravity", "google_personal", {
      continuation: {
        groupKey: "personal-profile",
      },
    });
    const selection = resolveComposerProviderSelection({
      entries: [sessionEntry, anotherEntry],
      candidateInstanceIds: [anotherEntry.instanceId, sessionEntry.instanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: sessionEntry.instanceId,
    });
    expect(selection.selectedProviderEntry).toBeUndefined();
  });
});
describe("shouldRefocusComposerOnWindowFocus", () => {
  function element(
    tagName: string,
    options?: {
      editable?: boolean;
      role?: string;
      within?: string;
    },
  ) {
    return {
      tagName,
      isContentEditable: options?.editable ?? false,
      getAttribute: (name: string) => (name === "role" ? (options?.role ?? null) : null),
      closest: (selector: string) =>
        options?.within !== undefined && selector.includes(options.within) ? ({} as Element) : null,
    };
  }
  it.each(["FIGURE", "MATH-FIELD", "BUTTON"])(
    "preserves a focused %s inside an editor even when that object is not contenteditable",
    (tagName) => {
      expect(
        shouldRefocusComposerOnWindowFocus(
          element(tagName, {
            within: '[contenteditable="true"]',
          }),
        ),
      ).toBe(false);
    },
  );
});
describe("checkout Git memory", () => {
  it("does not confuse an environment id containing the separator with a path", () => {
    rememberCheckoutIsRepo(EnvironmentId.make("env"), "a:b", false);
    expect(recallCheckoutIsRepo(EnvironmentId.make("env:a"), "b")).toBeUndefined();
  });
});
describe("worktree setup visibility", () => {
  const stage = (
    id: "fetch" | "checkout" | "submodules" | "setup-script" | "agent",
    status: "done" | "running" | "failed" | "pending",
  ) => ({
    id,
    status,
    startedAt: now,
    endedAt: status === "running" || status === "pending" ? null : now,
    percent: null,
    detail: null,
    tail: [],
  });
  const base = {
    threadId,
    phase: "running" as const,
    startedAt: now,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [stage("checkout", "running"), stage("agent", "pending")],
    error: null,
    sequence: 1,
  };
  const settledDone = {
    ...base,
    phase: "done" as const,
    endedAt: now,
    stages: [stage("checkout", "done"), stage("setup-script", "done"), stage("agent", "done")],
  };
  it("uses streamed setup progress immediately without reverting to an older held snapshot", () => {
    const newest = {
      ...settledDone,
      sequence: 9,
    };
    const resolve = (latest: WorktreeSetupSnapshot | null, held: WorktreeSetupSnapshot | null) =>
      resolveWorktreeSetupProgress({
        threadId,
        localPreparing: false,
        runStatus: "running",
        latest,
        held,
      });
    expect(resolve(newest, base)).toEqual({
      snapshot: newest,
      isPreparingWorktree: false,
    });
    expect(resolve(base, newest)).toEqual({
      snapshot: newest,
      isPreparingWorktree: false,
    });
    const other = {
      ...base,
      threadId: ThreadId.make("another-thread"),
    };
    expect(resolve(other, other)).toEqual({
      snapshot: null,
      isPreparingWorktree: false,
    });
  });
  it("reads the settled snapshot back from the thread's activities", () => {
    const activities = [
      {
        kind: "setup-script.started",
        payload: {},
      },
      {
        kind: "worktree-setup",
        payload: settledDone,
      },
      {
        kind: "worktree-setup",
        payload: {
          not: "a snapshot",
        },
      },
    ];
    expect(findRecordedWorktreeSetup(activities, threadId)).toEqual(settledDone);
    expect(findRecordedWorktreeSetup(activities, ThreadId.make("other"))).toBeNull();
  });
});
describe("waitForRevertedMessage", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("t"),
  };
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");
  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const projection = {
      ...base,
      thread: {
        ...base.thread,
        activeProviderThreadId: providerThreadId,
      },
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          providerInstanceId: base.thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("provider-session"),
          appThreadId: base.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 4,
          handoffIds: [],
          forkedFrom: null,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
      runs: [1, 2, 3, 4].map((ordinal) => ({
        id: RunId.make(`run-${ordinal}`),
        threadId: base.thread.id,
        ordinal,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: base.updatedAt,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({
      data: Option.some(projection),
    });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return {
      state,
      projection,
    };
  }
  afterEach(() => vi.restoreAllMocks());
  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: {
            requestId,
            message: "The provider could not roll back.",
          },
        },
      }),
    });
    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });
  it.each([
    ["same", "streamed"],
    ["replacement", "streamed"],
    ["replacement", "refetched"],
  ] as const)(
    "waits for the retained rollback suffix when the edited message and run are paged out (%s provider, %s)",
    async (providerIdentity, projectionSource) => {
      vi.useFakeTimers();
      const { state, projection } = projectionAtom();
      const latestRunId = RunId.make("latest-run-9");
      const latestRun = {
        ...projection.runs[3]!,
        id: latestRunId,
        ordinal: 9,
        userMessageId: MessageId.make("latest-message-9"),
        status: "cancelled" as const,
      };
      const bounded = {
        ...projection,
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 9,
        })),
        runs: [
          {
            ...latestRun,
            id: RunId.make("old-rewound-run-3"),
            userMessageId: MessageId.make("old-rewound-message-3"),
            ordinal: 3,
            status: "rolled_back" as const,
          },
          latestRun,
        ],
      };
      const oldProviderThread = bounded.providerThreads[0]!;
      const completedProviderThread = {
        ...oldProviderThread,
        ...(providerIdentity === "replacement"
          ? {
              id: ProviderThreadId.make("replacement-provider-thread"),
              firstRunOrdinal: null,
            }
          : {}),
        lastRunOrdinal: null,
      };
      appAtomRegistry.set(state, {
        data: Option.some(bounded),
      });
      let outcome = "pending";
      const waiting = waitForRevertedMessage(threadRef, 0, requestId, async () => {}).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");
        appAtomRegistry.set(state, {
          data: Option.some({
            ...bounded,
            thread: {
              ...bounded.thread,
              activeProviderThreadId:
                projectionSource === "refetched"
                  ? completedProviderThread.id
                  : oldProviderThread.id,
            },
            providerThreads:
              providerIdentity === "replacement"
                ? [oldProviderThread, completedProviderThread]
                : [completedProviderThread],
            runs: bounded.runs.map((run) =>
              run.id === latestRunId
                ? {
                    ...run,
                    status: "rolled_back" as const,
                  }
                : run,
            ),
          }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );
  it("waits for the requested target when another client finishes a shallower rewind", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {}).then(
      () => {
        outcome = "reverted";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      // Our command is accepted while the earlier target-3 effect is still running.
      const shallowerRewind = {
        ...projection,
        thread: {
          ...projection.thread,
          rollbackRequestId: requestId,
          rollbackFailure: null,
        },
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 3,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 3
            ? {
                ...run,
                status: "rolled_back" as const,
              }
            : run,
        ),
      };
      appAtomRegistry.set(state, {
        data: Option.some(shallowerRewind),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");
      appAtomRegistry.set(state, {
        data: Option.some({
          ...shallowerRewind,
          providerThreads: shallowerRewind.providerThreads.map((thread) => ({
            ...thread,
            lastRunOrdinal: 1,
          })),
          runs: shallowerRewind.runs.map((run) =>
            run.ordinal > 1
              ? {
                  ...run,
                  status: "rolled_back" as const,
                }
              : run,
          ),
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("reverted");
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it("rejects a stale edit already rewound by another client during attachment preparation", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackRequestId: CommandId.make("other-client-rewind"),
        },
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 1,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 1
            ? {
                ...run,
                status: "rolled_back" as const,
              }
            : run,
        ),
      }),
    });
    const revert = vi.fn(async () => {});
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, revert).then(
      () => {
        outcome = "reverted";
      },
      () => {
        outcome = "rejected";
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("rejected");
      expect(revert).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
describe("artifact template composer insertion", () => {
  it("does not insert an already-present prompt", () => {
    const prompt = "Create a document using this $artifact-template-hello-world about\u2026";
    expect(codexArtifactTemplatePromptToAppend(prompt, helloWorldTemplate)).toBeNull();
  });
});
describe("restorePlanFollowUpComposer", () => {
  it("writes back every field a cleared plan follow-up composer held", () => {
    const snapshot = {
      prompt: "Follow up on the plan",
      terminalContexts: [
        {
          id: "terminal-1",
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-09-11T00:00:00.000Z",
          terminalId: "main",
          terminalLabel: "Main",
          lineStart: 1,
          lineEnd: 2,
          text: "output",
        },
      ],
      reviewComments: [
        {
          id: "review-1",
          sectionId: "file:a.ts",
          sectionTitle: "File comment",
          filePath: "a.ts",
          startIndex: 0,
          endIndex: 0,
          rangeLabel: "L1",
          text: "look here",
          diff: "",
        },
      ],
      previewAnnotations: [],
      threadContexts: [
        {
          version: 1 as const,
          contextId: ComposerContextId.make("context-1"),
          label: "Related thread",
          kind: "thread" as const,
          environmentId,
          threadId: ThreadId.make("thread-2"),
          title: "Related thread",
        },
      ],
    };
    const writePrompt = vi.fn();
    const writeTerminalContexts = vi.fn();
    const writeReviewComments = vi.fn();
    const writePreviewAnnotations = vi.fn();
    const writeThreadContexts = vi.fn();
    const resetCursor = vi.fn();
    restorePlanFollowUpComposer({
      snapshot,
      writePrompt,
      writeTerminalContexts,
      writeReviewComments,
      writePreviewAnnotations,
      writeThreadContexts,
      resetCursor,
    });
    expect(writePrompt).toHaveBeenCalledTimes(1);
    expect(writePrompt).toHaveBeenCalledWith("Follow up on the plan");
    expect(writeTerminalContexts).toHaveBeenCalledTimes(1);
    expect(writeTerminalContexts).toHaveBeenCalledWith(snapshot.terminalContexts);
    expect(writeReviewComments).toHaveBeenCalledTimes(1);
    expect(writeReviewComments).toHaveBeenCalledWith(snapshot.reviewComments);
    expect(writePreviewAnnotations).toHaveBeenCalledTimes(1);
    expect(writePreviewAnnotations).toHaveBeenCalledWith(snapshot.previewAnnotations);
    expect(writeThreadContexts).toHaveBeenCalledTimes(1);
    expect(writeThreadContexts).toHaveBeenCalledWith(snapshot.threadContexts);
    expect(resetCursor).toHaveBeenCalledTimes(1);
    expect(resetCursor).toHaveBeenCalledWith({
      cursor: expect.any(Number),
      prompt: "Follow up on the plan",
      detectTrigger: true,
    });
  });
});
describe("prepareRevertedMessageAttachments", () => {
  it("copies attachment bytes before rewind into a fresh file", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("original bytes"));
    vi.stubGlobal("fetch", fetchMock);
    const files = await prepareRevertedMessageAttachments({
      message: {
        id: MessageId.make("rewound-message"),
        runId: RunId.make("rewound-run"),
        role: "user",
        text: "edit this question",
        streaming: false,
        createdAt: now,
        updatedAt: now,
        attachments: [
          {
            type: "file",
            id: "old-attachment",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 14,
          },
        ],
      },
      environmentId,
      httpBaseUrl: "https://server.test",
      createAssetUrl: async () =>
        AsyncResult.success({
          relativeUrl: "/asset/signed",
          expiresAt: 8_640_000_000_000_000,
        }),
    });
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0]?.name).toBe("notes.txt");
    expect(await files[0]?.text()).toBe("original bytes");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://server.test/asset/signed");
  });
});
describe("mergeDirectPreviewAnnotation", () => {
  const annotation = (id: string) =>
    ({
      id,
      pageUrl: "http://localhost:5173/",
      pageTitle: null,
      comment: "tighten this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: {
        dataUrl: "data:image/png;base64,AAAA",
        width: 10,
        height: 10,
        cropRect: {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      },
      createdAt: "2026-10-16T00:00:00.000Z",
    }) as const;
  const image = (id: string) =>
    ({
      id,
      type: "image",
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 1,
    }) as never;
  it("drops the screenshot claim when the attachment cap is full", () => {
    const result = mergeDirectPreviewAnnotation({
      images: [],
      fileCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      previewAnnotations: [],
      direct: {
        annotation: annotation("a"),
        image: image("crop"),
      },
    });
    expect(result.images).toEqual([]);
    expect(result.previewAnnotations[0]?.screenshot).toBeNull();
  });
});

describe("snapshotComposerSend", () => {
  const expired = {
    id: "ctx-expired",
    threadId,
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 4,
    lineEnd: 4,
    text: "",
    createdAt: now,
  };
  const live = {
    ...expired,
    id: "ctx-live",
    text: "pnpm test",
    lineStart: 9,
    lineEnd: 9,
  };
  it("drops expired terminal contexts from the contexts and from the prompt", () => {
    const snapshot = snapshotComposerSend({
      prompt: ensureInlineContextReferences("run", [
        terminalContextReference(expired),
        terminalContextReference(live),
      ]),
      images: [],
      files: [],
      terminalContexts: [expired, live],
      sendableTerminalContexts: [live],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
    });
    expect(snapshot.terminalContexts).toEqual([live]);
    expect(snapshot.messageText).toBe(
      ensureInlineContextReferences("run", [terminalContextReference(live)]).trim(),
    );
  });
});

describe("planComposerTurn", () => {
  const base = {
    messageText: "hello",
    sendQueuesBehindSetup: false,
    isServerThread: false,
    activeMessageCount: 0,
    sendEnvMode: "worktree" as const,
    worktreePath: null,
    activeThreadBranch: "main",
    resumeCompactionTokens: null,
    keepFullHistory: false,
    phase: "ready" as const,
    dispatchMode: "auto" as const,
  };
  it("prepares a worktree from the selected branch on a new thread", () => {
    expect(planComposerTurn(base)).toMatchObject({
      missingWorktreeBaseBranch: false,
      baseBranchForWorktree: "main",
      shouldQueueBehindActiveRun: false,
    });
  });
  it("refuses a new worktree without a base branch", () => {
    expect(
      planComposerTurn({
        ...base,
        activeThreadBranch: null,
      }),
    ).toMatchObject({
      missingWorktreeBaseBranch: true,
      baseBranchForWorktree: null,
    });
  });
  it("queues behind a compaction of a stale session, except for /compact itself", () => {
    const stale = { ...base, resumeCompactionTokens: 120_000 };
    for (const messageText of ["hello", "/compactfoo"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: true,
        turnDispatchMode: "queue",
        shouldQueueBehindActiveRun: true,
      });
    }
    for (const messageText of ["/COMPACT", "/compact keep the API notes", "/compact\n  tests"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: false,
        turnDispatchMode: "auto",
        shouldQueueBehindActiveRun: false,
      });
    }
  });
  it("queues behind a running turn only when asked to", () => {
    const running = {
      ...base,
      isServerThread: true,
      activeMessageCount: 3,
      phase: "running" as const,
    };
    expect(
      planComposerTurn({
        ...running,
        dispatchMode: "queue",
      }).shouldQueueBehindActiveRun,
    ).toBe(true);
    expect(
      planComposerTurn({
        ...running,
        dispatchMode: "steer",
      }),
    ).toMatchObject({
      shouldQueueBehindActiveRun: false,
      baseBranchForWorktree: null,
    });
  });
});

describe("withMessageContext", () => {
  const context = {
    records: [],
  } as unknown as NonNullable<Parameters<typeof withMessageContext>[0]["context"]>;
  it("sends the context inline when the server supports it", () => {
    expect(
      withMessageContext({
        text: "hi",
        context,
        supportsInlineMessageContext: true,
      }),
    ).toEqual({
      text: "hi",
      context,
    });
  });
  it("folds the context into the text for older servers", () => {
    const result = withMessageContext({
      text: "hi",
      context,
      supportsInlineMessageContext: false,
    });
    expect(result.context).toBeUndefined();
    expect(result.text).toContain("hi");
  });
  it("sends the text alone without context", () => {
    expect(
      withMessageContext({
        text: "hi",
        context: undefined,
        supportsInlineMessageContext: false,
      }),
    ).toEqual({
      text: "hi",
    });
  });
});

describe("boundAttachmentIds", () => {
  it("prefers the uploaded id and falls back to the local one", () => {
    expect(
      boundAttachmentIds(
        [
          {
            id: "upload-1",
          },
          {},
        ],
        [
          {
            id: "local-1",
          },
          {
            id: "local-2",
          },
        ],
      ),
    ).toEqual(["upload-1", "local-2"]);
  });
});

describe("presentThreadShellFromProjection", () => {
  it("keeps canonical chronological provider history and the active goal for direct links", () => {
    const base = makeThreadProjectionFixture();
    const root = (id: string, instanceId: string, createdAt: string) =>
      OrchestrationV2ProviderThread.make({
        id: ProviderThreadId.make(id),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make(instanceId),
        providerSessionId: null,
        appThreadId: base.thread.id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: DateTime.makeUnsafe(createdAt),
        updatedAt: base.updatedAt,
      });
    const latest = {
      ...root("latest", "latest-instance", "2026-01-03T00:00:00Z"),
      goal: { objective: "Finish the report", status: "active" as const },
    };
    const providerThreads = [
      latest,
      root("b", "same-time-instance", "2026-01-01T00:00:00Z"),
      root("a", "first-instance", "2026-01-01T00:00:00Z"),
      root("repeat", "first-instance", "2026-01-02T00:00:00Z"),
      {
        ...root("child", "child-instance", "2025-12-31T00:00:00Z"),
        ownerNodeId: NodeId.make("child-node"),
      },
      {
        ...root("foreign", "foreign-instance", "2025-12-31T00:00:00Z"),
        appThreadId: ThreadId.make("another-thread"),
      },
    ];
    const originalOrder = providerThreads.map((thread) => thread.id);
    const projection = {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: latest.id },
      providerThreads,
    };
    const live = { updatedAt: base.updatedAt, lastVisitedAt: null };
    const shell = presentThreadShellFromProjection(environmentId, base.thread.id, projection, live);
    expect(shell.providerInstanceHistory).toEqual([
      "first-instance",
      "same-time-instance",
      "latest-instance",
    ]);
    expect(shell.goal).toBe(latest.goal);
    expect(providerThreads.map((thread) => thread.id)).toEqual(originalOrder);
    expect(
      presentThreadShellFromProjection(
        environmentId,
        base.thread.id,
        { ...projection, thread: { ...projection.thread, activeProviderThreadId: null } },
        live,
      ).goal,
    ).toBeNull();
  });
});

describe("deriveAvailableRevertTurnCounts", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const otherProviderThreadId = ProviderThreadId.make("other-provider-thread");

  function projection(input: { readonly providerSessionId: ProviderSessionId | null }) {
    const base = makeThreadProjectionFixture();
    const run = (ordinal: number) => ({
      id: RunId.make(`run-${ordinal}`),
      ordinal,
      activeAttemptId: `attempt-${ordinal}`,
    });
    const turn = (ordinal: number, attempt: number, threadId: ProviderThreadId) => ({
      id: `turn-${attempt}-${ordinal}`,
      runAttemptId: `attempt-${attempt}`,
      ordinal,
      providerThreadId: threadId,
    });
    return {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          providerInstanceId: base.thread.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
        },
      ],
      runs: [run(1), run(2), run(3)],
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, providerTurnId: null })),
      // Run 2's latest turn moved to another provider thread, so its checkpoint cannot restore
      // this conversation.
      providerTurns: [
        turn(1, 1, providerThreadId),
        turn(1, 2, providerThreadId),
        turn(2, 2, otherProviderThreadId),
        turn(1, 3, providerThreadId),
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
  }

  it("offers the thread start and runs whose latest turn is on the active provider thread", () => {
    const available = deriveAvailableRevertTurnCounts(
      projection({ providerSessionId: ProviderSessionId.make("session") }),
    );
    expect([...available].toSorted()).toEqual([0, 1, 3]);
  });

  it("offers nothing without a provider session to rewind", () => {
    expect(deriveAvailableRevertTurnCounts(projection({ providerSessionId: null })).size).toBe(0);
    expect(deriveAvailableRevertTurnCounts(null).size).toBe(0);
  });
});

describe("deriveWorkspaceMutationId", () => {
  const item = (id: string, type: string, status: string) =>
    ({
      item: { id: TurnItemId.make(id), type, status },
    }) as unknown as OrchestrationV2ProjectedTurnItem;

  it("keys on the latest finished command or file change and the latest checkpoint", () => {
    expect(
      deriveWorkspaceMutationId(
        [
          item("edit", "file_change", "completed"),
          item("reply", "assistant_message", "completed"),
          item("command", "command_execution", "running"),
        ],
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(JSON.stringify(["edit", "2026-01-01T00:00:00.000Z"]));
  });

  it("is null before anything could have touched the workspace", () => {
    expect(deriveWorkspaceMutationId([item("reply", "assistant_message", "completed")], null)).toBe(
      null,
    );
  });
});
