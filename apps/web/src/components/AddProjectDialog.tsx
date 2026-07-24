import type {
  FilesystemBrowseResult,
  RepositoryProvider,
  RepositorySourceStatus,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SiGithub, SiGitlab } from "react-icons/si";
import { LuArrowLeft, LuCornerLeftUp, LuFolderPlus, LuLink } from "react-icons/lu";

import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  getInitialBrowseQuery,
  hasTrailingPathSeparator,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  normalizeProjectPathForDispatch,
} from "~/lib/projectPaths";
import { FolderClosed } from "./FolderClosed";
import { Button } from "./ui/button";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  buildCloneProjectSourceInput,
  canAcceptProjectFolderDrop,
  getAvailableNewFolderName,
  type AddProjectSource,
  inferCloneDirectoryName,
  isProjectFolderDrag,
  joinProjectPath,
  resolveDroppedProjectFolder,
} from "./AddProjectDialog.logic";

const BROWSE_STALE_TIME_MS = 10_000;
const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

type DialogStep = "sources" | "local" | "repository" | "destination";

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddProjectPath: (path: string, options?: { createIfMissing?: boolean }) => Promise<boolean>;
  homeDir: string | null;
  defaultCloneDirectory: string | null;
}

interface PathBrowserProps {
  initialQuery: string;
  actionLabel: string;
  busyLabel: string;
  isBusy: boolean;
  cloneDirectoryName?: string;
  acceptFolderDrop?: boolean;
  onBack: () => void;
  onSubmit: (path: string, options: { createIfMissing: boolean }) => Promise<void>;
}

function expandHome(value: string, homeDir: string | null): string {
  if (!homeDir) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) return `${homeDir}${value.slice(1)}`;
  return value;
}

function providerLabel(provider: RepositoryProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

function fileManagerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Open in Finder";
  if (normalized.includes("win")) return "Open in File Explorer";
  return "Open in file manager";
}

function sourceStatus(
  statuses: readonly RepositorySourceStatus[] | undefined,
  provider: RepositoryProvider,
): RepositorySourceStatus | null {
  return statuses?.find((status) => status.provider === provider) ?? null;
}

function NavigationKeyHints(props: {
  enterLabel: string;
  browseDirectories?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <KbdGroup className="items-center gap-1.5">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        {props.browseDirectories ? <Kbd>→</Kbd> : null}
        <span className="text-muted-foreground/80">Navigate</span>
      </KbdGroup>
      <KbdGroup className="items-center gap-1.5">
        <Kbd>Enter</Kbd>
        <span className="text-muted-foreground/80">{props.enterLabel}</span>
      </KbdGroup>
      {!props.compact ? (
        <>
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Backspace</Kbd>
            <span className="text-muted-foreground/80">Back</span>
          </KbdGroup>
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <span className="text-muted-foreground/80">Close</span>
          </KbdGroup>
        </>
      ) : null}
    </div>
  );
}

function DialogBackButton(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="-translate-y-1/2 absolute start-3 top-1/2 z-10 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      aria-label={props.label}
      onClick={props.onClick}
    >
      <LuArrowLeft className="size-4" />
    </button>
  );
}

function ProjectPathBrowser(props: PathBrowserProps & { homeDir: string | null }) {
  const { isBusy, onSubmit } = props;
  const [query, setQuery] = useState(props.initialQuery);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFolderDragActive, setIsFolderDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitInFlightRef = useRef(false);
  const supportsFolderDrop =
    props.acceptFolderDrop === true && typeof window.desktopBridge?.getPathForFile === "function";
  const pendingNameSelectionRef = useRef<{ query: string; start: number; end: number } | null>(
    null,
  );
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const trimmedQuery = query.trim();
  const unsupportedWindowsPath = isUnsupportedWindowsProjectPath(trimmedQuery, platform);
  const browseDirectoryPath = getBrowseDirectoryPath(query);
  const leafSegment = hasTrailingPathSeparator(query) ? "" : getBrowseLeafPathSegment(query);
  const expandedBrowsePath = expandHome(browseDirectoryPath, props.homeDir);
  const {
    data: browseResult,
    error: browseError,
    isFetching,
  } = useQuery<FilesystemBrowseResult | null>({
    queryKey: ["add-project-dialog-browse", expandedBrowsePath],
    queryFn: async () => {
      const api = readNativeApi();
      if (!api || !expandedBrowsePath) return null;
      return await api.filesystem.browse({ partialPath: expandedBrowsePath });
    },
    enabled: expandedBrowsePath.length > 0 && !unsupportedWindowsPath,
    staleTime: BROWSE_STALE_TIME_MS,
  });
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const filteredEntries = useMemo(() => {
    const filter = leafSegment.toLowerCase();
    const showHidden = leafSegment.startsWith(".");
    return browseEntries.filter(
      (entry) =>
        entry.name.toLowerCase().startsWith(filter) && (showHidden || !entry.name.startsWith(".")),
    );
  }, [browseEntries, leafSegment]);
  const exactEntry =
    leafSegment.length > 0
      ? (filteredEntries.find((entry) => entry.name === leafSegment) ?? null)
      : null;
  const browseParentPath = getBrowseParentPath(query);
  const canBrowseUp = canNavigateUp(query);
  const canStepBackWithinBrowser = query !== props.initialQuery && browseParentPath !== null;
  const willCreatePath =
    !props.cloneDirectoryName &&
    trimmedQuery.length > 0 &&
    !hasTrailingPathSeparator(query) &&
    exactEntry === null &&
    !isFetching;

  useEffect(() => {
    setError(null);
    setHighlightedValue(null);

    const pendingSelection = pendingNameSelectionRef.current;
    if (pendingSelection?.query === query) {
      pendingNameSelectionRef.current = null;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pendingSelection.start, pendingSelection.end);
    }
  }, [query]);

  const resolvePath = (): { path: string; createIfMissing: boolean } => {
    const selectedDirectory = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? expandHome(trimmedQuery, props.homeDir))
      : (exactEntry?.fullPath ?? expandHome(trimmedQuery, props.homeDir));
    const normalized = normalizeProjectPathForDispatch(selectedDirectory);
    if (props.cloneDirectoryName && (exactEntry || hasTrailingPathSeparator(query))) {
      return {
        path: joinProjectPath(normalized, props.cloneDirectoryName),
        createIfMissing: false,
      };
    }
    return { path: normalized, createIfMissing: willCreatePath };
  };

  const submit = async () => {
    if (props.isBusy || submitInFlightRef.current) return;
    if (!trimmedQuery) {
      setError("Enter a folder path.");
      return;
    }
    if (unsupportedWindowsPath) {
      setError("Windows paths are not supported on this platform.");
      return;
    }
    if (isExplicitRelativeProjectPath(trimmedQuery)) {
      setError("Use an absolute path or start with ~/.");
      return;
    }
    submitInFlightRef.current = true;
    try {
      const resolved = resolvePath();
      if (!resolved.createIfMissing) {
        await props.onSubmit(resolved.path, { createIfMissing: false });
        return;
      }

      const api = readNativeApi();
      if (!api) throw new Error("The app server is unavailable.");
      const created = await api.filesystem.createDirectory({ path: resolved.path });
      await props.onSubmit(created.path, { createIfMissing: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add project.");
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const browseHighlightedDirectory = (): boolean => {
    if (highlightedValue === "__browse_up__") {
      if (!browseParentPath) return false;
      setQuery(browseParentPath);
      return true;
    }
    if (!highlightedValue?.startsWith("folder:")) return false;

    const highlightedPath = highlightedValue.slice("folder:".length);
    const highlightedEntry = filteredEntries.find((entry) => entry.fullPath === highlightedPath);
    if (!highlightedEntry) return false;
    setQuery(appendBrowsePathSegment(query, highlightedEntry.name));
    return true;
  };

  const handleInputKeyDownCapture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void submit();
      return;
    }
    if (event.key === "ArrowRight" && browseHighlightedDirectory()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Backspace" && query === "") {
      event.preventDefault();
      props.onBack();
      return;
    }
    if (
      event.key === "Backspace" &&
      hasTrailingPathSeparator(query) &&
      browseParentPath &&
      event.currentTarget.selectionStart === query.length &&
      event.currentTarget.selectionEnd === query.length
    ) {
      event.preventDefault();
      setQuery(browseParentPath);
    }
  };

  const beginNewFolder = () => {
    const basePath = getBrowseDirectoryPath(query);
    const folderName = getAvailableNewFolderName(browseEntries.map((entry) => entry.name));
    const nextQuery = `${basePath}${folderName}`;
    pendingNameSelectionRef.current = {
      query: nextQuery,
      start: basePath.length,
      end: nextQuery.length,
    };
    setQuery(nextQuery);
  };

  const goBack = () => {
    if (canStepBackWithinBrowser) {
      setQuery(browseParentPath);
      return;
    }
    props.onBack();
  };

  const runSubmission = useCallback(
    async (operation: () => Promise<void>) => {
      if (isBusy || submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      setError(null);
      try {
        await operation();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to add project.");
      } finally {
        submitInFlightRef.current = false;
      }
    },
    [isBusy],
  );

  useEffect(() => {
    if (!supportsFolderDrop) {
      setIsFolderDragActive(false);
      return;
    }

    let dragDepth = 0;
    const resetDragState = () => {
      dragDepth = 0;
      setIsFolderDragActive(false);
    };
    const handleDragEnter = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !isProjectFolderDrag(event.dataTransfer.types)) return;
      dragDepth += 1;
      setIsFolderDragActive(
        !isBusy && !submitInFlightRef.current && canAcceptProjectFolderDrop(event.dataTransfer),
      );
    };
    const handleDragOver = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !isProjectFolderDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect =
        !isBusy && !submitInFlightRef.current && canAcceptProjectFolderDrop(event.dataTransfer)
          ? "copy"
          : "none";
    };
    const handleDragLeave = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !isProjectFolderDrag(event.dataTransfer.types)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsFolderDragActive(false);
    };
    const handleDrop = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !isProjectFolderDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();
      resetDragState();
      if (isBusy || submitInFlightRef.current) return;

      const dropped = resolveDroppedProjectFolder(event.dataTransfer);
      if ("error" in dropped) {
        setError(dropped.error);
        return;
      }

      setQuery(dropped.path);
      void runSubmission(() =>
        onSubmit(dropped.path, {
          createIfMissing: false,
        }),
      );
    };

    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("drop", handleDrop, true);
      dragDepth = 0;
    };
  }, [isBusy, onSubmit, runSubmission, supportsFolderDrop]);

  return (
    <Command
      key={expandedBrowsePath}
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(value) => setHighlightedValue(typeof value === "string" ? value : null)}
    >
      <CommandPanel
        data-testid={supportsFolderDrop ? "folder-drop-dialog-panel" : undefined}
        className={cn(
          "overflow-hidden transition-[background-color,box-shadow] duration-150",
          isFolderDragActive &&
            "bg-emerald-500/[0.015] shadow-[inset_0_0_0_1px_rgb(34_197_94/0.18)]",
        )}
      >
        <div className="relative">
          <DialogBackButton
            label={canStepBackWithinBrowser ? "Parent folder" : "Back"}
            onClick={goBack}
          />
          <CommandInput
            ref={inputRef}
            value={query}
            placeholder="Type or browse a folder path"
            startAddon={null}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDownCapture={handleInputKeyDownCapture}
            className={cn("ps-8", willCreatePath ? "pe-40" : "pe-32")}
          />
          <Button
            variant={props.cloneDirectoryName ? "outline" : "info-outline"}
            size="xs"
            tabIndex={-1}
            className="-translate-y-1/2 absolute end-3 top-1/2 gap-1.5 pe-1 ps-2"
            disabled={props.isBusy || !trimmedQuery || unsupportedWindowsPath}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void submit()}
          >
            <span>
              {props.isBusy
                ? props.busyLabel
                : willCreatePath
                  ? `Create & ${props.actionLabel}`
                  : props.actionLabel}
            </span>
            <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
              <Kbd>Enter</Kbd>
            </KbdGroup>
          </Button>
        </div>
        {supportsFolderDrop ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="folder-drop-affordance"
            data-drop-state={isFolderDragActive ? "active" : "idle"}
            className="flex min-h-12 items-center gap-3 px-4 py-1.5 text-sm"
          >
            <span
              data-testid="folder-drop-icon-tile"
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.035] text-blue-500 shadow-[0_3px_10px_rgb(0_0_0/0.08)] transition-colors duration-150 dark:bg-foreground/[0.07] dark:shadow-[0_3px_12px_rgb(0_0_0/0.24)]",
                isFolderDragActive &&
                  "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400",
              )}
            >
              <LuFolderPlus className="size-4.5" aria-hidden="true" />
            </span>
            {isFolderDragActive ? (
              <span className="font-medium text-foreground">Release to add this folder</span>
            ) : (
              <span className="text-foreground">
                Drop your folder here
                <span className="text-muted-foreground"> or browse below</span>
              </span>
            )}
          </div>
        ) : null}
        <CommandList className="max-h-[min(28rem,62vh)] min-h-64 not-empty:px-1.5 not-empty:pb-1.5">
          <CommandGroup>
            <CommandGroupLabel className="py-2 pl-3">
              {props.cloneDirectoryName ? "Select where to clone" : "Directories"}
            </CommandGroupLabel>
            {canBrowseUp ? (
              <CommandItem
                value="__browse_up__"
                className="cursor-pointer items-center gap-3 rounded-lg px-3 py-2"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => browseParentPath && setQuery(browseParentPath)}
              >
                <LuCornerLeftUp className="size-4 text-muted-foreground/70" />
                <span>..</span>
              </CommandItem>
            ) : null}
            {filteredEntries.map((entry) => (
              <CommandItem
                key={entry.fullPath}
                value={`folder:${entry.fullPath}`}
                className="cursor-pointer items-center gap-3 rounded-lg px-3 py-2"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setQuery(appendBrowsePathSegment(query, entry.name))}
              >
                <FolderClosed className="size-4 text-muted-foreground/70" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {entry.name}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
          {!isFetching && filteredEntries.length === 0 && !canBrowseUp ? (
            <CommandEmpty className="py-10">No matching folders.</CommandEmpty>
          ) : null}
          {error || browseError ? (
            <div className="mx-2 my-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error ??
                (browseError instanceof Error
                  ? browseError.message
                  : "Unable to browse this folder.")}
            </div>
          ) : null}
        </CommandList>
      </CommandPanel>
      <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
        <NavigationKeyHints
          enterLabel={willCreatePath ? "Create" : props.actionLabel}
          browseDirectories
          compact
        />
        <div className="flex items-center gap-1.5">
          {!props.cloneDirectoryName ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-auto gap-1.5 px-2 text-xs"
              disabled={
                props.isBusy ||
                !browseDirectoryPath ||
                unsupportedWindowsPath ||
                isFetching ||
                Boolean(browseError)
              }
              onClick={beginNewFolder}
            >
              <LuFolderPlus className="size-3.5" />
              New folder
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-auto px-2 text-xs text-muted-foreground/80 hover:bg-transparent hover:text-foreground"
            disabled={props.isBusy}
            onClick={async () => {
              await runSubmission(async () => {
                const api = readNativeApi();
                if (!api) throw new Error("The app server is unavailable.");
                const picked = await api.dialogs.pickFolder();
                if (!picked) return;
                const target = props.cloneDirectoryName
                  ? joinProjectPath(picked, props.cloneDirectoryName)
                  : picked;
                await props.onSubmit(target, { createIfMissing: false });
              });
            }}
          >
            {fileManagerLabel(platform)}
          </Button>
        </div>
      </CommandFooter>
    </Command>
  );
}

export function AddProjectDialog(props: AddProjectDialogProps) {
  const [step, setStep] = useState<DialogStep>("sources");
  const [source, setSource] = useState<Exclude<AddProjectSource, "local"> | null>(null);
  const [query, setQuery] = useState("");
  const [repositoryInput, setRepositoryInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [highlightedSource, setHighlightedSource] = useState<string | null>(null);
  const openRef = useRef(props.open);
  const operationGenerationRef = useRef(0);
  openRef.current = props.open;
  const statusesQuery = useQuery({
    queryKey: ["repository-source-statuses"],
    queryFn: async () => {
      const api = readNativeApi();
      if (!api) throw new Error("The app server is unavailable.");
      return await api.projects.repositorySourceStatuses();
    },
    enabled: props.open,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!props.open) {
      operationGenerationRef.current += 1;
      setStep("sources");
      setSource(null);
      setQuery("");
      setRepositoryInput("");
      setError(null);
      setIsWorking(false);
      setHighlightedSource(null);
    }
  }, [props.open]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Native clone requests are not cancellable. Invalidate their completion
      // synchronously so a dismissed request cannot mutate a later dialog session.
      operationGenerationRef.current += 1;
    }
    props.onOpenChange(open);
  };

  const beginOperation = (): number => {
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    setIsWorking(true);
    return generation;
  };

  const isCurrentOperation = (generation: number): boolean =>
    openRef.current && operationGenerationRef.current === generation;

  const finishCurrentOperation = (generation: number): void => {
    if (isCurrentOperation(generation)) {
      setIsWorking(false);
    }
  };

  const cancelCurrentOperation = (): void => {
    // Clone and project-initialization requests cannot be cancelled natively.
    // Invalidate their completion before navigating so an old request cannot
    // advance or close the dialog from a different step.
    operationGenerationRef.current += 1;
    setIsWorking(false);
  };

  const returnToSources = () => {
    cancelCurrentOperation();
    setStep("sources");
    setSource(null);
    setQuery("");
    setRepositoryInput("");
    setError(null);
  };

  const selectSource = (nextSource: AddProjectSource) => {
    setError(null);
    if (nextSource === "local") {
      setStep("local");
      return;
    }
    if (nextSource === "github" || nextSource === "gitlab") {
      const status = sourceStatus(statusesQuery.data?.sources, nextSource);
      if (!status || status.status !== "available") {
        setError(status?.message ?? `Checking ${providerLabel(nextSource)} setup…`);
        return;
      }
    }
    setSource(nextSource);
    setRepositoryInput("");
    setQuery("");
    setStep("repository");
  };

  const sourceRows = [
    {
      id: "local" as const,
      title: "Local folder",
      description: "Browse a folder on disk",
      icon: LuFolderPlus,
    },
    {
      id: "git-url" as const,
      title: "Git URL",
      description: "Clone from a remote URL",
      icon: LuLink,
    },
    {
      id: "github" as const,
      title: "GitHub repository",
      description: "Clone GitHub owner/repo",
      icon: SiGithub,
    },
    {
      id: "gitlab" as const,
      title: "GitLab repository",
      description: "Clone GitLab group/project",
      icon: SiGitlab,
    },
  ].filter((row) =>
    `${row.title} ${row.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const cloneName = source ? inferCloneDirectoryName(source, repositoryInput) : "repository";
  const cloneBase = props.defaultCloneDirectory?.trim() || props.homeDir || "~/";
  const cloneInitialPath = joinProjectPath(cloneBase, cloneName);

  const submitRepository = () => {
    if (!source || !query.trim()) return;
    setRepositoryInput(query.trim());
    setStep("destination");
  };

  return (
    <CommandDialog open={props.open} onOpenChange={handleOpenChange}>
      <CommandDialogPopup className="overflow-hidden" aria-label="Add project">
        {step === "local" ? (
          <ProjectPathBrowser
            homeDir={props.homeDir}
            initialQuery={getInitialBrowseQuery(props.defaultCloneDirectory || props.homeDir)}
            actionLabel="Open"
            busyLabel="Opening…"
            isBusy={isWorking}
            acceptFolderDrop
            onBack={returnToSources}
            onSubmit={async (path, options) => {
              const operationGeneration = beginOperation();
              try {
                const shouldClose = await props.onAddProjectPath(path, options);
                if (!isCurrentOperation(operationGeneration)) return;
                if (shouldClose) {
                  setIsWorking(false);
                  handleOpenChange(false);
                }
              } finally {
                finishCurrentOperation(operationGeneration);
              }
            }}
          />
        ) : step === "destination" && source ? (
          <ProjectPathBrowser
            homeDir={props.homeDir}
            initialQuery={cloneInitialPath}
            actionLabel="Clone"
            busyLabel="Cloning…"
            isBusy={isWorking}
            cloneDirectoryName={cloneName}
            onBack={() => {
              cancelCurrentOperation();
              setQuery(repositoryInput);
              setStep("repository");
            }}
            onSubmit={async (destinationPath) => {
              const api = readNativeApi();
              if (!api) throw new Error("The app server is unavailable.");
              const operationGeneration = beginOperation();
              try {
                const result = await api.projects.cloneSource(
                  buildCloneProjectSourceInput({
                    source,
                    repositoryInput,
                    destinationPath,
                  }),
                );
                if (!isCurrentOperation(operationGeneration)) return;
                const shouldClose = await props.onAddProjectPath(result.path);
                if (!isCurrentOperation(operationGeneration)) return;
                if (shouldClose) {
                  setIsWorking(false);
                  handleOpenChange(false);
                }
              } finally {
                finishCurrentOperation(operationGeneration);
              }
            }}
          />
        ) : (
          <Command
            autoHighlight="always"
            mode="none"
            onItemHighlighted={(value) =>
              setHighlightedSource(typeof value === "string" ? value : null)
            }
          >
            <CommandPanel className="overflow-hidden">
              <div className="relative">
                <DialogBackButton
                  label={step === "sources" ? "Close" : "Back"}
                  onClick={() => (step === "sources" ? handleOpenChange(false) : returnToSources())}
                />
                <CommandInput
                  value={query}
                  placeholder={
                    step === "sources"
                      ? "Search…"
                      : source === "git-url"
                        ? "https://host/owner/repository.git"
                        : source === "github"
                          ? "owner/repository"
                          : "group/project"
                  }
                  startAddon={null}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Backspace" && query === "" && step === "repository") {
                      event.preventDefault();
                      returnToSources();
                    } else if (event.key === "Enter" && step === "repository") {
                      event.preventDefault();
                      submitRepository();
                    } else if (
                      event.key === "Enter" &&
                      step === "sources" &&
                      highlightedSource?.startsWith("source:")
                    ) {
                      event.preventDefault();
                      selectSource(highlightedSource.slice("source:".length) as AddProjectSource);
                    }
                  }}
                  className={step === "repository" ? "pe-28 ps-8" : "ps-8"}
                />
                {step === "repository" ? (
                  <Button
                    variant="outline"
                    size="xs"
                    tabIndex={-1}
                    className="-translate-y-1/2 absolute end-3 top-1/2 gap-1.5 pe-1 ps-2"
                    disabled={!query.trim()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={submitRepository}
                  >
                    Continue <Kbd>Enter</Kbd>
                  </Button>
                ) : null}
              </div>
              <CommandList className="max-h-[min(28rem,62vh)] min-h-64 not-empty:px-1.5 not-empty:pb-1.5">
                {step === "sources" ? (
                  <CommandGroup>
                    <CommandGroupLabel className="py-2 pl-3">Sources</CommandGroupLabel>
                    {sourceRows.map((row) => {
                      const provider = row.id === "github" || row.id === "gitlab" ? row.id : null;
                      const status = provider
                        ? sourceStatus(statusesQuery.data?.sources, provider)
                        : null;
                      const setupRequired = provider !== null && status?.status !== "available";
                      const Icon = row.icon;
                      return (
                        <CommandItem
                          key={row.id}
                          value={`source:${row.id}`}
                          className={cn(
                            "cursor-pointer items-center gap-3 rounded-lg px-3 py-2",
                            setupRequired && "opacity-60",
                          )}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectSource(row.id)}
                          title={setupRequired ? status?.message : undefined}
                        >
                          <Icon
                            className={cn(
                              "size-4 shrink-0 text-muted-foreground/70",
                              row.id === "gitlab" && "text-[#e24329]",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-foreground">{row.title}</div>
                            <div className="text-xs text-muted-foreground">{row.description}</div>
                          </div>
                          {setupRequired ? (
                            <span className="rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                              Setup Required
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : (
                  <div className="px-5 py-10 text-center text-sm text-muted-foreground">
                    Enter the{" "}
                    {source === "git-url"
                      ? "remote URL"
                      : `${source ? providerLabel(source) : "repository"} repository`}{" "}
                    to clone.
                  </div>
                )}
                {error ? (
                  <div className="mx-2 my-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}
              </CommandList>
            </CommandPanel>
            <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
              <NavigationKeyHints enterLabel={step === "repository" ? "Continue" : "Select"} />
            </CommandFooter>
          </Command>
        )}
      </CommandDialogPopup>
    </CommandDialog>
  );
}
