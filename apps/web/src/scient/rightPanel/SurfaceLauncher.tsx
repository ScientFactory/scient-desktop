import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  ChevronDown,
  FileDiff,
  FileText,
  Globe,
  Ellipsis,
  Library,
  Plus,
  Sigma,
  Smartphone,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { useBrowserDefaults } from "~/browser/browserDefaults";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import type { NewDocumentFormat } from "~/scient/documents/documentTemplates";
import {
  NEW_DOCUMENT_FORMATS,
  NewDocumentMenuItems,
} from "~/scient/documents/NewDocumentMenuItems";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { ScientFilesIcon } from "./ScientRightPanelSurfaceIcon";

/** What the side panel can open, and whether each is possible in this thread. */
export interface ScientSurfaceLauncherProps {
  /** Called after a choice opens something; the New tab closes itself here. */
  readonly onPicked?: () => void;
  readonly onAddFiles: () => void;
  readonly onAddBrowser: () => void;
  readonly onAddBrowserInProfile: (profileId: string) => void;
  readonly onAddDocuments?: ((format: NewDocumentFormat) => void) | undefined;
  readonly onAddSources: () => void;
  readonly onAddCompute: () => void;
  readonly onAddTerminal: () => void;
  readonly onAddDiff: () => void;
  readonly onAddPullRequest: () => void;
  readonly onAddPullRequests: () => void;
  readonly onAddDevice: () => void;
  readonly filesAvailable: boolean;
  readonly browserAvailable: boolean;
  readonly documentsAvailable?: boolean | undefined;
  readonly sourcesAvailable: boolean;
  readonly computeAvailable: boolean;
  readonly terminalAvailable: boolean;
  readonly diffAvailable: boolean;
  readonly pullRequestAvailable: boolean;
  readonly pullRequestsAvailable: boolean;
  readonly deviceAvailable: boolean;
}

interface LauncherEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon | ((props: { className?: string }) => ReactNode);
  /** Opens it while this page shows, without a modifier. */
  readonly shortcut: string;
  readonly available: boolean;
  readonly unavailableHint: string;
  readonly onClick: () => void;
  /** An app-wide shortcut that opens the same thing, shown with its modifiers. */
  readonly command?: KeybindingCommand;
  /** What a click opens, and a menu to pick another for this time. */
  readonly choice?: ReactNode;
}

const DOCUMENT_FORMAT_STORAGE_KEY = "scient.launcher.documentFormat";

function readDocumentFormat(): NewDocumentFormat {
  return localStorage.getItem(DOCUMENT_FORMAT_STORAGE_KEY) === "latex" ? "latex" : "markdown";
}

/** A small button inside a card: names what a click opens, and lists the others. */
function CardChoice(props: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        openOnHover
        delay={80}
        closeDelay={150}
        render={
          <button
            type="button"
            aria-label={props.ariaLabel}
            className="inline-flex h-6 cursor-pointer items-center gap-0.5 rounded-md border border-border/70 bg-card ps-1.5 pe-1 font-normal text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[popup-open]:bg-accent/50 data-[popup-open]:text-foreground"
          />
        }
      >
        <span className="max-w-28 truncate">{props.label}</span>
        <ChevronDown aria-hidden className="size-3 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-40">
        {props.children}
      </MenuPopup>
    </Menu>
  );
}

// Open popups own the keyboard; a letter typed into them must not open a surface.
const SHORTCUT_BLOCKING_LAYERS = [
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

function focusOnMount(node: HTMLDivElement | null) {
  node?.focus();
}

/** The entry a plain letter opens; any modifier leaves the key to the app. */
function entryForKey(entries: readonly LauncherEntry[], event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  return entries.find((entry) => entry.available && entry.shortcut.toLowerCase() === key) ?? null;
}

function targetsTypingContext(target: Element) {
  return (
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
    null
  );
}

/**
 * The page the side panel shows when nothing is open in it: one card per
 * surface, the everyday ones first and the rest behind More.
 */
export function ScientSurfaceLauncher(props: ScientSurfaceLauncherProps) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [moreOpen, setMoreOpen] = useState(false);
  const pick =
    <Args extends unknown[]>(open: (...args: Args) => void) =>
    (...args: Args) => {
      open(...args);
      props.onPicked?.();
    };
  const browserDefaults = useBrowserDefaults();
  const defaultProfile =
    browserDefaults.profiles.find((profile) => profile.id === browserDefaults.profileId) ??
    browserDefaults.profiles[0];
  // The format a click creates follows the last one picked.
  const [documentFormat, setDocumentFormat] = useState(readDocumentFormat);
  const createDocument = (format: NewDocumentFormat) => {
    localStorage.setItem(DOCUMENT_FORMAT_STORAGE_KEY, format);
    setDocumentFormat(format);
    props.onAddDocuments?.(format);
    props.onPicked?.();
  };

  const main: readonly LauncherEntry[] = [
    {
      id: "files",
      label: "Files",
      icon: ScientFilesIcon,
      shortcut: "F",
      available: props.filesAvailable,
      unavailableHint: "Available when a project is open.",
      onClick: pick(props.onAddFiles),
    },
    {
      id: "browser",
      label: "Browser",
      icon: Globe,
      shortcut: "B",
      available: props.browserAvailable,
      unavailableHint: "Only available in the desktop app.",
      onClick: pick(props.onAddBrowser),
      command: "preview.toggle",
      choice:
        browserDefaults.profiles.length > 1 ? (
          <CardChoice
            label={defaultProfile?.name ?? "Default"}
            ariaLabel="Open browser in a profile"
          >
            {browserDefaults.profiles.map((profile) => (
              <MenuItem
                key={profile.id}
                onClick={() => pick(props.onAddBrowserInProfile)(profile.id)}
              >
                <span className="min-w-0 truncate">{profile.name}</span>
              </MenuItem>
            ))}
          </CardChoice>
        ) : undefined,
    },
    {
      id: "documents",
      label: "Document",
      icon: FileText,
      shortcut: "W",
      available: props.documentsAvailable === true && props.onAddDocuments !== undefined,
      unavailableHint: "Open a project to create documents.",
      onClick: () => createDocument(documentFormat),
      choice: (
        <CardChoice
          label={NEW_DOCUMENT_FORMATS[documentFormat].label}
          ariaLabel="Choose the document format"
        >
          <NewDocumentMenuItems onChoose={createDocument} />
        </CardChoice>
      ),
    },
    {
      id: "sources",
      label: "Sources",
      icon: Library,
      shortcut: "S",
      available: props.sourcesAvailable,
      unavailableHint: "Available inside a project.",
      onClick: pick(props.onAddSources),
    },
    {
      id: "compute",
      label: "Scientific computing",
      icon: Sigma,
      shortcut: "C",
      available: props.computeAvailable,
      unavailableHint: "Available inside a project.",
      onClick: pick(props.onAddCompute),
    },
    {
      id: "diff",
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      unavailableHint: "Available for Git repositories.",
      onClick: pick(props.onAddDiff),
      command: "diff.toggle",
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      unavailableHint: "Available when a project is open.",
      onClick: pick(props.onAddTerminal),
    },
  ];
  const more: readonly LauncherEntry[] = [
    {
      id: "pull-request",
      label: "Pull request",
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      unavailableHint: "No pull request on this branch yet.",
      onClick: pick(props.onAddPullRequest),
    },
    {
      id: "pull-requests",
      label: "Linked pull requests",
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      unavailableHint: "No linked pull requests available.",
      onClick: pick(props.onAddPullRequests),
    },
    {
      id: "device",
      label: "Device",
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      unavailableHint: "Available from a thread.",
      onClick: pick(props.onAddDevice),
    },
  ];

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const entry = entryForKey([...main, ...more], event);
    if (!entry) return;
    if (document.querySelector(SHORTCUT_BLOCKING_LAYERS)) return;
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof Element && targetsTypingContext(target)) return;
    event.preventDefault();
    event.stopPropagation();
    entry.onClick();
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- The launcher's card shortcuts listen while it is shown.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const card = (entry: LauncherEntry) => {
    const globalShortcut = entry.command
      ? shortcutLabelForCommand(keybindings, entry.command)
      : null;
    // The card's own button lies under its content, so the small controls on
    // it stay separate buttons rather than buttons inside a button.
    return (
      <div
        key={entry.id}
        className={cn(
          "group relative flex h-14 w-full items-center gap-3 rounded-lg border border-border/60 bg-card px-3 text-[15px] text-card-foreground transition-colors",
          entry.available ? "hover:border-border hover:bg-accent/40" : "opacity-50",
        )}
      >
        {entry.available ? (
          <button
            type="button"
            aria-label={entry.label}
            onClick={entry.onClick}
            className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  role="button"
                  tabIndex={0}
                  aria-disabled="true"
                  aria-label={entry.label}
                  className="absolute inset-0 cursor-default rounded-lg"
                />
              }
            />
            <TooltipPopup>{entry.unavailableHint}</TooltipPopup>
          </Tooltip>
        )}
        <span className="pointer-events-none grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-muted/50 text-[color-mix(in_srgb,var(--sidebar-icon-color)_70%,var(--card-foreground))] transition-colors group-hover:text-foreground [&_svg]:[stroke-width:1.75]">
          <entry.icon className="size-4" />
        </span>
        <span className="pointer-events-none min-w-0 flex-1 truncate">{entry.label}</span>
        <div className="relative flex shrink-0 items-center gap-2">
          {entry.available ? entry.choice : null}
          {entry.available && globalShortcut ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Kbd>{globalShortcut}</Kbd>
              </TooltipTrigger>
              <TooltipPopup>From anywhere</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Kbd>{entry.shortcut}</Kbd>
            </TooltipTrigger>
            <TooltipPopup>Press {entry.shortcut} to open</TooltipPopup>
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={focusOnMount}
      tabIndex={-1}
      aria-label="Open in side panel"
      data-scient-launcher
      className="scient-reading-ui scrollbar-gutter-both @container/launcher flex min-h-0 flex-1 flex-col overflow-y-auto bg-sidebar px-4 pt-12 pb-6 outline-none"
    >
      {/* Lowers the list in a tall panel; a short panel gives this room up before it scrolls. */}
      <div aria-hidden className="basis-16" />
      <div className="mx-auto w-full max-w-3xl">
        <h2 className="mb-3 px-1 font-medium text-foreground text-sm">Tools</h2>
        <div className="grid gap-2 @[36rem]/launcher:grid-cols-2">
          {main.map(card)}
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className="group flex h-14 w-full cursor-pointer items-center gap-3 rounded-lg border border-border/60 bg-card px-3 text-left text-[15px] text-card-foreground transition-colors hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-muted/50 text-[color-mix(in_srgb,var(--sidebar-icon-color)_70%,var(--card-foreground))] transition-colors group-hover:text-foreground [&_svg]:[stroke-width:1.75]">
              <Ellipsis className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate">More</span>
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                moreOpen && "rotate-180",
              )}
            />
          </button>
          {moreOpen ? more.map(card) : null}
        </div>
      </div>
    </div>
  );
}

/** The tab bar's "+": opens the launcher as a tab. */
export function ScientNewTabButton(props: {
  readonly onClick: () => void;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const shortcut = shortcutLabelForCommand(props.keybindings, "rightPanel.new");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="New tab"
            className="shrink-0 self-center"
            size="icon-sm"
            variant="ghost-muted"
            onClick={props.onClick}
          />
        }
      >
        <Plus className="size-3.75" />
      </TooltipTrigger>
      <TooltipPopup>
        New tab
        {shortcut ? <Kbd className="ms-2">{shortcut}</Kbd> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
