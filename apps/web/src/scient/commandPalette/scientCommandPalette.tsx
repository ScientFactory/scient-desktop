import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo } from "react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
} from "~/components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useScientProjectInitialization } from "~/hooks/useScientProjectInitialization";
import type { ScientProjectInitializationDecision } from "~/lib/scientProjectInitialization";
import { recordScientAnalytics, useScientAnalyticsView } from "~/scient/analytics/client";
import { readPreparedConnection } from "~/state/session";
import { allEnvironmentProjectSnapshotsReadyAtom } from "~/state/shell";

/** Records which command palette feature is in view while it is open. */
export function useScientCommandPaletteView(
  open: boolean,
  openIntent: CommandPaletteOpenIntent | null,
): void {
  useScientAnalyticsView(
    open
      ? {
          name: "feature.viewed",
          properties: {
            feature:
              openIntent?.kind === "add-project"
                ? "project-picker"
                : openIntent?.kind === "new-thread-in"
                  ? "new-thread"
                  : "search",
          },
        }
      : null,
  );
}

/**
 * Scient project initialization for projects opened from the palette. A
 * pending setup question is cancelled when the palette closes.
 */
export function useScientCommandPaletteProjectInitialization(open: boolean) {
  const {
    initializeWithFeedback: initializeProjectWithFeedback,
    inspection: projectInitializationInspection,
    prepareForOpening: prepareScientProjectForOpening,
    resolveDecision: resolveProjectInitializationDecision,
  } = useScientProjectInitialization();
  useLayoutEffect(() => {
    if (!open) resolveProjectInitializationDecision("cancel");
  }, [open, resolveProjectInitializationDecision]);
  const handleProjectInitializationDecision = useCallback(
    (decision: ScientProjectInitializationDecision) => {
      // The opening attempt closes the picker at handoff, after registration
      // and draft preparation. A setup choice alone isn't a navigation handoff.
      resolveProjectInitializationDecision(decision);
    },
    [resolveProjectInitializationDecision],
  );
  return {
    initializeProjectWithFeedback,
    projectInitializationInspection,
    prepareScientProjectForOpening,
    resolveProjectInitializationDecision,
    handleProjectInitializationDecision,
  };
}

/**
 * "New thread in…" also offers Add project. Adding one ends in a new thread in
 * it, as opening a project does, so with no projects the picker is how New
 * thread gets started.
 */
export function useScientNewThreadAddProjectItem(openAddProjectFlow: () => void) {
  const projectSnapshotsReady = useAtomValue(allEnvironmentProjectSnapshotsReadyAtom);
  const newThreadAddProjectItem = useMemo(
    (): CommandPaletteActionItem => ({
      kind: "action",
      value: "action:new-thread-in:add-project",
      searchTerms: ["add project", "new project", "folder", "clone", "repository"],
      title: "Add project",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openAddProjectFlow();
      },
    }),
    [openAddProjectFlow],
  );
  return { projectSnapshotsReady, newThreadAddProjectItem };
}

type ScientProjectInitialization = ReturnType<typeof useScientCommandPaletteProjectInitialization>;

/** Starts Scient initialization of an opened project when preparation asked for it. */
export function scientInitializeOpenedProject(
  initializeProject: boolean,
  initializeProjectWithFeedback: ScientProjectInitialization["initializeProjectWithFeedback"],
  target: { readonly environmentId: EnvironmentId; readonly root: string },
): void {
  if (initializeProject) {
    void initializeProjectWithFeedback(target);
  }
}

/** Tells the user a new project is saved but not yet in the sidebar. */
export function notifyScientProjectStillSyncing(): void {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Project added but still syncing",
      description: "The project is saved. Select it again after it appears in the sidebar.",
    }),
  );
}

/** Records the stage at which adding a project failed. */
export function recordScientProjectAddFailed(
  environmentId: EnvironmentId,
  stage: "validation" | "registration" | "navigation",
): void {
  recordScientAnalytics(readPreparedConnection(environmentId), {
    name: "project.add.failed",
    properties: { stage },
  });
}

/** Records a new thread started in an opened project. */
export function recordScientThreadCreated(environmentId: EnvironmentId): void {
  recordScientAnalytics(readPreparedConnection(environmentId), {
    name: "thread.created",
    properties: { creationSource: "new" },
  });
}

/** Records opening a project that was already registered. */
export function recordScientExistingProjectOpened(
  environmentId: EnvironmentId,
  initializeProject: boolean,
): void {
  recordScientAnalytics(readPreparedConnection(environmentId), {
    name: "project.opened",
    properties: {
      projectState: "existing",
      initializationState: initializeProject ? "missing" : "unknown",
    },
  });
}

/** Records adding a new project, opening it, and its first thread. */
export function recordScientProjectAdded(
  environmentId: EnvironmentId,
  analyticsMethod: "picker" | "drag-drop" | "recent" | "unknown",
  initializeProject: boolean,
): void {
  const analyticsConnection = readPreparedConnection(environmentId);
  recordScientAnalytics(analyticsConnection, {
    name: "project.added",
    properties: { method: analyticsMethod },
  });
  recordScientAnalytics(analyticsConnection, {
    name: "project.opened",
    properties: {
      projectState: "new",
      initializationState: initializeProject ? "missing" : "unknown",
    },
  });
  recordScientAnalytics(analyticsConnection, {
    name: "thread.created",
    properties: { creationSource: "new" },
  });
}
