import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

/**
 * The saved default an open draft should switch to, or null when it already
 * uses it, nobody saved one, or a human pick stands. New-thread seeding puts
 * a non-null default on every unpicked draft, so a mismatch means the default
 * changed (in Settings, usually) after the draft was seeded.
 */
export function resolveStaleDraftDefaultModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
  projectDefaultSelection: ModelSelection | null,
): ModelSelection | null {
  if (!draft || !projectDefaultSelection || hasExplicitComposerModelSelection(draft)) return null;
  const current = draft.modelSelectionByProvider[projectDefaultSelection.instanceId];
  return draft.activeProvider === projectDefaultSelection.instanceId &&
    current !== undefined &&
    Equal.equals(current, projectDefaultSelection)
    ? null
    : projectDefaultSelection;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return context.activeThread.projectId === null
      ? null
      : scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return context.activeDraftThread.projectId === null
      ? null
      : scopeProjectRef(
          context.activeDraftThread.environmentId,
          context.activeDraftThread.projectId,
        );
  }
  return context.defaultProjectRef;
}

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
