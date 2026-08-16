"use client";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
} from "@t3tools/client-runtime/operations/projects";
import { connectionStatusText, type PreparedConnection } from "@t3tools/client-runtime/connection";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type DesktopWslState,
  type EnvironmentId,
  type FilesystemBrowseResult,
  type ProjectId,
  type SourceControlDiscoveryResult,
  type SourceControlProviderKind,
  type SourceControlRepositoryInfo,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ArrowLeftIcon,
  CornerLeftUpIcon,
  FileSearchIcon,
  FolderIcon,
  FolderPlusIcon,
  LinkIcon,
  MessageSquareIcon,
  PaletteIcon,
  SettingsIcon,
  SquarePenIcon,
  TextSearchIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useProjectFolderDrop } from "../hooks/useProjectFolderDrop";
import { useScientProjectInitialization } from "../hooks/useScientProjectInitialization";
import { useClientSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { readLocalApi } from "../localApi";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { readPreparedConnection, usePreparedConnection } from "../state/session";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import { getAvailableNewFolderName, getAvailableNewProjectPath } from "../lib/projectEntry";
import {
  getNewThreadNavigationIntentCoordinator,
  type NewThreadNavigationIntent,
} from "../lib/newThreadNavigationIntent";
import { waitForProjectProjection } from "../lib/projectProjection";
import {
  shouldCloseProjectPickerAfterScientDecision,
  type ScientProjectInitializationDecision,
} from "../lib/scientProjectInitialization";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { getLatestThreadForProject, sortThreads } from "../lib/threadSort";
import { cn, isMacPlatform, isWindowsPlatform, newProjectId } from "../lib/utils";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";
import { recordScientAnalytics } from "../scient/analytics/client";
import {
  SCIENT_QUICK_CHAT_LABEL,
  SCIENT_QUICK_CHAT_LEGACY_SEARCH_TERMS,
  shouldAssignScientQuickChatNewThreadShortcut,
  supportsScientQuickChat,
} from "../scient/quickChat/policy";
import {
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  type BrowseHighlightReason,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  filterPinnedBrowseEntries,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  isKeyboardBrowseHighlight,
  reduceCommandPaletteUiState,
  resolveBrowseEnterAction,
  shouldOfferProjectPathCreation,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ScientProjectInitializationDialog } from "./ScientProjectInitializationDialog";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "./Icons";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectFolderDropTarget } from "./ProjectFolderDropTarget";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import type { Project } from "../types";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

function projectFavicon(project: Project) {
  return (
    <ProjectFavicon
      environmentId={project.environmentId}
      cwd={project.workspaceRoot}
      faviconPath={project.faviconPath}
      className={ITEM_ICON_CLASS}
    />
  );
}

function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }
  if (isWindowsPlatform(platform)) {
    return "Explorer";
  }
  return "Files";
}

function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function isMatchingLocalPlatform(environmentPlatform: string, browserPlatform: string): boolean {
  if (environmentPlatform === "MacIntel") return isMacPlatform(browserPlatform);
  if (environmentPlatform === "Win32") return isWindowsPlatform(browserPlatform);
  return environmentPlatform === "Linux" && /linux/u.test(browserPlatform.toLowerCase());
}

interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;
type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

const REMOTE_PROJECT_SOURCES: ReadonlyArray<AddProjectRemoteSource> = [
  "url",
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];
const REMOTE_PROJECT_PROVIDER_SOURCES: ReadonlyArray<AddProjectRemoteProviderKind> = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
];

function remoteProjectSourceLabel(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
    case "azure-devops":
      return "Azure DevOps";
    case "url":
      return "Git URL";
  }
}

function remoteProjectSourcePathHint(source: AddProjectRemoteSource): string {
  switch (source) {
    case "github":
      return "owner/repo";
    case "gitlab":
      return "group/project";
    case "bitbucket":
      return "workspace/repository";
    case "azure-devops":
      return "project/repository";
    case "url":
      return "URL";
  }
}

function remoteProjectSourceProvider(
  source: AddProjectRemoteSource,
): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function remoteProjectSourceIcon(source: AddProjectRemoteSource, className: string): ReactNode {
  switch (source) {
    case "github":
      return <GitHubIcon className={className} />;
    case "gitlab":
      return <GitLabIcon className={className} />;
    case "bitbucket":
      return <BitbucketIcon className={className} />;
    case "azure-devops":
      return <AzureDevOpsIcon className={className} />;
    case "url":
      return <LinkIcon className={className} />;
  }
}

function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${remoteProjectSourceLabel(flow.source)} repository (${remoteProjectSourcePathHint(flow.source)})`;
}

function sourceProviderKind(source: AddProjectRemoteSource): AddProjectRemoteProviderKind | null {
  return source === "url" ? null : source;
}

function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
): ReadonlyArray<AddProjectRemoteProviderKind> {
  return REMOTE_PROJECT_PROVIDER_SOURCES.toSorted((left, right) => {
    const leftReady = readinessBySource[left].ready;
    const rightReady = readinessBySource[right].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return remoteProjectSourceLabel(left).localeCompare(remoteProjectSourceLabel(right));
  });
}

type AddProjectRemoteSourceReadiness = Record<
  AddProjectRemoteSource,
  { readonly ready: boolean; readonly hint: string | null }
>;

function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const unavailable = {
    ready: false,
    hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
  } as const;
  const defaultReadiness: AddProjectRemoteSourceReadiness = {
    url: { ready: true, hint: null },
    github: unavailable,
    gitlab: unavailable,
    bitbucket: unavailable,
    "azure-devops": unavailable,
  };

  if (!discovery) {
    return defaultReadiness;
  }

  const providerByKind = new Map(
    discovery.sourceControlProviders.map((provider) => [provider.kind, provider]),
  );
  const readiness = { ...defaultReadiness };

  for (const source of REMOTE_PROJECT_SOURCES) {
    const kind = sourceProviderKind(source);
    if (!kind) continue;
    const provider = providerByKind.get(kind);
    if (!provider) {
      readiness[source] = unavailable;
      continue;
    }
    if (provider.status !== "available") {
      readiness[source] = { ready: false, hint: provider.installHint };
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness[source] = {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
      };
      continue;
    }
    readiness[source] = { ready: true, hint: null };
  }

  return readiness;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const toggleMode = useCallback(
    (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode }),
    [],
  );
  const openAddProject = useCallback(() => dispatch({ _tag: "OpenAddProject" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ _tag: "OpenNewThreadIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, previewOpen, resolvedTheme, terminalOpen, theme, themeHalves, toggleMode]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {children}
        <CommandPaletteDialog
          open={state.open}
          mode={state.mode}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openOverlayMode={toggleMode}
          clearOpenIntent={clearOpenIntent}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const composerHandleRef = useComposerHandleContext();

  if (!props.open) {
    return null;
  }

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn("overflow-hidden p-0", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openOverlayMode={props.openOverlayMode}
          clearOpenIntent={props.clearOpenIntent}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const { clearOpenIntent, openIntent, openOverlayMode, setOpen } = props;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const highlightedItemValueRef = useRef<string | null>(null);
  const [highlightedItemReason, setHighlightedItemReason] = useState<BrowseHighlightReason | null>(
    null,
  );
  const highlightedItemReasonRef = useRef<BrowseHighlightReason | null>(null);
  const [isNewProjectFolderDraft, setIsNewProjectFolderDraft] = useState(false);
  const clientSettings = useClientSettings();
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const lookupRepository = useAtomQueryRunner(sourceControlEnvironment.repository, {
    reportFailure: false,
  });
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme } = useTheme();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByEnvironmentAndInstanceId = useMemo(() => {
    const map = new Map<string, ProviderInstanceEntry>();
    for (const environment of environments) {
      const environmentProviders =
        environment.serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? providers : []);
      for (const entry of deriveProviderInstanceEntries(environmentProviders)) {
        map.set(`${environment.environmentId}:${entry.instanceId}`, entry);
      }
    }
    return map;
  }, [environments, primaryEnvironmentId, providers]);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const environmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const threadSearch = useThreadSearch(environmentIds, threadSearchQuery);
  const threadContentMatchByKey = useMemo(
    () =>
      new Map(
        threadSearch.matches.flatMap((match) =>
          match.source === "user" || match.source === "assistant"
            ? [[threadSearchMatchKey(match), match] as const]
            : [],
        ),
      ),
    [threadSearch.matches],
  );
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const browseNavigationRef = useRef<ReturnType<typeof createBrowseNavigationCoordinator> | null>(
    null,
  );
  if (browseNavigationRef.current === null) {
    browseNavigationRef.current = createBrowseNavigationCoordinator();
  }
  const browseNavigation = browseNavigationRef.current;
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  const {
    initializeWithFeedback: initializeProjectWithFeedback,
    inspection: projectInitializationInspection,
    prepareForOpening: prepareScientProjectForOpening,
    resolveDecision: resolveProjectInitializationDecision,
  } = useScientProjectInitialization();
  const handleProjectInitializationDecision = useCallback(
    (decision: ScientProjectInitializationDecision) => {
      // Resolve first so unmount cleanup cannot reinterpret an accepted choice
      // as cancellation. Both state changes are batched in the same interaction,
      // so the underlying project picker never resurfaces between dialogs.
      resolveProjectInitializationDecision(decision);
      if (shouldCloseProjectPickerAfterScientDecision(decision)) {
        setOpen(false);
      }
    },
    [resolveProjectInitializationDecision, setOpen],
  );
  const projectPathInputRef = useRef<HTMLInputElement>(null);
  const projectGroupingSettings = useMemo(
    () => selectProjectGroupingSettings(clientSettings),
    [clientSettings],
  );

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      clientSettings.sidebarProjectSortOrder,
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
    ],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        unsortedProjectGroups,
        threads,
        clientSettings.sidebarProjectSortOrder,
      ),
    [clientSettings.sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const contextualProjectRef = useMemo(
    () =>
      resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread],
  );
  const projectlessEnvironmentId = contextualProjectRef?.environmentId ?? primaryEnvironmentId;
  const supportsProjectlessThreads =
    projectlessEnvironmentId !== null &&
    supportsScientQuickChat(serverConfigs.get(projectlessEnvironmentId));
  const projectlessTargets = useMemo(
    () =>
      [...serverConfigs.entries()]
        .filter(([, config]) => supportsScientQuickChat(config))
        .map(([environmentId]) => ({
          environmentId,
          environmentLabel: environmentLabelById.get(environmentId) ?? "Environment",
        }))
        .sort((left, right) => {
          if (left.environmentId === primaryEnvironmentId) return -1;
          if (right.environmentId === primaryEnvironmentId) return 1;
          return left.environmentLabel.localeCompare(right.environmentLabel);
        }),
    [environmentLabelById, primaryEnvironmentId, serverConfigs],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef:
          contextualProjectRef?.projectId == null
            ? null
            : scopeProjectRef(contextualProjectRef.environmentId, contextualProjectRef.projectId),
      }),
    [contextualProjectRef, projectGroups],
  );
  const pickerProjects = useMemo(
    () =>
      projectPickerEntries.map(({ group, targetProject }) => ({
        ...targetProject,
        title: group.displayName,
      })),
    [projectPickerEntries],
  );
  const projectGroupByTargetKey = useMemo(
    () =>
      new Map(
        projectPickerEntries.map(({ group, targetProject }) => [
          `${targetProject.environmentId}:${targetProject.id}`,
          group,
        ]),
      ),
    [projectPickerEntries],
  );

  const addProjectEnvironmentOptions = useMemo(() => {
    const options = environments.map((environment): AddProjectEnvironmentOption => {
      const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
      return {
        environmentId: environment.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary,
          environmentId: environment.environmentId,
          runtimeLabel: environment.label,
        }),
        isPrimary,
        isConnected: canCreateProjectInEnvironment(environment.connection.phase),
        status: connectionStatusText(environment.connection),
      };
    });

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  }, [environments]);
  const defaultAddProjectEnvironmentId =
    addProjectEnvironmentOptions.find((option) => option.isConnected)?.environmentId ?? null;
  const wslAddProjectEnvironmentOption = useMemo(
    () =>
      addProjectEnvironmentOptions.find((option) => {
        if (!option.isConnected) {
          return false;
        }
        const environment = environments.find(
          (candidate) => candidate.environmentId === option.environmentId,
        );
        return environment
          ? desktopLocalBackendId(environment.entry.target)?.startsWith("wsl:") === true
          : false;
      }) ?? null,
    [addProjectEnvironmentOptions, environments],
  );
  const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
  const browsePreparedConnection = usePreparedConnection(browseEnvironmentId);
  const browseEnvironment =
    environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
  // A desktop-local secondary backend (today: the WSL backend). The picker is
  // available against these too — the desktop dispatches pickFolder into the
  // backend's filesystem when routed by its instance id.
  const browseEnvironmentIsDesktopLocal =
    browseEnvironment !== null && isDesktopLocalConnectionTarget(browseEnvironment.entry.target);
  // Map the browsed desktop-local env to its desktop pool instance id (e.g.
  // "wsl:ubuntu"). The catalog environmentId is descriptor-derived and won't
  // route on the desktop side; pickFolder only recognizes the pool id, which
  // the bootstrap list exposes. Match on backend URL, exactly as Sidebar's
  // LocalSecondaryStatus does (environment.displayUrl === bootstrap.httpBaseUrl).
  const browseDesktopInstanceId = useMemo(() => {
    if (!browseEnvironmentIsDesktopLocal || browseEnvironment === null) {
      return null;
    }
    const displayUrl = browseEnvironment.displayUrl;
    if (displayUrl === null) {
      return null;
    }
    return (
      desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === displayUrl)?.id ?? null
    );
  }, [browseEnvironment, browseEnvironmentIsDesktopLocal, desktopLocalBootstraps]);
  const sourceControlDiscovery = useEnvironmentQuery(
    browseEnvironmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: browseEnvironmentId,
          input: {},
        }),
  );
  const browseEnvironmentPlatform = getEnvironmentBrowsePlatform(
    browseEnvironment?.serverConfig?.environment.platform.os,
  );
  const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
  const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
  // The destination step pins the repository folder onto the browsed path, so
  // the proposed clone target is "<chosen folder>/<repo>" instead of the bare
  // folder. A lookup reports "owner/repo"; a pasted clone URL falls back to its
  // own last segment, minus ".git".
  const pinnedCloneDirectoryName =
    addProjectCloneFlow?.step === "confirm"
      ? getCloneDirectoryName(
          addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.remoteUrl,
        )
      : "";
  const browsePath = useMemo(
    () => getFilesystemBrowsePath(query, browseEnvironmentPlatform, !isRemoteProjectRepositoryStep),
    [browseEnvironmentPlatform, isRemoteProjectRepositoryStep, query],
  );
  const isBrowsing = browsePath.isBrowsing;
  const browseDirectoryPath = browsePath.directoryPath;
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQueryForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      const environmentSettings = environment?.serverConfig?.settings ?? null;
      const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
      if (baseDirectory.length === 0) {
        return "~/";
      }
      return ensureBrowseDirectoryPath(baseDirectory);
    },
    [environments],
  );

  const projectCwdById = useMemo(
    () =>
      new Map<ProjectId, string>(projects.map((project) => [project.id, project.workspaceRoot])),
    [projects],
  );
  const projectFaviconPathById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.faviconPath ?? null] as const)),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const activeThreadId = activeThread?.id;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const getBrowseCwdForEnvironment = useCallback(
    (environmentId: EnvironmentId | null): string | null =>
      environmentId && currentProjectEnvironmentId === environmentId ? currentProjectCwd : null,
    [currentProjectCwd, currentProjectEnvironmentId],
  );
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseQuery = useEnvironmentQuery(
    isBrowsing &&
      browsePath.directoryPath.length > 0 &&
      browseEnvironmentId !== null &&
      !relativePathNeedsActiveProject
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
          },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const isBrowsePending = browseQuery.isPending;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } = useMemo(
    () =>
      pinnedCloneDirectoryName
        ? filterPinnedBrowseEntries({
            browseEntries,
            filterQuery: browsePath.filterQuery,
            pinnedDirectoryName: pinnedCloneDirectoryName,
            caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
          })
        : filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery),
    [browseEntries, browseEnvironmentPlatform, browsePath.filterQuery, pinnedCloneDirectoryName],
  );

  const prefetchBrowsePath = useCallback(
    async (
      partialPath: string,
      environmentId: EnvironmentId | null = browseEnvironmentId,
      cwd: string | null = currentProjectCwdForBrowse,
    ): Promise<void> => {
      if (!environmentId) {
        return;
      }
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!canPreloadBrowsePath(environment?.connection.phase)) {
        return;
      }

      await loadBrowsePath({
        environmentId,
        input: {
          partialPath,
          ...(cwd ? { cwd } : {}),
        },
      });
    },
    [browseEnvironmentId, currentProjectCwdForBrowse, environments, loadBrowsePath],
  );

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const groupedProjectKeys = group
        ? new Set(
            group.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          )
        : null;
      const latestThread = groupedProjectKeys
        ? (sortThreads(
            threads.filter(
              (thread) =>
                thread.archivedAt === null &&
                groupedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
            ),
            clientSettings.sidebarThreadSortOrder,
          )[0] ?? null)
        : getLatestThreadForProject(
            threads.filter((thread) => thread.environmentId === project.environmentId),
            project.id,
            clientSettings.sidebarThreadSortOrder,
          );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [
      clientSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      projectGroupByTargetKey,
      threads,
    ],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects: pickerProjects,
        valuePrefix: "project",
        searchTerms: (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          return (
            group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []
          );
        },
        icon: projectFavicon,
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, pickerProjects, projectGroupByTargetKey],
  );

  const projectThreadItems = useMemo(() => {
    const projectItems = buildProjectActionItems({
      projects: pickerProjects,
      valuePrefix: "new-thread-in",
      searchTerms: (project) => {
        const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
        return (
          group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []
        );
      },
      icon: projectFavicon,
      runProject: async (project) => {
        const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
        const contextualRefBelongsToGroup =
          contextualProjectRef !== null &&
          group?.memberProjectRefs.some(
            (projectRef) =>
              projectRef.environmentId === contextualProjectRef.environmentId &&
              projectRef.projectId === contextualProjectRef.projectId,
          );
        await handleNewThread(
          contextualRefBelongsToGroup
            ? contextualProjectRef
            : scopeProjectRef(project.environmentId, project.id),
        );
      },
    });
    const showEnvironmentLabel = projectlessTargets.length > 1;
    const projectlessItems: CommandPaletteActionItem[] = projectlessTargets.map(
      ({ environmentId, environmentLabel }) => ({
        kind: "action",
        value: `new-thread-in:${environmentId}:projectless`,
        searchTerms: [
          "new thread",
          "quick chat",
          ...SCIENT_QUICK_CHAT_LEGACY_SEARCH_TERMS,
          "without project",
          "no project",
          "chat",
          environmentLabel,
        ],
        title: SCIENT_QUICK_CHAT_LABEL,
        description: showEnvironmentLabel ? environmentLabel : "Chat without a project",
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await handleNewThread({ environmentId, projectId: null });
        },
      }),
    );

    return enumerateCommandPaletteItems([...projectItems, ...projectlessItems]);
  }, [
    contextualProjectRef,
    handleNewThread,
    pickerProjects,
    projectGroupByTargetKey,
    projectlessTargets,
  ]);

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: clientSettings.sidebarThreadSortOrder,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        renderDescription: (thread, { projectTitle }) => {
          const modelInstanceId =
            thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
          const providerEntry =
            providerEntryByEnvironmentAndInstanceId.get(
              `${thread.environmentId}:${modelInstanceId}`,
            ) ?? null;
          return (
            <ThreadCommandSubtitle
              environmentId={thread.environmentId}
              projectCwd={
                thread.projectId === null ? null : (projectCwdById.get(thread.projectId) ?? null)
              }
              projectFaviconPath={
                thread.projectId === null
                  ? null
                  : (projectFaviconPathById.get(thread.projectId) ?? null)
              }
              projectTitle={projectTitle ?? null}
              branch={thread.branch}
              worktreePath={thread.worktreePath}
              isCurrent={thread.id === activeThreadId}
              driverKind={providerEntry?.driverKind ?? null}
              providerDisplayName={
                thread.session?.providerName ?? providerEntry?.displayName ?? modelInstanceId
              }
            />
          );
        },
        getContentMatch: (thread) => {
          const match = threadContentMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          );
          return match && (match.source === "user" || match.source === "assistant")
            ? {
                source: match.source,
                snippet: match.snippet,
                query: threadSearchQuery,
              }
            : undefined;
        },
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [
      activeThreadId,
      clientSettings.sidebarThreadSortOrder,
      navigate,
      projectCwdById,
      projectFaviconPathById,
      projectTitleById,
      providerEntryByEnvironmentAndInstanceId,
      threadContentMatchByKey,
      threadSearchQuery,
      threads,
    ],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);

  function clearHighlightedItem(): void {
    highlightedItemValueRef.current = null;
    highlightedItemReasonRef.current = null;
    setHighlightedItemValue(null);
    setHighlightedItemReason(null);
  }

  const pushPaletteView = useCallback(
    (view: CommandPaletteView): void => {
      browseNavigation.invalidate();
      setViewStack((previousViews) => [
        ...previousViews,
        {
          addonIcon: view.addonIcon,
          groups: view.groups,
          ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
        },
      ]);
      clearHighlightedItem();
      setIsNewProjectFolderDraft(false);
      setQuery(view.initialQuery ?? "");
    },
    [browseNavigation],
  );

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    }
    setViewStack((previousViews) => previousViews.slice(0, -1));
    clearHighlightedItem();
    setIsNewProjectFolderDraft(false);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    browseNavigation.invalidate();
    clearHighlightedItem();
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const startAddProjectBrowse = useCallback(
    async (environmentId: EnvironmentId): Promise<void> => {
      const initialQuery = getAddProjectInitialQueryForEnvironment(environmentId);
      const initialBrowsePath = getBrowseDirectoryPath(initialQuery);
      const browseCwd = getBrowseCwdForEnvironment(environmentId);
      const view: CommandPaletteView = {
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [],
        initialQuery,
      };

      await browseNavigation.run(
        () =>
          initialBrowsePath.length > 0
            ? prefetchBrowsePath(initialBrowsePath, environmentId, browseCwd)
            : Promise.resolve(),
        () => {
          setAddProjectEnvironmentId(environmentId);
          setAddProjectCloneFlow(null);
          pushPaletteView(view);
        },
      );
    },
    [
      browseNavigation,
      getAddProjectInitialQueryForEnvironment,
      getBrowseCwdForEnvironment,
      prefetchBrowsePath,
      pushPaletteView,
    ],
  );

  const startAddProjectClone = useCallback(
    (environmentId: EnvironmentId, source: AddProjectRemoteSource): void => {
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow({ step: "repository", environmentId, source });
      pushPaletteView({
        addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
        groups: [],
        initialQuery: "",
      });
    },
    [pushPaletteView],
  );

  const openSourceControlSettings = useCallback(() => {
    setOpen(false);
    void navigate({ to: "/settings/source-control" });
  }, [navigate, setOpen]);

  const buildAddProjectSourceGroups = useCallback(
    (
      environmentId: EnvironmentId,
      readinessBySource: AddProjectRemoteSourceReadiness,
    ): CommandPaletteView["groups"] => {
      const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
        {
          kind: "action",
          value: `action:add-project:${environmentId}:local`,
          searchTerms: ["local", "folder", "directory", "browse"],
          title: "Local folder",
          description: "Browse a folder on disk",
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            await startAddProjectBrowse(environmentId);
          },
        },
      ];

      const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
        "url",
        ...sortAddProjectProviderSources(readinessBySource),
      ];

      for (const source of orderedSources) {
        const label = remoteProjectSourceLabel(source);
        const title = source === "url" ? "Git URL" : `${label} repository`;
        const description =
          source === "url"
            ? "Clone from a remote URL"
            : `Clone ${label} ${remoteProjectSourcePathHint(source)}`;
        const readiness = readinessBySource[source];
        const disabledHint = readiness.hint;

        const titleTrailingContent = readiness.ready ? undefined : (
          <span className="ml-auto">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-5 rounded-[.25rem] px-1.5 text-[10px] text-warning-foreground"
                    onClick={() => {
                      openSourceControlSettings();
                    }}
                  >
                    Setup Required
                  </Button>
                }
              />
              <TooltipPopup align="end" side="left">
                {disabledHint ?? "Open Settings -> Source Control to configure this provider."}
              </TooltipPopup>
            </Tooltip>
          </span>
        );

        if (!readiness.ready) {
          sourceItems.push({
            kind: "action",
            value: `action:add-project:${environmentId}:${source}:not-ready`,
            searchTerms: ["clone", "remote", "repository", "repo", "git", label, "setup required"],
            title,
            description,
            disabled: true,
            icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
            ...(titleTrailingContent ? { titleTrailingContent } : {}),
            run: async () => {},
          });
          continue;
        }

        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label],
          title,
          description,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          ...(titleTrailingContent ? { titleTrailingContent } : {}),
          keepOpen: true,
          run: async () => {
            startAddProjectClone(environmentId, source);
          },
        });
      }

      return [{ value: `sources:${environmentId}`, label: "Sources", items: sourceItems }];
    },
    [openSourceControlSettings, startAddProjectBrowse, startAddProjectClone],
  );

  const startAddProjectSourceSelection = useCallback(
    (environmentId: EnvironmentId): void => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: `${environment?.label ?? "The selected environment"} is not connected.`,
          }),
        );
        return;
      }
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: buildAddProjectSourceGroups(
          environmentId,
          buildAddProjectRemoteSourceReadiness(
            browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
          ),
        ),
      });
    },
    [
      browseEnvironmentId,
      buildAddProjectSourceGroups,
      environments,
      pushPaletteView,
      sourceControlDiscovery.data,
    ],
  );

  const addProjectEnvironmentItems: CommandPaletteActionItem[] = addProjectEnvironmentOptions.map(
    (option) => ({
      kind: "action",
      value: `action:add-project:environment:${option.environmentId}`,
      searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
      title: option.label,
      description: option.isConnected
        ? option.isPrimary
          ? "This device"
          : option.environmentId
        : option.status,
      disabled: !option.isConnected,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        startAddProjectSourceSelection(option.environmentId);
      },
    }),
  );

  const addProjectEnvironmentGroups = useMemo<CommandPaletteView["groups"]>(
    () => [
      {
        value: "environments",
        label: "Environments",
        items: addProjectEnvironmentItems,
      },
    ],
    [addProjectEnvironmentItems],
  );

  const openAddProjectFlow = useCallback(() => {
    if (addProjectEnvironmentOptions.length > 1 || defaultAddProjectEnvironmentId === null) {
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: addProjectEnvironmentGroups,
      });
      return;
    }

    const environmentId = defaultAddProjectEnvironmentId;
    if (!environmentId) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to browse projects",
          description: "No environment is available.",
        }),
      );
      return;
    }

    void startAddProjectSourceSelection(environmentId);
  }, [
    addProjectEnvironmentGroups,
    addProjectEnvironmentOptions.length,
    defaultAddProjectEnvironmentId,
    pushPaletteView,
    startAddProjectSourceSelection,
  ]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "add-project") {
      return;
    }
    clearOpenIntent();
    openAddProjectFlow();
  }, [clearOpenIntent, openAddProjectFlow, openIntent]);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "new-thread-in" || projectThreadItems.length === 0) {
      return;
    }
    clearOpenIntent();
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    setViewStack([]);
    setQuery("");
    const currentPrefix =
      contextualProjectRef?.projectId === null
        ? `new-thread-in:${contextualProjectRef.environmentId}:projectless`
        : currentProjectEnvironmentId && currentProjectId
          ? `new-thread-in:${currentProjectEnvironmentId}:${currentProjectId}`
          : null;
    const prioritized = currentPrefix
      ? [
          ...projectThreadItems.filter((item) => item.value === currentPrefix),
          ...projectThreadItems.filter((item) => item.value !== currentPrefix),
        ]
      : projectThreadItems;
    pushPaletteView({
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "projects",
          label: "Projects",
          items: enumerateCommandPaletteItems(prioritized),
        },
      ],
    });
  }, [
    clearOpenIntent,
    browseNavigation,
    currentProjectEnvironmentId,
    currentProjectId,
    contextualProjectRef,
    openIntent,
    projectThreadItems,
    pushPaletteView,
  ]);

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  const activeProjectTitle =
    projects.length > 0
      ? (projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
        (currentProjectId ? (projectTitleById.get(currentProjectId) ?? null) : null))
      : null;

  if (activeProjectTitle !== null) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread",
      searchTerms: ["new thread", "chat", "create", "draft"],
      title: (
        <>
          New thread in <span className="font-semibold">{activeProjectTitle}</span>
        </>
      ),
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.new",
      run: async () => {
        await startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
      },
    });
  }

  if (projectThreadItems.length > 0) {
    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new thread", "project", "pick", "choose", "select"],
      title: "New thread in...",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }

  if (projectlessEnvironmentId !== null && supportsProjectlessThreads) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread-without-project",
      searchTerms: [
        "new thread",
        "quick chat",
        ...SCIENT_QUICK_CHAT_LEGACY_SEARCH_TERMS,
        "without project",
        "no project",
        "chat",
      ],
      title: SCIENT_QUICK_CHAT_LABEL,
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      ...(shouldAssignScientQuickChatNewThreadShortcut({
        hasQuickChatTarget: true,
        hasProjectShortcutTarget: activeProjectTitle !== null,
      })
        ? { shortcutCommand: "chat.new" as const }
        : {}),
      run: async () => {
        await handleNewThread({ environmentId: projectlessEnvironmentId, projectId: null });
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: "Go to file",
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openOverlayMode("files");
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:search-project-contents",
    searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
    title: "Search project contents",
    icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "projectSearch.toggle",
    run: async () => {
      openOverlayMode("content");
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:add-project",
    searchTerms: [
      "add project",
      "folder",
      "directory",
      "browse",
      "clone",
      "remote",
      "repository",
      "repo",
      "git",
      "github",
      "gitlab",
      "bitbucket",
      "azure",
      "devops",
      "url",
      "environment",
    ],
    title: "Add project",
    disabled: defaultAddProjectEnvironmentId === null,
    icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      openAddProjectFlow();
    },
  });

  if (wslAddProjectEnvironmentOption) {
    actionItems.push({
      kind: "action",
      value: "action:add-project:wsl-folder",
      searchTerms: ["add project", "open", "wsl", "linux", "folder", "directory"],
      title: "Open WSL folder",
      description: wslAddProjectEnvironmentOption.label,
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        await startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  // There is no projects listing page; the action targets the contextual
  // project (active thread/draft, falling back to the first sidebar group).
  const contextualProjectGroup =
    (contextualProjectRef
      ? projectGroupByTargetKey.get(
          `${contextualProjectRef.environmentId}:${contextualProjectRef.projectId}`,
        )
      : null) ??
    projectGroups[0] ??
    null;
  if (contextualProjectGroup) {
    actionItems.push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: ["project", "settings", "scripts", "model", "grouping", "checkout"],
      title: "Project settings",
      description: contextualProjectGroup.displayName,
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualProjectGroup.projectKey },
        });
      },
    });
  }

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  const sourceSelectionViewValue =
    addProjectEnvironmentId === null ? null : `sources:${addProjectEnvironmentId}`;
  const activeGroups =
    addProjectEnvironmentId !== null &&
    currentView !== null &&
    currentView.groups[0]?.value === sourceSelectionViewValue
      ? buildAddProjectSourceGroups(
          addProjectEnvironmentId,
          buildAddProjectRemoteSourceReadiness(sourceControlDiscovery.data),
        )
      : (currentView?.groups ?? rootGroups);

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    projectSearchItems: projectSearchItems,
    threadSearchItems: allThreadItems,
  });

  const handleAddProjectForEnvironment = useCallback(
    async (
      input: {
        readonly environmentId: EnvironmentId;
        readonly rawCwd: string;
        readonly platform: string;
        readonly currentProjectCwd: string | null;
        readonly prepared: PreparedConnection | null;
        readonly analyticsMethod: "picker" | "drag-drop" | "recent" | "unknown";
      },
      preparedNavigationIntent?: NewThreadNavigationIntent,
    ) => {
      // Claim at the user's selection boundary, before filesystem inspection
      // or project registration can yield. Claiming only inside
      // handleNewThread lets an older, slower open complete one click late.
      const navigationIntent =
        preparedNavigationIntent ??
        getNewThreadNavigationIntentCoordinator(router, (invalidate) => {
          router.subscribe("onBeforeNavigate", invalidate);
        }).claim({
          kind: "explicit",
          scope:
            router.state.location.state.__TSR_key ??
            router.state.location.state.key ??
            router.state.location.href,
        });
      const canCommitNavigation = navigationIntent.isCurrent;
      const environment = environments.find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: `${environment?.label ?? "The selected environment"} is not connected.`,
          }),
        );
        return;
      }
      const rawCwd = input.rawCwd;

      if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
        recordScientAnalytics(readPreparedConnection(input.environmentId), {
          name: "project.add.failed",
          properties: { stage: "validation" },
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Windows-style paths are only supported on Windows.",
          }),
        );
        return;
      }

      if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
        recordScientAnalytics(readPreparedConnection(input.environmentId), {
          name: "project.add.failed",
          properties: { stage: "validation" },
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Relative paths require an active project.",
          }),
        );
        return;
      }

      let cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
      if (cwd.length === 0) return;

      const projectPreparation = await prepareScientProjectForOpening({
        environmentId: input.environmentId,
        prepared: input.prepared,
        root: cwd,
      });
      if (projectPreparation === null || !canCommitNavigation()) return;
      // The server owns filesystem identity. Use its canonical root for both
      // the host project record and the optional Scient initialization.
      cwd = projectPreparation.root;
      const initializeProject = projectPreparation.initialize;

      const existing = findProjectByPath(
        projects.filter((project) => project.environmentId === input.environmentId),
        cwd,
      );
      if (existing) {
        if (initializeProject) {
          void initializeProjectWithFeedback({
            environmentId: input.environmentId,
            root: cwd,
          });
        }
        const latestThread = getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === existing.environmentId),
          existing.id,
          clientSettings.sidebarThreadSortOrder,
        );
        if (latestThread) {
          if (!canCommitNavigation()) return;
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(latestThread.environmentId, latestThread.id),
            ),
          });
        } else {
          const navigationResult = await settlePromise(() =>
            handleNewThread(scopeProjectRef(existing.environmentId, existing.id), {
              navigationIntent,
            }),
          );
          if (navigationResult._tag === "Failure") {
            const error = squashAtomCommandFailure(navigationResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to open project",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
          recordScientAnalytics(readPreparedConnection(input.environmentId), {
            name: "thread.created",
            properties: { creationSource: "new" },
          });
        }
        recordScientAnalytics(readPreparedConnection(input.environmentId), {
          name: "project.opened",
          properties: {
            projectState: "existing",
            initializationState: initializeProject ? "missing" : "unknown",
          },
        });
        setOpen(false);
        return;
      }

      const projectId = newProjectId();
      const targetEnvironmentProviders =
        environments.find((environment) => environment.environmentId === input.environmentId)
          ?.serverConfig?.providers ??
        (input.environmentId === primaryEnvironmentId ? providers : []);
      const createResult = await createProject({
        environmentId: input.environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: resolveDefaultProviderModelSelection(
            targetEnvironmentProviders,
            null,
          ),
        },
      });
      if (createResult._tag === "Failure") {
        recordScientAnalytics(readPreparedConnection(input.environmentId), {
          name: "project.add.failed",
          properties: { stage: "registration" },
        });
        if (!isAtomCommandInterrupted(createResult)) {
          const error = squashAtomCommandFailure(createResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to add project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const createdProjectRef = scopeProjectRef(input.environmentId, projectId);
      if (!canCommitNavigation()) return;
      const projectProjected = await waitForProjectProjection(createdProjectRef);
      if (!canCommitNavigation()) return;
      if (!projectProjected) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Project added but still syncing",
            description: "The project is saved. Select it again after it appears in the sidebar.",
          }),
        );
        setOpen(false);
        return;
      }

      if (initializeProject) {
        void initializeProjectWithFeedback({
          environmentId: input.environmentId,
          root: cwd,
        });
      }

      const navigationResult = await settlePromise(() =>
        handleNewThread(createdProjectRef, { navigationIntent }),
      );
      if (navigationResult._tag === "Failure") {
        recordScientAnalytics(readPreparedConnection(input.environmentId), {
          name: "project.add.failed",
          properties: { stage: "navigation" },
        });
        const error = squashAtomCommandFailure(navigationResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const analyticsConnection = readPreparedConnection(input.environmentId);
      recordScientAnalytics(analyticsConnection, {
        name: "project.added",
        properties: { method: input.analyticsMethod },
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
      setOpen(false);
    },
    [
      handleNewThread,
      createProject,
      environments,
      navigate,
      primaryEnvironmentId,
      projects,
      providers,
      initializeProjectWithFeedback,
      prepareScientProjectForOpening,
      setOpen,
      clientSettings.sidebarThreadSortOrder,
      threads,
      router,
    ],
  );

  const handleAddProject = useCallback(
    async (
      rawCwd: string,
      analyticsMethod: "picker" | "drag-drop" | "recent" | "unknown" = "picker",
    ) => {
      if (!browseEnvironmentId) return;
      await handleAddProjectForEnvironment({
        environmentId: browseEnvironmentId,
        rawCwd,
        platform: browseEnvironmentPlatform,
        currentProjectCwd: currentProjectCwdForBrowse,
        prepared: Option.getOrNull(browsePreparedConnection),
        analyticsMethod,
      });
    },
    [
      browseEnvironmentId,
      browseEnvironmentPlatform,
      browsePreparedConnection,
      currentProjectCwdForBrowse,
      handleAddProjectForEnvironment,
    ],
  );

  function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
    return getAddProjectInitialQueryForEnvironment(environmentId);
  }

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }
    if (!canCreateProjectInEnvironment(browseEnvironment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${browseEnvironment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const provider = remoteProjectSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        const destinationPath = getCloneDestinationPath(
          getDefaultCloneParentPath(addProjectCloneFlow.environmentId),
          getCloneDirectoryName(rawRepository),
        );
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl: rawRepository,
        });
        clearHighlightedItem();
        setQuery(destinationPath);
        setBrowseGeneration((generation) => generation + 1);
        return;
      }

      setIsRemoteProjectLookingUp(true);
      const lookupResult = await lookupRepository({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          provider,
          repository: rawRepository,
        },
      });
      setIsRemoteProjectLookingUp(false);
      if (lookupResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(lookupResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Repository lookup failed",
              description: errorMessage(squashAtomCommandFailure(lookupResult)),
            }),
          );
        }
        return;
      }
      const repository = lookupResult.value;
      const destinationPath = getCloneDestinationPath(
        getDefaultCloneParentPath(addProjectCloneFlow.environmentId),
        getCloneDirectoryName(repository.nameWithOwner),
      );
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: addProjectCloneFlow.environmentId,
        source: addProjectCloneFlow.source,
        repositoryInput: rawRepository,
        repository,
        remoteUrl: repository.sshUrl,
      });
      clearHighlightedItem();
      setQuery(destinationPath);
      setBrowseGeneration((generation) => generation + 1);
      return;
    }

    const rawDestination = (destinationPathInput ?? query).trim();
    if (rawDestination.length === 0 || isRemoteProjectCloning) {
      return;
    }

    if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const destinationPath = resolveProjectPathForDispatch(
      rawDestination,
      currentProjectCwdForBrowse,
    );
    if (destinationPath.length === 0) {
      return;
    }

    setIsRemoteProjectCloning(true);
    const cloneResult = await cloneRepository({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      },
    });
    setIsRemoteProjectCloning(false);
    if (cloneResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(cloneResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: errorMessage(squashAtomCommandFailure(cloneResult)),
          }),
        );
      }
      return;
    }
    await handleAddProject(cloneResult.value.cwd, "unknown");
  }

  const browseTo = useCallback(
    async (name: string): Promise<void> => {
      const nextQuery = pinnedCloneDirectoryName
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: browsePath.directoryPath,
            selectedDirectoryName: name,
            cloneDirectoryName: pinnedCloneDirectoryName,
            caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
          })
        : appendBrowsePathSegment(query, name);
      await browseNavigation.run(
        () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
        () => {
          clearHighlightedItem();
          setIsNewProjectFolderDraft(false);
          setQuery(nextQuery);
          setBrowseGeneration((generation) => generation + 1);
        },
      );
    },
    [
      browseNavigation,
      browseEnvironmentPlatform,
      browsePath.directoryPath,
      pinnedCloneDirectoryName,
      prefetchBrowsePath,
      query,
    ],
  );

  const browseUp = useCallback(async (): Promise<void> => {
    const parentPath = browsePath.parentPath;
    if (parentPath === null) {
      return;
    }

    const nextQuery = getCloneDestinationPath(parentPath, pinnedCloneDirectoryName);
    await browseNavigation.run(
      () => prefetchBrowsePath(parentPath),
      () => {
        clearHighlightedItem();
        setIsNewProjectFolderDraft(false);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  }, [browseNavigation, browsePath.parentPath, pinnedCloneDirectoryName, prefetchBrowsePath]);

  // Resolve the add-project path from browse data when available. When the
  // query has a trailing separator (e.g. "~/projects/foo/"), parentPath is the
  // directory itself. Otherwise the user typed a partial leaf name, so we need
  // the exact browse entry's fullPath or fall back to the raw query.
  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

  const browseGroups = buildBrowseGroups({
    browseEntries: visibleBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const cloneDestinationBrowseGroups = useMemo(
    () =>
      browseGroups.map((group) =>
        group.value === "directories" ? { ...group, label: "Select where to clone" } : group,
      ),
    [browseGroups],
  );

  const remoteProjectContext = useMemo(() => {
    if (addProjectCloneFlow?.step !== "confirm") {
      return null;
    }

    return {
      title: addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput,
      description: addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl,
      icon: remoteProjectSourceIcon(addProjectCloneFlow.source, ITEM_ICON_CLASS),
    };
  }, [addProjectCloneFlow]);

  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }

  const inputPlaceholder =
    remoteProjectInputPlaceholder(addProjectCloneFlow) ??
    getCommandPaletteInputPlaceholder(paletteMode);
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasKeyboardBrowseHighlight =
    !isNewProjectFolderDraft &&
    isKeyboardBrowseHighlight({
      highlightedItemValue,
      highlightReason: highlightedItemReason,
    });
  const hasHighlightedBrowseItem =
    isBrowsing && highlightedItemValue?.startsWith("browse:") === true;
  const canSubmitBrowsePath =
    isBrowsing &&
    !relativePathNeedsActiveProject &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
  const willCreateProjectPath = shouldOfferProjectPathCreation({
    canSubmitBrowsePath,
    isBrowsePending,
    hasBrowseResult: browseResult !== null,
    query,
    hasKeyboardBrowseHighlight,
    hasTrailingPathSeparator: hasTrailingPathSeparator(query),
    exactEntryExists: exactBrowseEntry !== null,
  });
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? "Create & Clone"
      : "Clone"
    : willCreateProjectPath
      ? "Create & Add"
      : "Add";
  const addShortcutLabel = hasKeyboardBrowseHighlight ? `${submitModifierLabel} Enter` : "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? "Continue"
      : "Lookup"
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase) &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    // For a desktop-local (WSL) env, only offer the picker once we have resolved
    // its desktop pool instance id. Without it pickFolder can't be routed to the
    // WSL filesystem and would open the primary (Windows) picker, then add the
    // chosen Windows path against the WSL env -- a wrong-path footgun. Stay
    // hidden until the bootstrap mapping is available rather than mis-routing.
    (browseEnvironmentId === primaryEnvironmentId ||
      (browseEnvironmentIsDesktopLocal && browseDesktopInstanceId !== null)) &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const canDropProjectFolder =
    canOpenProjectFromFileManager &&
    !isCloneDestinationStep &&
    browseEnvironmentId === primaryEnvironmentId &&
    isMatchingLocalPlatform(browseEnvironmentPlatform, navigator.platform) &&
    typeof window.desktopBridge?.getPathForFile === "function";
  const fileManagerInitialPath = useMemo(() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  }, [
    browseDirectoryPath,
    browseResult?.parentPath,
    canOpenProjectFromFileManager,
    currentProjectCwdForBrowse,
    query,
  ]);

  const handleDroppedProjectFolder = useCallback(
    (path: string) => {
      setIsNewProjectFolderDraft(false);
      setQuery(path);
      void handleAddProject(path, "drag-drop");
    },
    [handleAddProject],
  );
  const projectFolderDrop = useProjectFolderDrop({
    enabled: canDropProjectFolder,
    onFolder: handleDroppedProjectFolder,
  });

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleBrowseKeyDownCapture(event: KeyboardEvent<HTMLElement>): void {
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
    if (isCloneDestinationStep) {
      void submitAddProjectCloneFlow(resolvedAddProjectPath);
    } else {
      void handleAddProject(resolvedAddProjectPath);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false },
    });
    if (threadJumpIndexFromCommand(command ?? "") !== null) {
      const matchingItem = displayedGroups
        .flatMap((group) => group.items)
        .find((item) => item.shortcutCommand === command);
      if (matchingItem) {
        event.preventDefault();
        event.stopPropagation();
        executeItem(matchingItem);
        return;
      }
    }

    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = useCallback(async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    let desktopWslState: DesktopWslState | null = null;
    try {
      desktopWslState =
        browseEnvironmentId === primaryEnvironmentId && browseEnvironmentPlatform === "Linux"
          ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
          : null;
      // Route the picker to the browsed env's backend filesystem. The desktop
      // only resolves a "wsl:*" pool instance id, so for a desktop-local env we
      // pass the bootstrap-mapped instance id (not the catalog environmentId).
      // A WSL-only primary has no secondary bootstrap, so resolve its instance
      // id from desktop settings. Windows and combo-mode primaries still omit
      // the target to preserve the native primary picker. The desktop converts
      // a WSL UNC selection back to a Linux path before returning.
      const pickerTargetEnvironmentId = resolveProjectPickerTarget({
        browseEnvironmentId,
        primaryEnvironmentId,
        desktopInstanceId: browseDesktopInstanceId,
        wslConfiguration: desktopWslState,
      });
      const pickerOptions = {
        ...(fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : {}),
        ...(pickerTargetEnvironmentId ? { targetEnvironmentId: pickerTargetEnvironmentId } : {}),
      };
      pickedPath = await api.dialogs.pickFolder(
        Object.keys(pickerOptions).length > 0 ? pickerOptions : undefined,
      );
    } catch {
      // Ignore picker failures and leave the palette open.
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }
    if (parseWslUncPath(pickedPath)) {
      desktopWslState ??= (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
      let primaryRunningDistro: string | null = null;
      try {
        primaryRunningDistro =
          window.desktopBridge
            ?.getLocalEnvironmentBootstraps()
            .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
          null;
      } catch {
        // Keep UNC routing strict when the live primary identity cannot be read.
      }
      const selection = resolveWslProjectSelection(
        pickedPath,
        applyWslEnvironmentConfiguration(
          environments.flatMap((environment) => {
            const backendId = desktopLocalBackendId(environment.entry.target);
            if (!backendId) {
              return [];
            }

            const bootstrap = desktopLocalBootstraps.find(
              (candidate) => candidate.httpBaseUrl === environment.displayUrl,
            );
            const runningDistro = bootstrap?.runningDistro ?? null;
            return [{ environmentId: environment.environmentId, backendId, runningDistro }];
          }),
          primaryEnvironmentId,
          desktopWslState ?? null,
          primaryRunningDistro,
        ),
      );
      if (!selection) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add WSL project",
            description: "Start the matching WSL backend, then choose the folder again.",
          }),
        );
        return;
      }
      await handleAddProjectForEnvironment({
        environmentId: selection.environmentId,
        rawCwd: selection.linuxPath,
        platform: "Linux",
        currentProjectCwd: null,
        prepared:
          selection.environmentId === browseEnvironmentId
            ? Option.getOrNull(browsePreparedConnection)
            : null,
        analyticsMethod: "picker",
      });
      return;
    }
    await handleAddProject(pickedPath);
  }, [
    browseDesktopInstanceId,
    browseEnvironmentId,
    browseEnvironmentPlatform,
    browsePreparedConnection,
    canOpenProjectFromFileManager,
    desktopLocalBootstraps,
    environments,
    fileManagerInitialPath,
    handleAddProject,
    handleAddProjectForEnvironment,
    isPickingProjectFolder,
    primaryEnvironmentId,
  ]);

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
    isBrowsing,
    isCloneDestinationStep,
    relativePathNeedsActiveProject,
  ]);

  const inputAccessory =
    addProjectCloneFlow?.step === "repository" ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 gap-1.5 pe-1 ps-2 -translate-y-1/2"
              aria-label={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
              disabled={!canSubmitRemoteProjectFlow}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                void submitAddProjectCloneFlow();
              }}
            />
          }
        >
          <span>{isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}</span>
          <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
            <Kbd>Enter</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">{remoteProjectButtonLabel ?? "Continue"} (Enter)</TooltipPopup>
      </Tooltip>
    ) : isBrowsing ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className={cn(
                "absolute inset-e-2.5 top-1/2 border-info/32 bg-info/4 pe-1 ps-2 text-info-foreground shadow-none -translate-y-1/2 before:shadow-none [:hover,[data-pressed]]:border-info/45 [:hover,[data-pressed]]:bg-info/8 dark:bg-info/4 dark:[:hover,[data-pressed]]:bg-info/8",
                hasKeyboardBrowseHighlight ? "gap-1" : "gap-1.5",
              )}
              aria-label={`${submitActionLabel} (${addShortcutLabel})`}
              disabled={
                !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
                relativePathNeedsActiveProject ||
                (isCloneDestinationStep && isRemoteProjectPending)
              }
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                if (relativePathNeedsActiveProject) {
                  return;
                }
                if (isCloneDestinationStep) {
                  void submitAddProjectCloneFlow(resolvedAddProjectPath);
                } else {
                  void handleAddProject(resolvedAddProjectPath);
                }
              }}
            />
          }
        >
          <span>
            {isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
          </span>
          <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
            <Kbd>{hasKeyboardBrowseHighlight ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {submitActionLabel} ({addShortcutLabel})
        </TooltipPopup>
      </Tooltip>
    ) : null;

  const footerActionLabel =
    addProjectCloneFlow?.step === "repository"
      ? (remoteProjectButtonLabel ?? "Continue")
      : !canSubmitBrowsePath || hasKeyboardBrowseHighlight
        ? "Select"
        : undefined;

  const canBeginNewProjectFolder =
    isBrowsing && !isCloneDestinationStep && !relativePathNeedsActiveProject;
  const footerTrailing =
    canBeginNewProjectFolder || canOpenProjectFromFileManager ? (
      <div className="ms-auto flex items-center gap-1">
        {canBeginNewProjectFolder ? (
          <Button
            variant="ghost"
            size="xs"
            className="h-auto gap-1.5 px-2 text-xs"
            onClick={beginNewProjectFolder}
          >
            <FolderPlusIcon aria-hidden className="size-3.5" />
            New folder
          </Button>
        ) : null}
        {canOpenProjectFromFileManager ? (
          <Button
            variant="ghost"
            size="xs"
            className="h-auto px-2 text-muted-foreground text-xs hover:bg-transparent hover:text-foreground"
            disabled={isPickingProjectFolder}
            onClick={() => {
              void handleOpenProjectFromFileManager();
            }}
          >
            {`Open in ${fileManagerName}`}
          </Button>
        ) : null}
      </div>
    ) : null;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${addProjectCloneFlow?.step ?? "none"}`}
      aria-label="Command palette"
      autoHighlight={isBrowsing || isRemoteProjectCloneFlow ? false : "always"}
      keepHighlight={!(isBrowsing || isRemoteProjectCloneFlow)}
      containerProps={{
        onDragEnter: projectFolderDrop.onDragEnter,
        onDragLeave: projectFolderDrop.onDragLeave,
        onDragOver: projectFolderDrop.onDragOver,
        onDrop: projectFolderDrop.onDrop,
        onKeyDownCapture: handleBrowseKeyDownCapture,
      }}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        ref: projectPathInputRef,
        className:
          addProjectCloneFlow?.step === "repository"
            ? "*:data-[slot=autocomplete-input]:pe-32!"
            : isBrowsing
              ? browseInputEndPaddingClass({
                  willCreateProjectPath,
                  hasHighlightedBrowseItem,
                })
              : undefined,
        placeholder: inputPlaceholder,
        wrapperClassName: isSubmenu
          ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto"
          : undefined,
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      onItemHighlighted={(value, eventDetails) => {
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
      }}
      onValueChange={handleQueryChange}
      panelClassName="flex max-h-[min(28rem,70vh)] flex-col"
      showBackHint={isSubmenu && !isBrowsing}
      value={query}
    >
      {remoteProjectContext ? (
        <div className="p-2 pb-0">
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Repository</div>
          <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
            {remoteProjectContext.icon}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">{remoteProjectContext.title}</span>
              <span className="truncate text-muted-foreground/85 text-xs">
                {remoteProjectContext.description}
              </span>
            </span>
          </div>
        </div>
      ) : null}
      {canDropProjectFolder ? (
        <ProjectFolderDropTarget
          fileManagerName={fileManagerName}
          isActive={projectFolderDrop.isActive}
          isPicking={isPickingProjectFolder}
          onBrowse={() => {
            void handleOpenProjectFromFileManager();
          }}
        />
      ) : null}
      <CommandPaletteResults
        groups={displayedGroups}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(addProjectCloneFlow?.step === "repository"
          ? {
              emptyStateMessage:
                addProjectCloneFlow.source === "url"
                  ? "Enter a Git clone URL and press Enter to continue."
                  : "Enter a repository path and press Enter to look it up.",
            }
          : addProjectCloneFlow?.step === "confirm"
            ? { emptyStateMessage: "Choose a destination path and press Enter to clone." }
            : relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : threadSearch.isPending
                  ? { emptyStateMessage: "Searching thread messages…" }
                  : {})}
      />
      <ScientProjectInitializationDialog
        inspection={projectInitializationInspection}
        onDecision={handleProjectInitializationDecision}
      />
    </CommandPaletteContent>
  );
}
