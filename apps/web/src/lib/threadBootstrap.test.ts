import { ProjectId, type ModelSelection, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { type ComposerThreadDraftState, type DraftThreadState } from "../composerDraftStore";
import {
  buildDraftThreadWorkspacePatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  newThreadNavigationRequestKey,
  resolveNewThreadWorkspace,
  resolveNewThreadWorkspaceForEntryPoint,
  resolveTerminalThreadCreationState,
  resolveThreadBootstrapPlan,
  shouldReuseActiveDraftThread,
} from "./threadBootstrap";

const PROJECT_ID = ProjectId.makeUnsafe("project-bootstrap");
const THREAD_ID = ThreadId.makeUnsafe("thread-bootstrap");
const DEFAULT_NAVIGATION_TARGET = { projectId: PROJECT_ID, entryPoint: "chat" as const };
const FIRST_NAVIGATION_SEARCH = (previous: Record<string, unknown>) => ({
  ...previous,
  editor: "first",
});
const SECOND_NAVIGATION_SEARCH = (previous: Record<string, unknown>) => ({
  ...previous,
  editor: "second",
});
const FIRST_NAVIGATION_PREPARATION = async () => undefined;
const SECOND_NAVIGATION_PREPARATION = async () => undefined;

function modelSelection(
  provider: "codex" | "claudeAgent",
  model: string,
  options?: ModelSelection["options"],
): ModelSelection {
  return {
    provider,
    model,
    ...(options ? { options } : {}),
  } as ModelSelection;
}

function makeDraftThread(partial?: Partial<DraftThreadState>): DraftThreadState {
  return {
    projectId: PROJECT_ID,
    createdAt: "2026-04-05T10:00:00.000Z",
    runtimeMode: "approval-required",
    interactionMode: "default",
    entryPoint: "terminal",
    branch: "feature/terminal-bootstrap",
    worktreePath: "/repo/.worktrees/terminal-bootstrap",
    envMode: "worktree",
    workspaceOrigin: "default",
    ...partial,
  };
}

function makeComposerDraftState(
  partial?: Partial<ComposerThreadDraftState>,
): ComposerThreadDraftState {
  return {
    prompt: "",
    promptHistorySavedDraft: null,
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    queuedTurns: [],
    modelSelectionByProvider: {
      claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    },
    activeProvider: "claudeAgent",
    runtimeMode: null,
    interactionMode: null,
    ...partial,
  };
}

describe("threadBootstrap", () => {
  it("uses distinct navigation request keys for default and exact workspace intents", () => {
    const defaultKey = newThreadNavigationRequestKey(DEFAULT_NAVIGATION_TARGET);
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: { workspace: { kind: "project-default" } },
      }),
    ).toBe(defaultKey);
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: {
          workspace: {
            kind: "existing-worktree",
            branch: "feature/exact",
            worktreePath: "/repo/worktrees/exact",
          },
        },
      }),
    ).not.toBe(defaultKey);
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: { fresh: true },
      }),
    ).not.toBe(defaultKey);
  });

  it("does not coalesce distinct custom-search or preparation callbacks", () => {
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        customSearch: FIRST_NAVIGATION_SEARCH,
      }),
    ).toBe(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        customSearch: FIRST_NAVIGATION_SEARCH,
      }),
    );
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        customSearch: FIRST_NAVIGATION_SEARCH,
      }),
    ).not.toBe(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        customSearch: SECOND_NAVIGATION_SEARCH,
      }),
    );
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: { prepareNavigation: FIRST_NAVIGATION_PREPARATION },
      }),
    ).toBe(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: { prepareNavigation: FIRST_NAVIGATION_PREPARATION },
      }),
    );
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: { prepareNavigation: FIRST_NAVIGATION_PREPARATION },
      }),
    ).not.toBe(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: { prepareNavigation: SECOND_NAVIGATION_PREPARATION },
      }),
    );
    expect(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: {
          prepareNavigation: FIRST_NAVIGATION_PREPARATION,
          prepareNavigationKey: "sidebar-exact-workspace",
        },
      }),
    ).toBe(
      newThreadNavigationRequestKey({
        ...DEFAULT_NAVIGATION_TARGET,
        options: {
          prepareNavigation: SECOND_NAVIGATION_PREPARATION,
          prepareNavigationKey: "sidebar-exact-workspace",
        },
      }),
    );
  });

  it("keeps project and entry-point targets distinct on the global navigation surface", () => {
    const projectChat = newThreadNavigationRequestKey({
      projectId: "project-a",
      entryPoint: "chat",
    });
    expect(newThreadNavigationRequestKey({ projectId: "project-b", entryPoint: "chat" })).not.toBe(
      projectChat,
    );
    expect(
      newThreadNavigationRequestKey({ projectId: "project-a", entryPoint: "terminal" }),
    ).not.toBe(projectChat);
  });

  it("resolves project defaults and exact existing workspaces without partial states", () => {
    expect(resolveNewThreadWorkspace({ kind: "project-default" }, "worktree")).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      workspaceOrigin: "default",
    });
    expect(resolveNewThreadWorkspace({ kind: "local-container" }, "worktree")).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "local",
      workspaceOrigin: "intentional",
    });
    expect(
      resolveNewThreadWorkspace(
        {
          kind: "existing-worktree",
          branch: "feature/new-branch",
          worktreePath: "/repo/.worktrees/new-branch",
        },
        "local",
      ),
    ).toEqual({
      branch: "feature/new-branch",
      worktreePath: "/repo/.worktrees/new-branch",
      envMode: "worktree",
      workspaceOrigin: "intentional",
    });
    expect(
      resolveNewThreadWorkspace({ kind: "existing-local", branch: "feature/local" }, "worktree"),
    ).toEqual({
      branch: "feature/local",
      worktreePath: null,
      envMode: "local",
      workspaceOrigin: "intentional",
    });
  });

  it("uses an honest local workspace for immediate terminals without a materialized worktree", () => {
    expect(
      resolveNewThreadWorkspaceForEntryPoint({
        defaultEnvMode: "worktree",
        entryPoint: "terminal",
        intent: { kind: "project-default" },
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "local",
      workspaceOrigin: "default",
    });
    expect(
      resolveNewThreadWorkspaceForEntryPoint({
        defaultEnvMode: "local",
        entryPoint: "terminal",
        intent: { kind: "existing-worktree", branch: "stale", worktreePath: "" },
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "local",
      workspaceOrigin: "intentional",
    });
    expect(
      resolveNewThreadWorkspaceForEntryPoint({
        defaultEnvMode: "local",
        entryPoint: "terminal",
        intent: {
          kind: "existing-worktree",
          branch: "feature/exact",
          worktreePath: "/repo/.worktrees/exact",
        },
      }),
    ).toMatchObject({
      branch: "feature/exact",
      worktreePath: "/repo/.worktrees/exact",
      envMode: "worktree",
    });
  });

  it("recomputes inactive default drafts while preserving active and intentional workspaces", () => {
    expect(
      buildDraftThreadWorkspacePatch({
        defaultEnvMode: "local",
        draftThread: makeDraftThread(),
        entryPoint: "terminal",
        reuseKind: "stored",
      }),
    ).toEqual({
      branch: null,
      envMode: "local",
      worktreePath: null,
      entryPoint: "terminal",
      workspaceOrigin: "default",
    });
    expect(
      buildDraftThreadWorkspacePatch({
        defaultEnvMode: "local",
        draftThread: makeDraftThread(),
        entryPoint: "terminal",
        reuseKind: "route",
      }),
    ).toBeNull();
    expect(
      buildDraftThreadWorkspacePatch({
        defaultEnvMode: "local",
        draftThread: makeDraftThread({ workspaceOrigin: "intentional" }),
        entryPoint: "terminal",
        reuseKind: "stored",
      }),
    ).toBeNull();
    expect(
      buildDraftThreadWorkspacePatch({
        defaultEnvMode: "local",
        draftThread: makeDraftThread({ workspaceOrigin: "intentional" }),
        entryPoint: "terminal",
        options: { workspace: { kind: "project-default" } },
        reuseKind: "stored",
      }),
    ).toEqual({
      branch: null,
      envMode: "local",
      worktreePath: null,
      entryPoint: "terminal",
      workspaceOrigin: "default",
    });
  });

  it("recognizes when the active route draft can be reused", () => {
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread(),
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(true);
    expect(
      shouldReuseActiveDraftThread({
        draftThread: makeDraftThread({ entryPoint: "chat" }),
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toBe(false);
  });

  it("resolves bootstrap precedence as route draft, then stored draft, then fresh", () => {
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: ThreadId.makeUnsafe("stored-thread"), ...makeDraftThread() },
        latestActiveDraftThread: makeDraftThread({ branch: "feature/route-draft" }),
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: THREAD_ID,
      }),
    ).toMatchObject({ kind: "route", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: { threadId: THREAD_ID, ...makeDraftThread() },
        latestActiveDraftThread: null,
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: null,
      }),
    ).toMatchObject({ kind: "stored", threadId: THREAD_ID });
    expect(
      resolveThreadBootstrapPlan({
        storedDraftThread: null,
        latestActiveDraftThread: null,
        entryPoint: "terminal",
        projectId: PROJECT_ID,
        routeThreadId: null,
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("creates stable snapshots for active thread state", () => {
    expect(
      createActiveThreadSnapshot(
        {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        PROJECT_ID,
      ),
    ).toEqual({
      projectId: PROJECT_ID,
      modelSelection: modelSelection("codex", "gpt-5"),
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: undefined,
      lastKnownPr: null,
    });
    expect(createActiveDraftThreadSnapshot(makeDraftThread(), PROJECT_ID)).toEqual({
      ...makeDraftThread(),
      lastKnownPr: null,
    });
  });

  it("builds the fresh draft seed from creation inputs", () => {
    expect(
      createFreshDraftThreadSeed({
        createdAt: "2026-04-05T10:00:00.000Z",
        defaultEnvMode: "local",
        entryPoint: "terminal",
        options: {
          workspace: {
            kind: "existing-worktree",
            branch: "feature/new-terminal",
            worktreePath: "/repo/.worktrees/new-terminal",
          },
        },
      }),
    ).toEqual({
      createdAt: "2026-04-05T10:00:00.000Z",
      branch: "feature/new-terminal",
      worktreePath: "/repo/.worktrees/new-terminal",
      envMode: "worktree",
      workspaceOrigin: "intentional",
      runtimeMode: "full-access",
      entryPoint: "terminal",
    });
  });

  it("marks fresh draft seeds as temporary when requested", () => {
    expect(
      createFreshDraftThreadSeed({
        createdAt: "2026-04-05T10:00:00.000Z",
        defaultEnvMode: "worktree",
        entryPoint: "chat",
        options: {
          temporary: true,
        },
      }),
    ).toEqual({
      createdAt: "2026-04-05T10:00:00.000Z",
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      workspaceOrigin: "default",
      runtimeMode: "full-access",
      entryPoint: "chat",
      isTemporary: true,
    });
  });

  it("prefers draft state when resolving terminal creation payloads", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        defaultEnvMode: "local",
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread(),
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }),
    ).toEqual({
      modelSelection: modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "worktree",
      branch: "feature/terminal-bootstrap",
      worktreePath: "/repo/.worktrees/terminal-bootstrap",
      lastKnownPr: null,
    });
  });

  it("does not inherit plan mode from the previously active thread for a fresh creation", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "plan",
        },
        defaultEnvMode: "local",
        draftComposerState: makeComposerDraftState(),
        draftThread: null,
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }).interactionMode,
    ).toBe("default");
  });

  it("preserves explicit draft plan mode when resolving terminal creation payloads", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        defaultEnvMode: "local",
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread({ interactionMode: "plan" }),
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }).interactionMode,
    ).toBe("plan");
  });

  it("uses the configured default when no draft workspace exists", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: {
          projectId: PROJECT_ID,
          modelSelection: modelSelection("codex", "gpt-5"),
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "worktree",
        },
        defaultEnvMode: "local",
        draftComposerState: makeComposerDraftState(),
        draftThread: null,
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }),
    ).toMatchObject({
      envMode: "local",
      worktreePath: null,
      branch: null,
    });
  });

  it("fails terminal promotion safely to local when worktree metadata has no concrete path", () => {
    expect(
      resolveTerminalThreadCreationState({
        activeDraftThread: null,
        activeThread: null,
        defaultEnvMode: "worktree",
        draftComposerState: makeComposerDraftState(),
        draftThread: makeDraftThread({
          branch: "stale-branch",
          envMode: "worktree",
          worktreePath: null,
        }),
        projectDefaultModelSelection: modelSelection("codex", "gpt-5.4"),
        projectId: PROJECT_ID,
      }),
    ).toMatchObject({
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
  });
});
