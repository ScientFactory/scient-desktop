// FILE: threadBootstrap.ts
// Purpose: Pure helpers for draft reuse and terminal-thread promotion payloads.
// Layer: Web bootstrap/domain helpers
// Exports: draft patching, reuse checks, and terminal creation state resolution.

import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type OrchestrationThreadPullRequest,
  type ProjectId,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ThreadEnvironmentMode,
  type ThreadId,
} from "@synara/contracts";
import {
  type ComposerThreadDraftState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type DraftThreadWorkspaceOrigin,
  resolvePreferredComposerModelSelection,
} from "../composerDraftStore";
import { DEFAULT_INTERACTION_MODE, type ThreadPrimarySurface } from "../types";

export interface NewThreadOptions {
  workspace?: NewThreadWorkspaceIntent;
  entryPoint?: ThreadPrimarySurface;
  temporary?: boolean;
  provider?: ProviderKind;
  fresh?: boolean;
  /** Runs after this fresh request owns its project navigation slot and before draft staging. */
  prepareFreshCreate?: () => Promise<void>;
}

export type NewThreadWorkspaceIntent =
  | { readonly kind: "project-default" }
  | { readonly kind: "local-container" }
  | { readonly kind: "existing-local"; readonly branch: string }
  | {
      readonly kind: "existing-worktree";
      readonly branch: string;
      readonly worktreePath: string;
    };

export interface ResolvedNewThreadWorkspace {
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  workspaceOrigin: DraftThreadWorkspaceOrigin;
}

export function newThreadNavigationRequestKey(input: {
  readonly hasCustomSearch: boolean;
  readonly options?: NewThreadOptions | undefined;
}): string {
  const workspace = input.options?.workspace ?? { kind: "project-default" as const };
  const branch = "branch" in workspace ? workspace.branch : "";
  const worktreePath = "worktreePath" in workspace ? workspace.worktreePath : "";
  return [
    workspace.kind,
    branch,
    worktreePath,
    input.options?.provider ?? "",
    input.options?.temporary === true ? "temporary" : "durable",
    input.hasCustomSearch ? "custom-search" : "default-search",
  ].join("\u0000");
}

export function resolveNewThreadWorkspace(
  intent: NewThreadWorkspaceIntent,
  defaultEnvMode: DraftThreadEnvMode,
): ResolvedNewThreadWorkspace {
  switch (intent.kind) {
    case "project-default":
      return {
        branch: null,
        worktreePath: null,
        envMode: defaultEnvMode,
        workspaceOrigin: "default",
      };
    case "local-container":
      return {
        branch: null,
        worktreePath: null,
        envMode: "local",
        workspaceOrigin: "intentional",
      };
    case "existing-local":
      return {
        branch: intent.branch,
        worktreePath: null,
        envMode: "local",
        workspaceOrigin: "intentional",
      };
    case "existing-worktree":
      return {
        branch: intent.branch,
        worktreePath: intent.worktreePath,
        envMode: "worktree",
        workspaceOrigin: "intentional",
      };
  }
}

interface ActiveThreadSnapshot {
  projectId: ProjectId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode?: ThreadEnvironmentMode | undefined;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
}

export interface DraftReusePlanStored {
  draftThread: DraftThreadState;
  kind: "stored";
  threadId: ThreadId;
}

export interface DraftReusePlanRoute {
  draftThread: DraftThreadState;
  kind: "route";
  threadId: ThreadId;
}

export interface DraftReusePlanFresh {
  kind: "fresh";
}

export type ThreadBootstrapPlan = DraftReusePlanStored | DraftReusePlanRoute | DraftReusePlanFresh;

interface ResolveTerminalThreadCreationStateInput {
  activeDraftThread: DraftThreadState | null;
  activeThread: ActiveThreadSnapshot | null;
  defaultEnvMode: DraftThreadEnvMode;
  defaultProvider?: ProviderKind | null | undefined;
  draftComposerState: ComposerThreadDraftState | null;
  draftThread: DraftThreadState | null;
  projectDefaultModelSelection: ModelSelection | null;
  projectId: ProjectId;
}

export interface TerminalThreadCreationState {
  branch: string | null;
  envMode: DraftThreadEnvMode;
  interactionMode: ProviderInteractionMode;
  lastKnownPr: OrchestrationThreadPullRequest | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  worktreePath: string | null;
}

// Normalize the currently active server thread into a stable snapshot for pure helpers.
export function createActiveThreadSnapshot(
  activeThread:
    | {
        interactionMode: ProviderInteractionMode;
        modelSelection: ModelSelection;
        projectId: ProjectId;
        runtimeMode: RuntimeMode;
        envMode?: ThreadEnvironmentMode | undefined;
        lastKnownPr?: OrchestrationThreadPullRequest | null;
      }
    | null
    | undefined,
  projectId: ProjectId,
): ActiveThreadSnapshot | null {
  if (!activeThread || activeThread.projectId !== projectId) {
    return null;
  }
  return {
    projectId: activeThread.projectId,
    modelSelection: activeThread.modelSelection,
    runtimeMode: activeThread.runtimeMode,
    interactionMode: activeThread.interactionMode,
    envMode: activeThread.envMode,
    lastKnownPr: activeThread.lastKnownPr ?? null,
  };
}

// Normalize the currently active draft thread into a stable snapshot for pure helpers.
export function createActiveDraftThreadSnapshot(
  activeDraftThread: DraftThreadState | null | undefined,
  projectId: ProjectId,
): DraftThreadState | null {
  if (!activeDraftThread || activeDraftThread.projectId !== projectId) {
    return null;
  }
  return {
    projectId: activeDraftThread.projectId,
    createdAt: activeDraftThread.createdAt,
    runtimeMode: activeDraftThread.runtimeMode,
    interactionMode: activeDraftThread.interactionMode,
    entryPoint: activeDraftThread.entryPoint,
    branch: activeDraftThread.branch,
    worktreePath: activeDraftThread.worktreePath,
    lastKnownPr: activeDraftThread.lastKnownPr ?? null,
    envMode: activeDraftThread.envMode,
    ...(activeDraftThread.isTemporary ? { isTemporary: true } : {}),
    workspaceOrigin: activeDraftThread.workspaceOrigin,
  };
}

// Decide whether we should reuse a stored draft, the current route draft, or create a fresh one.
export function resolveThreadBootstrapPlan(input: {
  entryPoint: ThreadPrimarySurface;
  latestActiveDraftThread: DraftThreadState | null;
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
  storedDraftThread: ({ threadId: ThreadId } & DraftThreadState) | null;
}): ThreadBootstrapPlan {
  if (
    shouldReuseActiveDraftThread({
      draftThread: input.latestActiveDraftThread,
      entryPoint: input.entryPoint,
      projectId: input.projectId,
      routeThreadId: input.routeThreadId,
    })
  ) {
    return {
      kind: "route",
      threadId: input.routeThreadId!,
      draftThread: input.latestActiveDraftThread!,
    };
  }
  if (input.storedDraftThread) {
    return {
      kind: "stored",
      threadId: input.storedDraftThread.threadId,
      draftThread: input.storedDraftThread,
    };
  }
  return { kind: "fresh" };
}

// Build the initial draft-thread metadata for a brand new thread bootstrap.
export function createFreshDraftThreadSeed(input: {
  createdAt: string;
  defaultEnvMode: DraftThreadEnvMode;
  entryPoint: ThreadPrimarySurface;
  options?: NewThreadOptions | undefined;
}): Omit<DraftThreadState, "projectId" | "interactionMode"> {
  const workspace = resolveNewThreadWorkspace(
    input.options?.workspace ?? { kind: "project-default" },
    input.defaultEnvMode,
  );
  return {
    createdAt: input.createdAt,
    ...workspace,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    entryPoint: input.entryPoint,
    ...(input.options?.temporary ? { isTemporary: true } : {}),
  };
}

// Reopening an inactive default-derived draft recomputes the current project default so
// stale inherited branches cannot return. An active route draft and an intentionally chosen
// workspace are preserved unless a caller explicitly supplies a new workspace intent.
export function buildDraftThreadWorkspacePatch(input: {
  defaultEnvMode: DraftThreadEnvMode;
  draftThread: DraftThreadState;
  entryPoint: ThreadPrimarySurface;
  options?: NewThreadOptions | undefined;
  reuseKind: "route" | "stored";
}): {
  branch: string | null;
  entryPoint: ThreadPrimarySurface;
  envMode: DraftThreadEnvMode;
  workspaceOrigin: DraftThreadWorkspaceOrigin;
  worktreePath: string | null;
} | null {
  const workspaceWasSpecified =
    input.options !== undefined && Object.hasOwn(input.options, "workspace");
  if (input.reuseKind === "route" && !workspaceWasSpecified) {
    return null;
  }
  if (
    input.reuseKind === "stored" &&
    !workspaceWasSpecified &&
    input.draftThread.workspaceOrigin === "intentional"
  ) {
    return null;
  }
  return {
    ...resolveNewThreadWorkspace(
      input.options?.workspace ?? { kind: "project-default" },
      input.defaultEnvMode,
    ),
    entryPoint: input.entryPoint,
  };
}

// Reuse only when the active route draft already belongs to the target project and surface.
export function shouldReuseActiveDraftThread(input: {
  draftThread: DraftThreadState | null;
  entryPoint: ThreadPrimarySurface;
  projectId: ProjectId;
  routeThreadId: ThreadId | null;
}): input is {
  draftThread: DraftThreadState;
  entryPoint: ThreadPrimarySurface;
  projectId: ProjectId;
  routeThreadId: ThreadId;
} {
  return Boolean(
    input.draftThread &&
    input.routeThreadId &&
    input.draftThread.projectId === input.projectId &&
    input.draftThread.entryPoint === input.entryPoint,
  );
}

// Resolve the durable thread payload for terminal-first promotion from the most specific state.
export function resolveTerminalThreadCreationState(
  input: ResolveTerminalThreadCreationStateInput,
): TerminalThreadCreationState {
  return {
    modelSelection: resolvePreferredComposerModelSelection({
      draft: input.draftComposerState,
      threadModelSelection:
        input.activeThread?.projectId === input.projectId
          ? input.activeThread.modelSelection
          : null,
      projectModelSelection: input.projectDefaultModelSelection,
      defaultProvider: input.defaultProvider,
    }),
    runtimeMode:
      input.draftThread?.runtimeMode ??
      (input.activeThread?.projectId === input.projectId ? input.activeThread.runtimeMode : null) ??
      (input.activeDraftThread?.projectId === input.projectId
        ? input.activeDraftThread.runtimeMode
        : null) ??
      DEFAULT_RUNTIME_MODE,
    interactionMode:
      // Plan mode is an explicit composer/thread choice. Do not copy it from
      // the previously active thread into a fresh session bootstrap.
      input.draftThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    lastKnownPr:
      input.draftThread?.lastKnownPr ??
      (input.activeThread?.projectId === input.projectId
        ? (input.activeThread.lastKnownPr ?? null)
        : null) ??
      (input.activeDraftThread?.projectId === input.projectId
        ? (input.activeDraftThread.lastKnownPr ?? null)
        : null) ??
      null,
    envMode: input.draftThread?.envMode ?? input.defaultEnvMode,
    branch: input.draftThread?.branch ?? null,
    worktreePath: input.draftThread?.worktreePath ?? null,
  };
}
