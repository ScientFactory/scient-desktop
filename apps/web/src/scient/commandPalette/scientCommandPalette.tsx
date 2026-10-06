import { useAtomValue } from "@effect/atom-react";
import {
  canonicalizeUneditedBrowseQuery,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import type {
  EnvironmentId,
  FilesystemBrowseResult,
  SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import { FolderPlusIcon } from "lucide-react";
import {
  type ComponentProps,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type BrowseHighlightReason,
  ITEM_ICON_CLASS,
  isKeyboardBrowseHighlight,
  resolveBrowseEnterAction,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
} from "~/components/CommandPalette.logic";
import type { CommandPaletteContent } from "~/components/CommandPaletteContent";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useProjectFolderDrop } from "~/hooks/useProjectFolderDrop";
import { useScientProjectInitialization } from "~/hooks/useScientProjectInitialization";
import { ensureBrowseDirectoryPath, isFilesystemBrowseQuery } from "~/lib/projectPaths";
import type { ScientProjectInitializationDecision } from "~/lib/scientProjectInitialization";
import { getAvailableNewFolderName, getAvailableNewProjectPath } from "~/lib/projectEntry";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
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

interface AddProjectBrowseScopeState {
  readonly baseDirectoryPath: string;
  readonly initialPath: string;
  readonly resolvedInitialPath: string | null;
}

/**
 * Add project browsing keeps the folder it started in, and where the
 * environment resolved it, so typed paths stay relative to that folder and
 * a symbolic default such as `~/` keeps resolving to the same place.
 */
export function useScientAddProjectBrowseScope() {
  const [addProjectBrowseScope, setAddProjectBrowseScope] =
    useState<AddProjectBrowseScopeState | null>(null);
  const addProjectBrowseSession = useRef(0);
  const resetAddProjectBrowseScope = useCallback((): void => {
    addProjectBrowseSession.current += 1;
    setAddProjectBrowseScope(null);
  }, []);
  const filesystemBrowseScope = useMemo(
    () =>
      addProjectBrowseScope === null
        ? null
        : {
            baseDirectoryPath: addProjectBrowseScope.baseDirectoryPath,
            ...(addProjectBrowseScope.resolvedInitialPath
              ? {
                  alias: {
                    path: addProjectBrowseScope.initialPath,
                    resolvedPath: addProjectBrowseScope.resolvedInitialPath,
                  },
                }
              : {}),
          },
    [addProjectBrowseScope],
  );
  const updateAddProjectBrowseBase = useCallback((baseDirectoryPath: string | null): void => {
    if (baseDirectoryPath === null) return;
    setAddProjectBrowseScope((current) =>
      current === null || current.baseDirectoryPath === baseDirectoryPath
        ? current
        : { ...current, baseDirectoryPath },
    );
  }, []);

  /** Follows the folder a typed path moves to. */
  function followAddProjectBrowseQuery(nextQuery: string, browseEnvironmentPlatform: string): void {
    if (
      addProjectBrowseScope !== null &&
      isFilesystemBrowseQuery(nextQuery, browseEnvironmentPlatform)
    ) {
      const nextBrowsePath = getFilesystemBrowsePath(
        nextQuery,
        browseEnvironmentPlatform,
        true,
        filesystemBrowseScope,
      );
      if (
        nextBrowsePath.directoryPath.length > 0 &&
        nextBrowsePath.directoryPath !== addProjectBrowseScope.baseDirectoryPath
      ) {
        setAddProjectBrowseScope({
          ...addProjectBrowseScope,
          baseDirectoryPath: nextBrowsePath.directoryPath,
        });
      }
    }
  }

  /** Starts a browse session at the initial folder; returns its session. */
  const beginAddProjectBrowseScope = useCallback(
    (initialQuery: string, initialBrowsePath: string): number => {
      const session = addProjectBrowseSession.current + 1;
      addProjectBrowseSession.current = session;
      setAddProjectBrowseScope({
        baseDirectoryPath: initialBrowsePath,
        initialPath: initialQuery,
        resolvedInitialPath: null,
      });
      return session;
    },
    [],
  );

  /** Records where the environment resolved the initial folder, if still browsing it. */
  const resolveAddProjectBrowseScope = useCallback(
    (
      session: number,
      result: FilesystemBrowseResult | null,
      initialQuery: string,
      setQuery: Dispatch<SetStateAction<string>>,
    ): void => {
      if (result === null || addProjectBrowseSession.current !== session) return;
      const resolvedInitialPath = ensureBrowseDirectoryPath(result.parentPath);
      setAddProjectBrowseScope((current) =>
        current === null
          ? current
          : {
              ...current,
              resolvedInitialPath,
            },
      );
      // Canonicalize an untouched symbolic default (notably `~/` on
      // Windows), but never replace text the user entered while the
      // environment was resolving it in the background.
      setQuery((current) =>
        canonicalizeUneditedBrowseQuery(current, initialQuery, resolvedInitialPath),
      );
    },
    [],
  );

  return {
    addProjectBrowseScope,
    resetAddProjectBrowseScope,
    filesystemBrowseScope,
    updateAddProjectBrowseBase,
    followAddProjectBrowseQuery,
    beginAddProjectBrowseScope,
    resolveAddProjectBrowseScope,
  };
}

/**
 * Which browse row is highlighted and why. Only a keyboard highlight makes
 * Enter pick the row; a pointer or automatic highlight, or a new-folder draft,
 * leaves Enter submitting the typed path.
 */
export function useScientBrowseHighlight(
  highlightedItemValue: string | null,
  setHighlightedItemValue: Dispatch<SetStateAction<string | null>>,
) {
  const highlightedItemValueRef = useRef<string | null>(null);
  const [highlightedItemReason, setHighlightedItemReason] = useState<BrowseHighlightReason | null>(
    null,
  );
  const highlightedItemReasonRef = useRef<BrowseHighlightReason | null>(null);
  const [isNewProjectFolderDraft, setIsNewProjectFolderDraft] = useState(false);

  const clearHighlightedItem = useCallback((): void => {
    highlightedItemValueRef.current = null;
    highlightedItemReasonRef.current = null;
    setHighlightedItemValue(null);
    setHighlightedItemReason(null);
  }, [setHighlightedItemValue]);

  const handleItemHighlighted: NonNullable<
    ComponentProps<typeof CommandPaletteContent>["onItemHighlighted"]
  > = (value, eventDetails) => {
    const nextValue = typeof value === "string" ? value : null;
    const nextReason: BrowseHighlightReason | null =
      nextValue == null
        ? null
        : eventDetails.reason === "keyboard" || eventDetails.reason === "pointer"
          ? eventDetails.reason
          : "none";
    highlightedItemValueRef.current = nextValue;
    highlightedItemReasonRef.current = nextReason;
    setHighlightedItemValue(nextValue);
    setHighlightedItemReason(nextReason);
  };

  const hasKeyboardBrowseHighlight =
    !isNewProjectFolderDraft &&
    isKeyboardBrowseHighlight({
      highlightedItemValue,
      highlightReason: highlightedItemReason,
    });

  return {
    highlightedItemValueRef,
    highlightedItemReasonRef,
    isNewProjectFolderDraft,
    setIsNewProjectFolderDraft,
    clearHighlightedItem,
    handleItemHighlighted,
    hasKeyboardBrowseHighlight,
  };
}

/** Captures Enter in the path input when it should submit the typed path. */
export function scientBrowseKeyDownCapture({
  projectPathInputRef,
  canSubmitBrowsePath,
  isNewProjectFolderDraft,
  isPrimaryModifierPressed,
  highlightedItemValueRef,
  highlightedItemReasonRef,
  submitCurrentPath,
}: {
  readonly projectPathInputRef: RefObject<HTMLInputElement | null>;
  readonly canSubmitBrowsePath: boolean;
  readonly isNewProjectFolderDraft: boolean;
  readonly isPrimaryModifierPressed: (event: KeyboardEvent<HTMLElement>) => boolean;
  readonly highlightedItemValueRef: RefObject<string | null>;
  readonly highlightedItemReasonRef: RefObject<BrowseHighlightReason | null>;
  readonly submitCurrentPath: () => void;
}) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== projectPathInputRef.current) return;
    const browseEnterAction = resolveBrowseEnterAction({
      canSubmitBrowsePath,
      forceSubmitCurrentPath: isNewProjectFolderDraft,
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      isPrimaryModifierPressed: isPrimaryModifierPressed(event),
      highlightedItemValue: highlightedItemValueRef.current,
      highlightReason: highlightedItemReasonRef.current,
    });
    if (browseEnterAction !== "submit-current-path") return;

    // Base UI can retain an internal active row after the visible highlight is
    // cleared. Intercept current-path submission during capture so that hidden
    // state cannot activate the previous row (notably `..`) on the way down to
    // the input's own combobox handler.
    event.preventDefault();
    event.stopPropagation();
    submitCurrentPath();
  };
}

function isMatchingLocalPlatform(environmentPlatform: string, browserPlatform: string): boolean {
  if (environmentPlatform === "MacIntel") return isMacPlatform(browserPlatform);
  if (environmentPlatform === "Win32") return isWindowsPlatform(browserPlatform);
  return environmentPlatform === "Linux" && /linux/u.test(browserPlatform.toLowerCase());
}

/**
 * Folder actions of Add project: dropping a folder from this computer's file
 * manager opens it, and New folder starts a draft path in the current folder
 * with its name selected.
 */
export function useScientProjectFolderActions({
  canOpenProjectFromFileManager,
  isCloneDestinationStep,
  browseEnvironmentId,
  primaryEnvironmentId,
  browseEnvironmentPlatform,
  isBrowsing,
  relativePathNeedsActiveProject,
  browseDirectoryPath,
  browseEntries,
  projectPathInputRef,
  clearHighlightedItem,
  setIsNewProjectFolderDraft,
  setQuery,
  handleAddProject,
}: {
  readonly canOpenProjectFromFileManager: boolean;
  readonly isCloneDestinationStep: boolean;
  readonly browseEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly browseEnvironmentPlatform: string;
  readonly isBrowsing: boolean;
  readonly relativePathNeedsActiveProject: boolean;
  readonly browseDirectoryPath: string;
  readonly browseEntries: FilesystemBrowseResult["entries"];
  readonly projectPathInputRef: RefObject<HTMLInputElement | null>;
  readonly clearHighlightedItem: () => void;
  readonly setIsNewProjectFolderDraft: Dispatch<SetStateAction<boolean>>;
  readonly setQuery: Dispatch<SetStateAction<string>>;
  readonly handleAddProject: (rawCwd: string, analyticsMethod: "drag-drop") => Promise<void>;
}) {
  const canDropProjectFolder =
    canOpenProjectFromFileManager &&
    !isCloneDestinationStep &&
    browseEnvironmentId === primaryEnvironmentId &&
    isMatchingLocalPlatform(browseEnvironmentPlatform, navigator.platform) &&
    typeof window.desktopBridge?.getPathForFile === "function";
  const handleDroppedProjectFolder = useCallback(
    (path: string) => {
      setIsNewProjectFolderDraft(false);
      setQuery(path);
      void handleAddProject(path, "drag-drop");
    },
    [handleAddProject, setIsNewProjectFolderDraft, setQuery],
  );
  const projectFolderDrop = useProjectFolderDrop({
    enabled: canDropProjectFolder,
    onFolder: handleDroppedProjectFolder,
  });

  const beginNewProjectFolder = useCallback(() => {
    if (!isBrowsing || isCloneDestinationStep || relativePathNeedsActiveProject) return;
    if (!browseDirectoryPath) return;
    const directoryNames = browseEntries.map((entry) => entry.name);
    const folderName = getAvailableNewFolderName(directoryNames);
    const nextQuery = getAvailableNewProjectPath(browseDirectoryPath, directoryNames);
    clearHighlightedItem();
    setIsNewProjectFolderDraft(true);
    setQuery(nextQuery);
    requestAnimationFrame(() => {
      projectPathInputRef.current?.focus();
      projectPathInputRef.current?.setSelectionRange(
        nextQuery.length - folderName.length,
        nextQuery.length,
      );
    });
  }, [
    browseDirectoryPath,
    browseEntries,
    clearHighlightedItem,
    isBrowsing,
    isCloneDestinationStep,
    projectPathInputRef,
    relativePathNeedsActiveProject,
    setIsNewProjectFolderDraft,
    setQuery,
  ]);

  const canBeginNewProjectFolder =
    isBrowsing && !isCloneDestinationStep && !relativePathNeedsActiveProject;

  return {
    canDropProjectFolder,
    projectFolderDrop,
    beginNewProjectFolder,
    canBeginNewProjectFolder,
  };
}

/** With Git missing, every remote source says so instead of its provider status. */
export function scientMissingGitReadiness(discovery: SourceControlDiscoveryResult) {
  const gitMissing = discovery.versionControlSystems.some(
    (item) => item.kind === "git" && item.status === "missing",
  );
  if (!gitMissing) return null;
  const missingGit = {
    ready: false,
    hint: "Git is unavailable in this environment.",
  } as const;
  return {
    url: missingGit,
    github: missingGit,
    gitlab: missingGit,
    forgejo: missingGit,
    bitbucket: missingGit,
    "azure-devops": missingGit,
  };
}
