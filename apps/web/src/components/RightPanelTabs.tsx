import { msg, T, useGT, useMessages } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  useProjects,
  useQuietThreadShell,
  useServerConfigs,
  useThreadShells,
} from "~/state/entities";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import type {
  ContextMenuItem,
  EnvironmentId,
  IssueTrackerKind,
  PreviewSessionSnapshot,
  ProjectId,
  PullRequestState,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabelsCopy";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Bot,
  CircleDotIcon,
  Smartphone,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  FileText,
  Files,
  Globe,
  Library,
  MessagesSquare,
  Plus,
  Sigma,
  TerminalSquare,
  TriangleAlert,
  Volume2Icon,
  VolumeOffIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import { linkedThreadTitle } from "~/linkedThreadSurface";
import type { RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { issueStatePresentation } from "~/components/issue/issuePresentation";
import { issueEnvironment } from "~/state/issues";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";
import { readLocalApi } from "~/localApi";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { AndroidIcon, AppleIcon } from "~/components/Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Kbd } from "~/components/ui/kbd";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { useTheme } from "~/hooks/useTheme";
import { useDeviceState } from "~/state/device";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import {
  newestPullRequestSummary,
  pullRequestEnvironment,
  useSharedPullRequestSummary,
} from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { ScientRightPanelSurfaceIcon } from "~/scient/rightPanel/ScientRightPanelSurfaceIcon";
import { scientRightPanelSurfaceTitle } from "~/scient/rightPanel/surfaces";
import type { NewDocumentChoice } from "~/scient/documents/NewDocumentMenuItems";
// SCIENT-FORK:START
import { ScientFilesIcon } from "~/scient/rightPanel/ScientRightPanelSurfaceIcon";
import { ScientNewTabButton, ScientSurfaceLauncher } from "~/scient/rightPanel/SurfaceLauncher";
import { SCIENT_PANEL_TAB_CLASS, useScientTabStrip } from "~/scient/rightPanel/tabStrip";
import { canDuplicatePanelSurface } from "~/scient/rightPanel/panelTabCommands";
import { PanelFilesToggle } from "~/scient/rightPanel/PanelFilesColumn";
import { AllTabsMenu } from "~/scient/rightPanel/AllTabsMenu";
import { useTabDragOut } from "~/scient/multiWindow/tabDragOut";
// SCIENT-FORK:END
import { useScientAnalyticsView } from "~/scient/analytics/client";
import { panelViewProperties } from "~/scient/analytics/viewCategories";

import { fileTabTitles } from "./files/filePath";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { previewBridge } from "./preview/previewBridge";
import { dispatchPreviewAction } from "./preview/previewActionBus";
import { preventThumbButtonFocus, takeThumbButtonNavigation } from "./preview/thumbButtons";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import {
  filePathCopyFormats,
  fileSurfacePath,
  type FilePathCopyFormat,
  type FileSurfacePath,
} from "./files/filePathClipboard";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";

export interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  keybindings: ResolvedKeybindingsConfig;
  getShortcutContext: () => ShortcutMatchContext;
  widthStorageKey?: string;
  defaultWidth?: number;
  inlineSize?: PreviewPanelInlineSize;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  environmentId: EnvironmentId | null;
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  /** Verified persistence issues only; ordinary Markdown saves stay quiet. */
  attentionSurfaceIds?: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /** Maps server-local session ids to desktop runtime ids; session ids cannot address desktop operations. */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onRenameDevice?: (surfaceId: string, title: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  /** Moves a subagent, side chat or linked thread tab to the main screen. */
  onOpenInMainView?: (
    surface: Extract<RightPanelSurface, { kind: "thread" | "linked-thread" }>,
  ) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onMoveSurface?: (surfaceId: string, toIndex: number) => void;
  // SCIENT-FORK:START — when set, "+" and its shortcut open the launcher as a tab
  onAddNewTab?: ((options?: { readonly whenEmpty?: boolean }) => void) | undefined;
  /** Opens a second copy of a browser or terminal tab. */
  onDuplicateSurface?: ((surface: RightPanelSurface) => void) | undefined;
  /** Shows a tab in a new app window; `atCursor` puts the window where a dragged tab was dropped. */
  onOpenSurfaceInNewWindow?:
    | ((surface: RightPanelSurface, options?: { readonly atCursor?: boolean }) => void)
    | undefined;
  // SCIENT-FORK:END
  onCopyFilePath: (path: FileSurfacePath, format: FilePathCopyFormat) => void;
  onAddBrowser: () => void;
  /** Keep separate from the DOM click handler so a MouseEvent cannot become a profile id. */
  onAddBrowserInProfile: (profileId: string) => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddAgents: () => void;
  onAddSources: () => void;
  onAddDocuments?: ((format: NewDocumentChoice) => void) | undefined;
  onAddCompute: () => void;

  onAddDevice: () => void;
  /** Absent where side chats are not offered. */
  onAddSideChat?: (() => void) | undefined;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount?: number;
  sourcesAvailable: boolean;
  documentsAvailable?: boolean | undefined;
  computeAvailable: boolean;

  deviceAvailable: boolean;
  sideChatAvailable?: boolean;
  /** Overrides the default reason while side chats are available but cannot start. */
  sideChatDisabledReason?: string | null;
  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;
  children: ReactNode;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

export type PullRequestTabStatusSeed = Pick<PullRequestTabStatus, "state" | "isDraft">;

function shouldOpenDefaultBrowserProfileFromMenuClick(pointerType: string | undefined): boolean {
  return pointerType !== "touch";
}

const SURFACE_DISABLED_REASONS = {
  browser: msg("Browser previews are only available in the Scient desktop app."),
  terminal: msg("Terminal surfaces are unavailable because this thread has no workspace."),
  files: msg("Files are only available when a workspace is open."),
  diff: msg("Diff is only available for server threads in Git repositories."),
  pullRequest: msg("This thread's branch has no pull request yet."),
  pullRequests: msg("This thread has no linked items."),
  agents: msg("Agents are only available from a thread."),
  sources: msg("The Library is only available inside a project workspace."),
  documents: msg("Open a project to create and edit documents."),
  compute: msg("Compute is only available inside a project workspace."),

  device: msg("Devices are only available from a thread."),
  sideChat: msg("Side chats start after the first message."),
} as const;

// Closed keepMounted popups must stop blocking shortcuts once their exit transition ends.
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  "dialog-popup",
  "alert-dialog-popup",
  "command-dialog-popup",
  "menu-popup",
  "select-popup",
  "popover-popup",
  "combobox-popup",
  "autocomplete-popup",
]
  .map((slot) => `[data-slot="${slot}"]:is([data-open],[data-ending-style])`)
  .join(",");

const SURFACE_UNAVAILABLE_HINTS = {
  browser: msg("Only available in the desktop app."),
  terminal: msg("Available when a project is open."),
  files: msg("Available when a project is open."),
  diff: msg("Available for Git repositories."),
  pullRequest: msg("No pull request on this branch yet."),
  pullRequests: msg("No linked items available."),
  device: msg("Available from a thread."),
  sideChat: msg("Available after the first message."),
} as const;

type TabContextMenuAction =
  // SCIENT-FORK:START
  | "open-in-new-window"
  | "duplicate"
  // SCIENT-FORK:END
  | "open-in-main-view"
  | "rename"
  | "copy-relative-path"
  | "copy-full-path"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

const TAB_SCROLL_EDGE_TOLERANCE = 1;
const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null {
  if (surface.kind !== "preview" || !surface.resourceId) return null;
  return sessions[surface.resourceId]?.tabId ?? null;
}

/**
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
function tabMuteMenuItem(
  input: {
    overlay: DesktopPreviewOverlay | null;
    canResolveRuntimeTabId: boolean;
  },
  resolve: MessageResolver = m,
): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? resolve(msg("Unmute tab")) : resolve(msg("Mute tab")),
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

type TabAudioState = "none" | "audible" | "muted";

function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState {
  if (!overlay?.audible) return "none";
  return overlay.audioMuted ? "muted" : "audible";
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
> &
  Partial<Pick<KeyboardEvent, "code" | "getModifierState">>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = surfaceShortcutKey(event);
  return (
    actions.find((action) => action.available && action.shortcut.toLowerCase() === key) ?? null
  );
}

/** Skip contenteditable=false islands to find their editable host, matching the composer typing guard. */
export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return (
    target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !=
    null
  );
}

export function buildTabContextMenuItems(
  input: {
    /** Path forms the tab can copy; empty for non-file tabs and attachments. */
    readonly pathCopyFormats: readonly FilePathCopyFormat[];
    readonly mute: { readonly label: string; readonly disabled: boolean } | null;
    readonly surfaceIndex: number;
    readonly surfaceCount: number;
  },
  resolve: MessageResolver = m,
): readonly ContextMenuItem<TabContextMenuAction>[] {
  const items: ContextMenuItem<TabContextMenuAction>[] = [];
  if (input.pathCopyFormats.includes("relative")) {
    items.push({ id: "copy-relative-path", label: resolve(msg("Copy relative path")) });
  }
  if (input.pathCopyFormats.includes("full")) {
    items.push({ id: "copy-full-path", label: resolve(msg("Copy full path")) });
  }
  if (input.mute) {
    items.push({ id: "toggle-mute", ...input.mute });
  }
  items.push(
    { id: "close", label: resolve(msg("Close")) },
    {
      id: "close-others",
      label: resolve(msg("Close others")),
      disabled: input.surfaceCount <= 1,
    },
    {
      id: "close-to-right",
      label: resolve(msg("Close to the right")),
      disabled: input.surfaceIndex >= input.surfaceCount - 1,
    },
    {
      id: "close-all",
      label: resolve(msg("Close all")),
      disabled: input.surfaceCount === 0,
    },
  );
  return items;
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

/** The kinds of document, each with the words that tell them apart. */
function NewDocumentMenuItems(props: { readonly onChoose: (format: NewDocumentChoice) => void }) {
  return (
    <>
      <MenuItem onClick={() => props.onChoose("markdown")}>
        <span className="flex-1">Markdown</span>
        <span className="ps-3 text-muted-foreground/50 text-xs">
          <T>Notes · Word</T>
        </span>
      </MenuItem>
      <MenuItem onClick={() => props.onChoose("latex")}>
        <span className="flex-1">LaTeX</span>
        <span className="ps-3 text-muted-foreground/50 text-xs">
          <T>Papers · PDF</T>
        </span>
      </MenuItem>
      <MenuItem onClick={() => props.onChoose("notebook")}>
        <span className="flex-1">
          <T>Notebook</T>
        </span>
        <span className="ps-3 text-muted-foreground/50 text-xs">
          <T>Code · Results</T>
        </span>
      </MenuItem>
    </>
  );
}

/**
 * Launcher shortcuts work outside typing contexts; focused arrows/Enter also open surfaces.
 * Unavailable surfaces stay visible with a reason, and highlighting waits for hover or arrow input.
 */
function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddBrowserInProfile: (profileId: string) => void;
  browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddAgents: () => void;
  onAddSources: () => void;
  onAddDocuments?: ((format: NewDocumentChoice) => void) | undefined;
  onAddCompute: () => void;

  onAddDevice: () => void;
  /** Absent where side chats are not offered. */
  onAddSideChat?: (() => void) | undefined;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  agentsAvailable: boolean;
  sourcesAvailable: boolean;
  documentsAvailable?: boolean | undefined;
  computeAvailable: boolean;

  deviceAvailable: boolean;
  sideChatAvailable: boolean;
  sideChatDisabledReason: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [highlight, setHighlight] = useState(-1);
  const [documentsMenuOpen, setDocumentsMenuOpen] = useState(false);

  const actions = [
    {
      label: msg("Library"),
      description: msg("Import and read research sources."),
      icon: Library,
      shortcut: "S",
      available: props.sourcesAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.sources),
      onClick: props.onAddSources,
      badgeCount: 0,
    },
    {
      label: msg("Browser"),
      icon: Globe,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.browser),
      onClick: props.onAddBrowser,
    },
    {
      label: msg("Terminal"),
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.terminal),
      onClick: props.onAddTerminal,
    },
    {
      label: msg("Files"),
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.files),
      onClick: props.onAddFiles,
    },
    {
      label: msg("Diff"),
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.diff),
      onClick: props.onAddDiff,
    },
    {
      label: msg("Pull request"),
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.pullRequest),
      onClick: props.onAddPullRequest,
    },
    {
      label: msg("Linked items"),
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.pullRequests),
      onClick: props.onAddPullRequests,
    },
    {
      label: msg("Device"),
      description: msg("Watch an iOS Simulator or Android Emulator."),
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: messages(SURFACE_UNAVAILABLE_HINTS.device),
      onClick: props.onAddDevice,
    },
    {
      label: msg("Documents"),
      icon: FileText,
      shortcut: "W",
      available: props.documentsAvailable === true && props.onAddDocuments !== undefined,
      disabledReason: messages(SURFACE_DISABLED_REASONS.documents),
      // Opens the format choice anchored to the row, by click or by its letter.
      onClick: () => setDocumentsMenuOpen(true),
      badgeCount: 0,
    },
    ...(props.onAddSideChat
      ? [
          {
            label: msg("Side chat"),
            description: msg("Ask a side question while this thread keeps working."),
            icon: MessagesSquare,
            // SCIENT-FORK:START — S opens Sources in Scient.
            shortcut: "A",
            // SCIENT-FORK:END
            available: props.sideChatAvailable && !props.sideChatDisabledReason,
            disabledReason:
              props.sideChatDisabledReason ?? messages(SURFACE_UNAVAILABLE_HINTS.sideChat),
            onClick: props.onAddSideChat,
          },
        ]
      : []),
  ] as const;

  type SurfaceAction = (typeof actions)[number];

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const action = surfaceShortcutActionForKey(availableActions, event);
    if (!action) return;
    if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
    event.preventDefault();
    event.stopPropagation();
    action.onClick();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a capture-phase window keydown listener for surface shortcuts while the menu is mounted
  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      if (event.target !== event.currentTarget) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  const actionIcon = (action: SurfaceAction, iconClassName = "size-4") => {
    const Icon = action.icon;
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className={iconClassName} />
      </span>
    );
  };

  return (
    <div
      data-workspace-focus-default
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label={gt("Open a surface")}
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "scient-reading-ui scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pt-6 outline-none",
        "pb-(--workspace-topbar-content-padding)",
      )}
    >
      <div className="w-full max-w-xs">
        <h3 className="mb-3 text-center font-medium text-foreground text-sm">
          <T>Open a surface</T>
        </h3>
        <div className="flex flex-col gap-0.5">
          {actions.map((action) =>
            action.available ? (
              <div
                key={action.label}
                className="group relative"
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
              >
                {action.label === "Documents" ? (
                  <Menu open={documentsMenuOpen} onOpenChange={setDocumentsMenuOpen}>
                    <MenuTrigger
                      render={
                        <button
                          type="button"
                          className={cn(
                            "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",
                            (isHighlighted(action) || documentsMenuOpen) && "bg-accent/60",
                          )}
                        />
                      }
                    >
                      {actionIcon(action, "size-4")}
                      <span className="min-w-0 flex-1 truncate">{messages(action.label)}</span>
                      <Kbd>{action.shortcut}</Kbd>
                    </MenuTrigger>
                    <MenuPopup align="start" side="bottom" sideOffset={4} className="min-w-0">
                      <NewDocumentMenuItems onChoose={(format) => props.onAddDocuments?.(format)} />
                    </MenuPopup>
                  </Menu>
                ) : (
                  <button
                    type="button"
                    onClick={action.onClick}
                    className={cn(
                      "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",
                      isHighlighted(action) && "bg-accent/60",
                    )}
                  >
                    {actionIcon(action, "size-4")}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        action.label === "Browser" && props.browserProfiles.length > 1 && "pr-7",
                      )}
                    >
                      {messages(action.label)}
                    </span>
                    <Kbd>{action.shortcut}</Kbd>
                  </button>
                )}
                {/*
                  Same choice the tab bar's "+" menu offers: the row opens the
                  default profile, the chevron picks another. Only worth showing
                  once there is something to choose between.
                */}
                {action.label === "Browser" && props.browserProfiles.length > 1 ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          aria-label={gt("Open browser in a profile")}
                          className="absolute top-1/2 right-8 -translate-y-1/2"
                          size="icon-xs"
                          variant="ghost-muted"
                        />
                      }
                    >
                      <ChevronDown className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="end" side="bottom" sideOffset={6} className="max-w-56">
                      {props.browserProfiles.map((profile) => (
                        <MenuItem
                          key={profile.id}
                          onClick={() => props.onAddBrowserInProfile(profile.id)}
                        >
                          <span className="min-w-0 truncate">{profile.name}</span>
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : null}
              </div>
            ) : (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={
                  <div
                    tabIndex={0}
                    aria-disabled="true"
                    className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50"
                  >
                    {actionIcon(action, "size-4")}
                    <span className="min-w-0 flex-1 truncate">{messages(action.label)}</span>
                    <Kbd>{action.shortcut}</Kbd>
                  </div>
                }
              />
            ),
          )}
        </div>
        {props.computeAvailable ? (
          <div className="mt-3 text-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
                    onClick={props.onAddCompute}
                  />
                }
              >
                <T>Scientific computing</T>
              </TooltipTrigger>
              <TooltipPopup>
                <T>Run scientific code and inspect results and variables</T>
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The file a tab shows, for tabs whose title is that file's name. */
function fileTabPath(surface: RightPanelSurface): string | null {
  if (surface.kind === "file") return surface.attachment ? null : surface.relativePath;
  return surface.kind === "scient" && surface.module === "file" ? surface.path : null;
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
  resolve: MessageResolver = m,
): string {
  switch (surface.kind) {
    case "diff":
      return resolve(msg("Diff"));
    case "files":
      return resolve(msg("Files"));
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) + 1,
      );
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId, resolve)
      );
    case "pull-request":
      return `#${surface.number}`;
    case "pull-requests":
      return resolve(msg("Linked items"));
    case "issue":
      // A git host numbers its issues; a tracker with keys of its own, such as Linear, names them.
      return /^\d+$/.test(surface.key) ? `#${surface.key}` : surface.key;
    case "agents":
      return resolve(msg("Agents"));
    case "scient":
      // SCIENT-FORK: Scient panel titles in the active language.
      return scientRightPanelSurfaceTitle(surface, resolve);

    case "device":
      return surface.title ?? surface.target?.name ?? resolve(msg("Device"));
    case "thread":
      // Until the thread's own title loads.
      return resolve(msg("Thread"));
    case "linked-thread":
      return linkedThreadTitle(
        surface,
        resolve(msg("Thread on {label}", { label: surface.label })),
      );
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return resolve(msg("Browser"));
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || resolve(msg("Browser"));
      } catch {
        return resolve(msg("Browser"));
      }
    }
  }
}

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function previewFaviconOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>,
): { url: string | null; capturedUrl: string | null } {
  const snapshot =
    surface.kind === "preview" && surface.resourceId ? sessions[surface.resourceId] : null;
  const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
  const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null;
  const capturedUrl = favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
  return { url, capturedUrl };
}

function SurfaceIcon({
  surface,
  previewUrl,
  previewCapturedUrl,
  theme,
  environmentId,
  pullRequestStatusSeed,
}: {
  surface: RightPanelSurface;
  previewUrl: string | null;
  previewCapturedUrl: string | null;
  theme: "light" | "dark";
  environmentId: EnvironmentId | null;
  pullRequestStatusSeed: PullRequestTabStatusSeed | undefined;
}) {
  switch (surface.kind) {
    case "preview":
      return <PreviewFavicon capturedUrl={previewCapturedUrl} url={previewUrl} />;
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      // SCIENT-FORK:START — Scient's Files sign, shared with the Files card and the Show files button
      return <ScientFilesIcon className="size-3 shrink-0" />;
    // SCIENT-FORK:END
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "pull-request":
      return (
        <PullRequestSurfaceIcon
          surface={surface}
          environmentId={environmentId}
          seed={pullRequestStatusSeed}
        />
      );
    case "pull-requests":
      return <PullRequestGlyph.link className="size-3 shrink-0" />;
    case "issue":
      return <IssueSurfaceIcon surface={surface} environmentId={environmentId} />;
    case "agents":
      return <Bot className="size-3 shrink-0" />;
    case "scient":
      return <ScientRightPanelSurfaceIcon surface={surface} />;

    case "thread":
      return <SideChatTabIcon environmentId={environmentId} threadId={surface.threadId} />;
    case "linked-thread":
      return <MessagesSquare className="size-3 shrink-0" />;
    case "device":
      return surface.target?.platform === "ios" ? (
        <AppleIcon className="size-3 shrink-0" />
      ) : surface.target?.platform === "android" ? (
        <AndroidIcon className="size-3 shrink-0" />
      ) : (
        <Smartphone className="size-3 shrink-0" />
      );
  }
}

const SIDE_CHAT_STATE_LABELS = {
  "needs approval": msg("needs approval"),
  "needs input": msg("needs input"),
  running: msg("running", { $context: "side chat status" }),
} as const;

/** What a side chat tab's dot shows and its title's accessible name says. */
function sideChatTabState(shell: EnvironmentThreadShell | null) {
  if (shell === null) return null;
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return "needs approval";
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return "needs input";
  }
  return threadRuntimeIsActive(shell.runtime) ? "running" : null;
}

// Static dots: a side chat or subagent tab can stay open for a whole run.
function SideChatTabIcon(props: { environmentId: EnvironmentId | null; threadId: ThreadId }) {
  const shell = useQuietThreadShell(
    props.environmentId === null ? null : scopeThreadRef(props.environmentId, props.threadId),
  );
  const state = sideChatTabState(shell);
  const Icon = shell !== null && shell.lineage.sideChat !== true ? Bot : MessagesSquare;
  return (
    <>
      <Icon className="size-3 shrink-0" />
      {state === null ? null : (
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
            state === "running" ? "bg-muted-foreground" : "bg-info",
          )}
          aria-hidden
        />
      )}
    </>
  );
}

export function resolvePullRequestTabLink(
  threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "pullRequests">[],
  environmentId: EnvironmentId | null,
  host: string | null,
  reference: { repository: string; number: number },
) {
  if (environmentId === null || host === null) return undefined;
  // Keys are cached per object, so one target normalizes once instead of once per link.
  const target = { host, repository: reference.repository, number: reference.number };
  let newest: EnvironmentThreadShell["pullRequests"][number] | undefined;
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      if (!threadPullRequestKeysEqual(link, target)) continue;
      if (
        newest === undefined ||
        (link.snapshot?.syncedAt ?? "") > (newest.snapshot?.syncedAt ?? "")
      )
        newest = link;
    }
  }
  return newest;
}

/** The issue's own state mark, from the detail its panel already reads; a plain dot until then. */
function IssueSurfaceIcon({
  surface,
  environmentId,
}: {
  surface: Extract<RightPanelSurface, { kind: "issue" }>;
  environmentId: EnvironmentId | null;
}) {
  const resolvedEnvironmentId =
    (surface.environmentId as EnvironmentId | undefined) ?? environmentId;
  const detail = useEnvironmentQuery(
    resolvedEnvironmentId === null
      ? null
      : issueEnvironment.detail({
          environmentId: resolvedEnvironmentId,
          input: {
            projectId: surface.projectId as ProjectId,
            tracker: surface.tracker as IssueTrackerKind,
            ...(surface.host ? { host: surface.host } : {}),
            scope: surface.scope,
            key: surface.key,
          },
        }),
  ).data;
  if (detail === null) return <CircleDotIcon className="size-3 shrink-0" />;
  const presentation = issueStatePresentation(detail.state);
  return (
    <presentation.Icon
      role="img"
      aria-label={presentation.label}
      className={cn("size-3 shrink-0", presentation.toneClassName)}
    />
  );
}

function PullRequestSurfaceIcon({
  surface,
  environmentId,
  seed,
}: {
  surface: Extract<RightPanelSurface, { kind: "pull-request" }>;
  environmentId: EnvironmentId | null;
  seed: PullRequestTabStatusSeed | undefined;
}) {
  const resolvedEnvironmentId =
    (surface.environmentId as EnvironmentId | undefined) ?? environmentId;
  const projects = useProjects();
  const threads = useThreadShells();
  const project = projects.find(
    (entry) => entry.environmentId === resolvedEnvironmentId && entry.id === surface.projectId,
  );
  const identity = project?.repositoryIdentity;
  const host =
    surface.host ??
    (identity?.provider
      ? sourceControlClients.changeRequestHost(identity, identity.provider)
      : null);
  const configs = useServerConfigs();
  const capabilities =
    resolvedEnvironmentId === null
      ? undefined
      : configs.get(resolvedEnvironmentId)?.environment.capabilities;
  const linkedSnapshot =
    capabilities !== undefined
      ? (resolvePullRequestTabLink(threads, resolvedEnvironmentId, host, surface)?.snapshot ?? null)
      : null;
  const detail = useEnvironmentQuery(
    resolvedEnvironmentId === null || capabilities === undefined || linkedSnapshot !== null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: resolvedEnvironmentId,
          input: {
            projectId: surface.projectId as ProjectId,
            ...(capabilities !== undefined && surface.host !== undefined
              ? { host: surface.host }
              : {}),
            repository: surface.repository,
            number: surface.number,
            allowStale: false,
          },
        }),
  ).data;
  const reference = {
    projectId: surface.projectId as ProjectId,
    repository: surface.repository,
    number: surface.number,
  };
  const sharedSummary = useSharedPullRequestSummary(resolvedEnvironmentId, reference);
  const status = linkedSnapshot ?? newestPullRequestSummary(detail, sharedSummary) ?? seed ?? null;
  if (status === null) {
    return <PullRequestGlyph.pullRequest className="size-3 shrink-0 text-muted-foreground" />;
  }
  const presentation = resolvePullRequestState({
    state: status.state,
    isDraft: status.isDraft ?? detail?.isDraft ?? seed?.isDraft ?? false,
  });
  return <presentation.Icon className={cn("size-3 shrink-0", presentation.toneClassName)} />;
}

function SortableTabList(props: {
  surfaces: readonly RightPanelSurface[];
  onMove: ((surfaceId: string, toIndex: number) => void) | undefined;
  // SCIENT-FORK:START — a tab dropped outside the app window opens in a window of its own
  onOpenInNewWindow: RightPanelTabsProps["onOpenSurfaceInNewWindow"];
  // SCIENT-FORK:END
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const surfaceIds = props.surfaces.map((surface) => surface.id);
  const { onMove, surfaces } = props;
  // SCIENT-FORK:START
  const dragOut = useTabDragOut(surfaces, props.onOpenInNewWindow);
  // SCIENT-FORK:END
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = surfaces.findIndex((surface) => surface.id === over.id);
    if (toIndex >= 0) onMove?.(String(active.id), toIndex);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={TAB_DRAG_MODIFIERS}
      // SCIENT-FORK:START — the tab strip's drag handlers also open a tab dropped outside the window
      {...dragOut.handlers(handleDragEnd)}
      // SCIENT-FORK:END
    >
      <SortableContext items={surfaceIds} strategy={horizontalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

interface RightPanelTabHandlers {
  onActivate: (surface: RightPanelSurface) => void;
  onClose: (surface: RightPanelSurface) => void;
  onAuxClick: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onContextMenu: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onStartRename: (surfaceId: string) => void;
  onFinishRename: (surfaceId: string, title: string) => void;
}

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventTabMiddleButtonDefault(event: ReactMouseEvent) {
  if (event.button !== 1) return;
  event.preventDefault();
}

// Stable handlers and per-tab values let the compiler reuse tabs across parent renders.
function RightPanelTab(
  props: RightPanelTabHandlers & {
    surface: RightPanelSurface;
    dragDisabled: boolean;
    active: boolean;
    pending: boolean;
    // SCIENT-FORK:START — file persistence attention and delegated-agent activity.
    attention: boolean;
    liveAgentCount: number;
    // SCIENT-FORK:END
    title: string;
    audio: TabAudioState;
    audioRuntimeTabId: string | null;
    previewUrl: string | null;
    previewCapturedUrl: string | null;
    theme: "light" | "dark";
    environmentId: EnvironmentId | null;
    pullRequestStatusSeed: PullRequestTabStatusSeed | undefined;
    renaming: boolean;
    canRename: boolean;
    ownsDesktopTitleBar: boolean;
  },
) {
  const gt = useGT();
  const messages = useMessages();
  const {
    surface,
    audio,
    audioRuntimeTabId,
    onActivate,
    onClose,
    onAuxClick,
    onContextMenu,
    onStartRename,
    onFinishRename,
  } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
    disabled: props.dragDisabled,
  });
  const sideChatShell = useQuietThreadShell(
    surface.kind === "thread" && props.environmentId !== null
      ? scopeThreadRef(props.environmentId, surface.threadId)
      : null,
  );
  const title =
    sideChatShell === null
      ? props.title
      : sideChatShell.lineage.sideChat === true
        ? sideChatShell.title
        : formatSubagentDisplayTitle(sideChatShell.title);
  const sideChatState = sideChatTabState(sideChatShell);
  const content = (
    <>
      <PanelTabCloseButton label={gt("Close {title}", { title })} onClick={() => onClose(surface)}>
        <SurfaceIcon
          surface={surface}
          previewUrl={props.previewUrl}
          previewCapturedUrl={props.previewCapturedUrl}
          theme={props.theme}
          environmentId={props.environmentId}
          pullRequestStatusSeed={props.pullRequestStatusSeed}
        />
        {props.pending ? (
          <span
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
            aria-hidden
          />
        ) : null}
      </PanelTabCloseButton>
      {/* SCIENT-FORK:START — show background agent work on its tab */}
      {surface.kind === "agents" && !props.active && props.liveAgentCount > 0 ? (
        <span
          className="text-3xs tabular-nums text-info"
          aria-label={gt(
            "{count, plural, one {{count} agent working} other {{count} agents working}}",
            { count: props.liveAgentCount },
          )}
        >
          {props.liveAgentCount}
        </span>
      ) : null}
      {/* SCIENT-FORK:END */}
      {audio === "none" || !audioRuntimeTabId ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="cursor-pointer flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                aria-label={
                  audio === "muted"
                    ? gt("Unmute {title}", { title })
                    : gt("Mute {title}", { title })
                }
                onClick={(event) => {
                  event.stopPropagation();
                  void previewBridge
                    ?.setAudioMuted(audioRuntimeTabId, audio !== "muted")
                    .catch(() => undefined);
                }}
              >
                {audio === "muted" ? (
                  <VolumeOffIcon className="size-3" />
                ) : (
                  <Volume2Icon className="size-3" />
                )}
              </button>
            }
          />
          <TooltipPopup>{audio === "muted" ? gt("Unmute tab") : gt("Mute tab")}</TooltipPopup>
        </Tooltip>
      )}
      {props.renaming ? (
        <input
          aria-label={gt("Device tab name")}
          className="w-24 min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-inset ring-ring"
          defaultValue={title}
          ref={(element) => {
            element?.focus();
            element?.select();
          }}
          onBlur={(event) => onFinishRename(surface.id, event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onDoubleClick={() => {
                  if (surface.kind === "device" && props.canRename) onStartRename(surface.id);
                }}
                className="cursor-pointer flex min-w-0 flex-1 items-center"
                aria-label={
                  props.attention
                    ? gt("{title}: changes need attention", { title })
                    : sideChatState === null
                      ? undefined
                      : gt("{title}, {state}", {
                          title,
                          state: messages(SIDE_CHAT_STATE_LABELS[sideChatState]),
                        })
                }
                onClick={() => onActivate(surface)}
              >
                {/* SCIENT-FORK:START — preserve automatic direction and persistence attention */}
                <span className="min-w-0 flex-1 truncate text-start" dir="auto">
                  {title}
                </span>
                {props.attention ? (
                  <TriangleAlert
                    className="ml-1 size-3 shrink-0 text-warning dark:text-warning"
                    aria-hidden
                  />
                ) : null}
                {/* SCIENT-FORK:END */}
              </button>
            }
          />
          <TooltipPopup className="text-start" dir="auto">
            {surface.kind === "device" ? (
              <DeviceTabTooltip
                surface={surface}
                environmentId={props.environmentId}
                title={title}
              />
            ) : (
              title
            )}
          </TooltipPopup>
        </Tooltip>
      )}
    </>
  );
  return (
    <div
      data-active-tab={props.active}
      dir="auto"
      onMouseDown={preventTabMiddleButtonDefault}
      onMouseUp={preventTabMiddleButtonDefault}
      onAuxClick={(event) => onAuxClick(event, surface)}
      onContextMenu={(event) => onContextMenu(event, surface)}
      {...listeners}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
        // SCIENT-FORK:START — Scient's tab look (scient/rightPanel/tabStrip)
        SCIENT_PANEL_TAB_CLASS,
        // SCIENT-FORK:END
        props.ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        isDragging && "relative z-10",
      )}
    >
      {content}
    </div>
  );
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const gt = useGT();
  const messages = useMessages();
  const focusedSurface = props.surfaces.find((surface) => surface.id === props.activeSurfaceId);
  const analyticsSurface = props.open === false ? undefined : focusedSurface;
  useScientAnalyticsView(
    analyticsSurface
      ? { name: "panel.viewed", properties: panelViewProperties(analyticsSurface) }
      : null,
    analyticsSurface?.kind === "pull-request" && analyticsSurface.environmentId
      ? (analyticsSurface.environmentId as EnvironmentId)
      : props.environmentId,
    analyticsSurface?.id,
  );
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const browserProfiles = useBrowserDefaults().profiles;
  // SCIENT-FORK:START — the launcher as a New tab, and one for an open, empty panel
  const { activeSurface, activeNewTab, showsLauncher, activeSurfaceKey } = useScientTabStrip(props);
  // SCIENT-FORK:END
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  // Files with the same name get the folder that tells them apart.
  const fileTitles = fileTabTitles(
    props.surfaces.flatMap((surface) => {
      const path = fileTabPath(surface);
      return path === null ? [] : [path];
    }),
  );
  const addSurfaceTriggerRef = useRef<HTMLButtonElement>(null);
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);
  const [documentsSubmenuOpen, setDocumentsSubmenuOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });

  if (props.open === false && addSurfaceMenuOpen) setAddSurfaceMenuOpen(false);

  const addSurfaceMenuBlocked = () =>
    !addSurfaceMenuOpen && document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS) !== null;
  const onNewSurfaceKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (
      resolveShortcutCommand(event, props.keybindings, {
        context: { ...props.getShortcutContext(), rightPanelOpen: true },
      }) !== "rightPanel.new"
    )
      return;
    if (addSurfaceMenuBlocked()) return;
    event.preventDefault();
    event.stopPropagation();
    // SCIENT-FORK:START
    if (props.onAddNewTab) {
      if (!event.repeat) props.onAddNewTab();
      return;
    }
    // SCIENT-FORK:END
    if (!event.repeat) {
      addSurfaceTriggerRef.current?.focus();
      setAddSurfaceMenuOpen(true);
    }
  });
  // Forwarded from a focused browser page. Focusing the trigger here would let ChatView's
  // window-focus handler see a plain button and refocus the composer, closing the menu.
  const onMenuAction = useEffectEvent((action: string) => {
    if (action === "rightPanel.new" && !addSurfaceMenuBlocked()) setAddSurfaceMenuOpen(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes document keydown and the desktop menu action (forwarded from a focused browser page) for the new surface shortcut while the panel is open
  useEffect(() => {
    if (props.open === false) return;
    document.addEventListener("keydown", onNewSurfaceKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction(onMenuAction);
    return () => {
      document.removeEventListener("keydown", onNewSurfaceKeyDown, true);
      unsubscribe?.();
    };
  }, [props.open]);

  const updateTabScrollState = (viewport: HTMLDivElement) => {
    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollLeft = hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
    setTabScrollState((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.canScrollLeft === canScrollLeft &&
        current.canScrollRight === canScrollRight
      ) {
        return current;
      }
      return { hasOverflow, canScrollLeft, canScrollRight };
    });
  };

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const addSurfaceActions = [
    {
      label: msg("Library"),
      icon: Library,
      shortcut: "S",
      available: props.sourcesAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.sources),
      onClick: props.onAddSources,
    },
    {
      label: msg("Browser"),
      icon: Globe,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.browser),
      onClick: props.onAddBrowser,
    },
    {
      label: msg("Terminal"),
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.terminal),
      onClick: props.onAddTerminal,
    },
    {
      label: msg("Files"),
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.files),
      onClick: props.onAddFiles,
    },
    {
      label: msg("Diff"),
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.diff),
      onClick: props.onAddDiff,
    },
    {
      label: msg("Pull request"),
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.pullRequest),
      onClick: props.onAddPullRequest,
    },
    {
      label: msg("Linked items"),
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.pullRequests),
      onClick: props.onAddPullRequests,
    },
    {
      label: msg("Device"),
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: messages(SURFACE_DISABLED_REASONS.device),
      onClick: props.onAddDevice,
    },
    {
      label: msg("Documents"),
      icon: FileText,
      shortcut: "W",
      available: props.documentsAvailable === true && props.onAddDocuments !== undefined,
      disabledReason: messages(SURFACE_DISABLED_REASONS.documents),
      // Its letter opens the format choice; the menu stays open for it.
      onClick: () => setDocumentsSubmenuOpen(true),
      badgeCount: 0,
    },
    ...(props.onAddSideChat
      ? [
          {
            label: msg("Side chat"),
            icon: MessagesSquare,
            // SCIENT-FORK:START — S opens Sources in Scient.
            shortcut: "A",
            // SCIENT-FORK:END
            available: props.sideChatAvailable === true && !props.sideChatDisabledReason,
            disabledReason:
              props.sideChatDisabledReason ?? messages(SURFACE_DISABLED_REASONS.sideChat),
            onClick: props.onAddSideChat,
          },
        ]
      : []),
  ] as const;

  const extraSessionAction = {
    label: msg("Scientific computing"),
    icon: Sigma,
    shortcut: "C",
    available: props.computeAvailable,
    disabledReason: messages(SURFACE_DISABLED_REASONS.compute),
    onClick: props.onAddCompute,
  } as const;

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(
      [...addSurfaceActions, extraSessionAction],
      event.nativeEvent,
    );
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.label !== "Documents") setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabContextMenu = async (event: ReactMouseEvent, surface: RightPanelSurface) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) return;

    const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;

    const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions);
    const menuOverlay = menuPreviewTabId ? (props.desktopByTabId[menuPreviewTabId] ?? null) : null;
    const menuMuted = menuOverlay?.audioMuted ?? false;
    const menuFilePath = surface.kind === "file" ? fileSurfacePath(surface) : null;
    const items: readonly ContextMenuItem<TabContextMenuAction>[] = [
      // SCIENT-FORK:START
      ...(props.onOpenSurfaceInNewWindow
        ? ([{ id: "open-in-new-window", label: gt("Open in new window") }] as const)
        : []),
      ...(props.onDuplicateSurface &&
      canDuplicatePanelSurface(surface, { browserAvailable: props.browserAvailable })
        ? ([{ id: "duplicate", label: gt("Duplicate") }] as const)
        : []),
      // SCIENT-FORK:END
      ...((surface.kind === "thread" || surface.kind === "linked-thread") && props.onOpenInMainView
        ? ([{ id: "open-in-main-view", label: gt("Open in main view") }] as const)
        : []),
      ...(surface.kind === "device" && props.onRenameDevice
        ? ([{ id: "rename", label: gt("Rename") }] as const)
        : []),
      ...buildTabContextMenuItems(
        {
          pathCopyFormats: filePathCopyFormats(menuFilePath),
          // Not gated on audibility: silencing a quiet tab ahead of time is the
          // point, so the item is offered whenever the tab is mutable at all.
          mute:
            surface.kind === "preview"
              ? tabMuteMenuItem(
                  {
                    overlay: menuOverlay,
                    canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
                  },
                  messages,
                )
              : null,
          surfaceIndex,
          surfaceCount: props.surfaces.length,
        },
        messages,
      ),
    ];

    const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    switch (action) {
      case "open-in-main-view":
        if (surface.kind === "thread" || surface.kind === "linked-thread") {
          props.onOpenInMainView?.(surface);
        }
        break;
      // SCIENT-FORK:START
      case "open-in-new-window":
        props.onOpenSurfaceInNewWindow?.(surface);
        break;
      case "duplicate":
        props.onDuplicateSurface?.(surface);
        break;
      // SCIENT-FORK:END
      case "rename":
        if (surface.kind === "device") setRenamingDevice(surface.id);
        break;
      case "copy-relative-path":
        if (menuFilePath) props.onCopyFilePath(menuFilePath, "relative");
        break;
      case "copy-full-path":
        if (menuFilePath) props.onCopyFilePath(menuFilePath, "full");
        break;
      case "toggle-mute": {
        const runtimeTabId =
          menuPreviewTabId && menuOverlay
            ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
            : null;
        if (runtimeTabId) {
          void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
        }
        break;
      }
      case "close":
        props.onCloseSurface(surface);
        break;
      case "close-others":
        props.onCloseOtherSurfaces(surface);
        break;
      case "close-to-right":
        props.onCloseSurfacesToRight(surface);
        break;
      case "close-all":
        props.onCloseAllSurfaces();
        break;
      case null:
        break;
    }
  };
  const handleTabAuxClick = (event: ReactMouseEvent, surface: RightPanelSurface) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    props.onCloseSurface(surface);
  };
  const onActivateTab = useStableCallback(props.onActivate);
  const onCloseTab = useStableCallback(props.onCloseSurface);
  const onTabAuxClick = useStableCallback(handleTabAuxClick);
  const onTabContextMenu = useStableCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      void handleTabContextMenu(event, surface);
    },
  );
  const onStartRenameTab = useStableCallback((surfaceId: string) => setRenamingDevice(surfaceId));
  const onFinishRenameTab = useStableCallback((surfaceId: string, title: string) => {
    props.onRenameDevice?.(surfaceId, title);
    setRenamingDevice(null);
  });

  // A newly active tab, or tabs that start overflowing, can sit outside the scrolled strip.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the active tab DOM node into view after it changes or the tab strip starts overflowing
  useEffect(() => {
    if (!props.activeSurfaceId || !tabScrollState.hasOverflow) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId, tabScrollState.hasOverflow]);

  const attachTabList = (root: HTMLDivElement | null) => {
    tabListRef.current = root;
    const viewport = tabScrollViewport(root);
    if (!viewport) return;

    const update = () => updateTabScrollState(viewport);
    // Only a vertical mouse wheel is translated. Horizontal input scrolls natively, since
    // consuming it keeps Chromium from starting the gesture scroll that swipe navigation tracks.
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;

      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
      update();
    };

    const content = viewport.firstElementChild;
    const stopObserving = observeResize(content ? [viewport, content] : viewport, update);
    viewport.addEventListener("scroll", update, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    update();

    return () => {
      tabListRef.current = null;
      stopObserving();
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("wheel", handleWheel);
    };
  };

  return (
    <PreviewPanelShell
      workspaceArea
      workspaceFocusKey={`panel:${props.environmentId}:${props.activeSurfaceId ?? "empty"}`}
      workspaceLabel={
        focusedSurface
          ? gt("Workspace panel: {title}", {
              title: surfaceTitle(
                focusedSurface,
                props.previewSessions,
                props.terminalLabelsById,
                messages,
              ),
            })
          : gt("Workspace panel")
      }
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
      {...(props.inlineSize ? { inlineSize: props.inlineSize } : {})}
      onMouseDown={preventThumbButtonFocus}
      onMouseUp={(event) =>
        takeThumbButtonNavigation(
          event,
          focusedSurface?.kind === "preview" ? dispatchPreviewAction : undefined,
        )
      }
    >
      <div
        className={cn(
          "scient-reading-ui flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "drag-region",
          ownsDesktopTitleBar &&
            (props.layoutControls
              ? "wco:pr-(--workspace-native-controls-inset)"
              : "wco:pr-(--workspace-native-controls-inset-wide)"),
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          // SCIENT-FORK:START — a grey tab strip; the open tab rests on its lower edge
          props.onAddNewTab && "bg-sidebar pl-0",
          // SCIENT-FORK:END
        )}
        // SCIENT-FORK:START
        data-scient-tabstrip={
          props.onAddNewTab ? (showsLauncher ? "launcher" : "content") : undefined
        }
        // SCIENT-FORK:END
        data-right-panel-tabbar
      >
        <ScrollArea
          radius="none"
          ref={attachTabList}
          hideScrollbars
          scrollFade
          // SCIENT-FORK:START — with "+" outside it, the list hugs its tabs
          className={cn(
            "min-w-0",
            props.onAddNewTab ? "h-full w-auto flex-initial" : "flex-1",
            ownsDesktopTitleBar && tabScrollState.hasOverflow && "[-webkit-app-region:no-drag]",
          )}
          // SCIENT-FORK:END
          data-right-panel-tab-list
        >
          {/* SCIENT-FORK:START — tabs shrink to fit before anything scrolls, with room
              for the open tab's outward curves */}
          <div
            className={
              props.onAddNewTab
                ? "flex h-full w-full items-center gap-1 px-2.5"
                : "flex h-full w-max min-w-full items-center gap-1"
            }
          >
            {/* SCIENT-FORK:END */}
            {/* SCIENT-FORK:START — a tab dropped outside the window opens in a window of its own */}
            <SortableTabList
              surfaces={props.surfaces}
              onMove={props.onMoveSurface}
              onOpenInNewWindow={props.onOpenSurfaceInNewWindow}
            >
              {/* SCIENT-FORK:END */}
              {props.surfaces.map((surface) => {
                const previewTabId = previewTabIdOf(surface, props.previewSessions);
                const favicon = previewFaviconOf(
                  surface,
                  props.previewSessions,
                  props.desktopByTabId,
                );
                return (
                  <RightPanelTab
                    key={surface.id}
                    surface={surface}
                    dragDisabled={!props.onMoveSurface || renamingDevice === surface.id}
                    active={surface.id === props.activeSurfaceId}
                    pending={props.pendingSurfaceIds.has(surface.id)}
                    // SCIENT-FORK:START — preserve disambiguated file titles and attention across tab extraction.
                    title={
                      fileTitles.get(fileTabPath(surface) ?? "") ??
                      surfaceTitle(
                        surface,
                        props.previewSessions,
                        props.terminalLabelsById,
                        messages,
                      )
                    }
                    attention={
                      surface.id !== props.activeSurfaceId &&
                      (props.attentionSurfaceIds?.has(surface.id) ?? false)
                    }
                    liveAgentCount={props.liveAgentCount ?? 0}
                    // SCIENT-FORK:END
                    audio={tabAudioState(
                      previewTabId ? (props.desktopByTabId[previewTabId] ?? null) : null,
                    )}
                    audioRuntimeTabId={
                      previewTabId ? (props.previewRuntimeTabId?.(previewTabId) ?? null) : null
                    }
                    previewUrl={favicon.url}
                    previewCapturedUrl={favicon.capturedUrl}
                    theme={resolvedTheme}
                    environmentId={props.environmentId}
                    pullRequestStatusSeed={props.pullRequestStatusSeeds?.[surface.id]}
                    renaming={renamingDevice === surface.id}
                    canRename={props.onRenameDevice !== undefined}
                    ownsDesktopTitleBar={ownsDesktopTitleBar}
                    onActivate={onActivateTab}
                    onClose={onCloseTab}
                    onAuxClick={onTabAuxClick}
                    onContextMenu={onTabContextMenu}
                    onStartRename={onStartRenameTab}
                    onFinishRename={onFinishRenameTab}
                  />
                );
              })}
            </SortableTabList>
            {/* SCIENT-FORK:START */}
            {props.open !== false && !props.onAddNewTab ? (
              /* SCIENT-FORK:END */
              <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
                <MenuTrigger
                  ref={addSurfaceTriggerRef}
                  render={
                    <Button
                      aria-label={gt("Add panel surface")}
                      className="shrink-0"
                      size="icon-xs"
                      variant="ghost-muted"
                    />
                  }
                >
                  <Plus className="size-3.5" />
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                >
                  {addSurfaceActions.map((action) => {
                    const Icon = action.icon;
                    if (action.label === "Browser" && action.available) {
                      return (
                        <MenuSub key={action.label}>
                          <MenuSubTrigger
                            className="[&>svg:last-child]:ms-0"
                            aria-keyshortcuts={action.shortcut}
                            onClick={(event) => {
                              const pointerType =
                                "pointerType" in event.nativeEvent &&
                                typeof event.nativeEvent.pointerType === "string"
                                  ? event.nativeEvent.pointerType
                                  : undefined;
                              if (!shouldOpenDefaultBrowserProfileFromMenuClick(pointerType))
                                return;
                              setAddSurfaceMenuOpen(false);
                              action.onClick();
                            }}
                          >
                            <Icon />
                            {messages(action.label)}
                            <MenuShortcut>{action.shortcut}</MenuShortcut>
                          </MenuSubTrigger>
                          <MenuSubPopup className="max-w-56">
                            {browserProfiles.map((profile) => (
                              <MenuItem
                                key={profile.id}
                                onClick={() => props.onAddBrowserInProfile(profile.id)}
                              >
                                <span className="min-w-0 truncate">{profile.name}</span>
                              </MenuItem>
                            ))}
                          </MenuSubPopup>
                        </MenuSub>
                      );
                    }
                    if (action.label === "Documents" && action.available) {
                      return (
                        <MenuSub
                          key={action.label}
                          open={documentsSubmenuOpen}
                          onOpenChange={setDocumentsSubmenuOpen}
                        >
                          <MenuSubTrigger aria-keyshortcuts={action.shortcut}>
                            <Icon />
                            {action.label}
                            <MenuShortcut>{action.shortcut}</MenuShortcut>
                          </MenuSubTrigger>
                          <MenuSubPopup className="min-w-0">
                            <NewDocumentMenuItems
                              onChoose={(format) => {
                                setAddSurfaceMenuOpen(false);
                                props.onAddDocuments?.(format);
                              }}
                            />
                          </MenuSubPopup>
                        </MenuSub>
                      );
                    }
                    return (
                      <SurfaceMenuItem
                        key={action.label}
                        available={action.available}
                        disabledReason={action.disabledReason}
                        shortcut={action.shortcut}
                        onClick={action.onClick}
                      >
                        <Icon />
                        {messages(action.label)}
                      </SurfaceMenuItem>
                    );
                  })}
                  <MenuSeparator />
                  <SurfaceMenuItem
                    available={extraSessionAction.available}
                    disabledReason={extraSessionAction.disabledReason}
                    shortcut={extraSessionAction.shortcut}
                    onClick={extraSessionAction.onClick}
                  >
                    <Sigma />
                    <T>Scientific computing</T>
                  </SurfaceMenuItem>
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {/* SCIENT-FORK:START — "+" stays in view beside the tabs while they scroll */}
        {props.open !== false && props.onAddNewTab ? (
          <>
            <ScientNewTabButton
              onClick={() => props.onAddNewTab?.()}
              keybindings={props.keybindings}
            />
            {tabScrollState.hasOverflow ? null : <div className="min-w-0 flex-1" />}
          </>
        ) : null}
        {/* SCIENT-FORK:END */}
        {/* SCIENT-FORK:START — one list of every tab instead of scroll arrows */}
        {props.onAddNewTab && tabScrollState.hasOverflow ? (
          <AllTabsMenu
            tabs={props.surfaces}
            activeId={props.activeSurfaceId}
            titleOf={(surface) =>
              fileTitles.get(fileTabPath(surface) ?? "") ??
              surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)
            }
            onSelect={props.onActivate}
            onClose={props.onCloseSurface}
          />
        ) : null}
        {tabScrollState.hasOverflow && !props.onAddNewTab ? (
          /* SCIENT-FORK:END */
          <div
            className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
            role="group"
            data-panel-tabs-scroll=""
            aria-label={gt("Scroll panel tabs")}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label={gt("Scroll tabs left")}
                      disabled={!tabScrollState.canScrollLeft}
                      onClick={() => scrollTabs(-1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronLeft />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>
                <T>Scroll tabs left</T>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label={gt("Scroll tabs right")}
                      disabled={!tabScrollState.canScrollRight}
                      onClick={() => scrollTabs(1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronRight />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>
                <T>Scroll tabs right</T>
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {/* SCIENT-FORK:START — the file list beside the open tab */}
        {props.open !== false && props.onAddNewTab ? (
          <PanelFilesToggle surface={activeSurface} keybindings={props.keybindings} />
        ) : null}
        {/* SCIENT-FORK:END */}
        {props.layoutControls}
        {ownsDesktopTitleBar ? (
          <span
            aria-hidden
            className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
          />
        ) : null}
      </div>
      {/* SCIENT-FORK:START — lets Scient's stylesheet even out where pages start; the
          opening tag spreads over lines to carry it */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
        data-scient-surface={activeSurfaceKey}
      >
        {/* SCIENT-FORK:END */}
        {/* SCIENT-FORK:START — Scient's launcher page, for an empty panel and the New tab */}
        {props.onAddNewTab && showsLauncher ? (
          <ScientSurfaceLauncher
            // The panel's openers and what is available, under the launcher's names.
            {...props}
            {...(activeNewTab ? { onPicked: () => props.onCloseSurface(activeNewTab) } : {})}
          />
        ) : /* SCIENT-FORK:END */ props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddBrowserInProfile={props.onAddBrowserInProfile}
            browserProfiles={browserProfiles}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddPullRequests={props.onAddPullRequests}
            onAddAgents={props.onAddAgents}
            onAddSources={props.onAddSources}
            onAddDocuments={props.onAddDocuments}
            onAddCompute={props.onAddCompute}

            onAddDevice={props.onAddDevice}
            onAddSideChat={props.onAddSideChat}
            browserAvailable={props.browserAvailable}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            pullRequestAvailable={props.pullRequestAvailable}
            pullRequestsAvailable={props.pullRequestsAvailable}
            agentsAvailable={props.agentsAvailable}
            sourcesAvailable={props.sourcesAvailable}
            documentsAvailable={props.documentsAvailable}
            computeAvailable={props.computeAvailable}

            deviceAvailable={props.deviceAvailable}
            sideChatAvailable={props.sideChatAvailable === true}
            sideChatDisabledReason={props.sideChatDisabledReason ?? null}
          />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}

function DeviceTabTooltip(props: {
  surface: Extract<RightPanelSurface, { kind: "device" }>;
  environmentId: EnvironmentId | null;
  title: string;
}) {
  const gt = useGT();
  const target = props.surface.target;
  const { state } = useDeviceState(target ? props.environmentId : null);
  const device = target
    ? state.devices.find((entry) => entry.hostId === target.hostId && entry.id === target.deviceId)
    : undefined;
  const host = target ? state.hosts.find((entry) => entry.id === target.hostId) : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <span>{props.title}</span>
      {target ? (
        <span className="text-muted-foreground">
          {host?.label ?? gt("Device host")} ·{" "}
          {device?.version ?? (target.platform === "ios" ? "iOS" : "Android")}
        </span>
      ) : null}
    </div>
  );
}
