import { useAtomValue } from "@effect/atom-react";
import { FolderPlusIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo } from "react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
} from "~/components/CommandPalette.logic";
import { useScientProjectInitialization } from "~/hooks/useScientProjectInitialization";
import type { ScientProjectInitializationDecision } from "~/lib/scientProjectInitialization";
import { useScientAnalyticsView } from "~/scient/analytics/client";
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
