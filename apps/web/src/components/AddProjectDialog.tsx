import type {
  FilesystemBrowseResult,
  RepositoryProvider,
  RepositorySourceStatus,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
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
  type AddProjectSource,
  inferCloneDirectoryName,
  joinProjectPath,
} from "./AddProjectDialog.logic";

const BROWSE_STALE_TIME_MS = 10_000;
const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

type DialogStep = "sources" | "local" | "repository" | "destination";

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddProjectPath: (path: string, options?: { createIfMissing?: boolean }) => Promise<void>;
  homeDir: string | null;
  defaultCloneDirectory: string | null;
}

interface PathBrowserProps {
  initialQuery: string;
  actionLabel: string;
  busyLabel: string;
  isBusy: boolean;
  cloneDirectoryName?: string;
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

function NavigationKeyHints(props: { enterLabel: string }) {
  return (
    <div className="flex items-center gap-3">
      <KbdGroup className="items-center gap-1.5">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <span className="text-muted-foreground/80">Navigate</span>
      </KbdGroup>
      <KbdGroup className="items-center gap-1.5">
        <Kbd>Enter</Kbd>
        <span className="text-muted-foreground/80">{props.enterLabel}</span>
      </KbdGroup>
      <KbdGroup className="items-center gap-1.5">
        <Kbd>Backspace</Kbd>
        <span className="text-muted-foreground/80">Back</span>
      </KbdGroup>
      <KbdGroup className="items-center gap-1.5">
        <Kbd>Esc</Kbd>
        <span className="text-muted-foreground/80">Close</span>
      </KbdGroup>
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
  const [query, setQuery] = useState(props.initialQuery);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const highlightedPath = highlightedValue?.startsWith("folder:")
    ? highlightedValue.slice("folder:".length)
    : null;
  const browseParentPath = getBrowseParentPath(query);
  const canBrowseUp = canNavigateUp(query);
  const willCreatePath =
    !props.cloneDirectoryName &&
    !highlightedPath &&
    trimmedQuery.length > 0 &&
    !hasTrailingPathSeparator(query) &&
    exactEntry === null &&
    !isFetching;

  useEffect(() => {
    setError(null);
    setHighlightedValue(null);
  }, [query]);

  const resolvePath = (): { path: string; createIfMissing: boolean } => {
    const selectedDirectory = highlightedPath
      ? highlightedPath
      : hasTrailingPathSeparator(query)
        ? (browseResult?.parentPath ?? expandHome(trimmedQuery, props.homeDir))
        : (exactEntry?.fullPath ?? expandHome(trimmedQuery, props.homeDir));
    const normalized = normalizeProjectPathForDispatch(selectedDirectory);
    if (
      props.cloneDirectoryName &&
      (highlightedPath || exactEntry || hasTrailingPathSeparator(query))
    ) {
      return {
        path: joinProjectPath(normalized, props.cloneDirectoryName),
        createIfMissing: false,
      };
    }
    return { path: normalized, createIfMissing: willCreatePath };
  };

  const submit = async () => {
    if (props.isBusy) return;
    if (!trimmedQuery && !highlightedPath) {
      setError("Enter a folder path.");
      return;
    }
    if (unsupportedWindowsPath) {
      setError("Windows paths are not supported on this platform.");
      return;
    }
    if (!highlightedPath && isExplicitRelativeProjectPath(trimmedQuery)) {
      setError("Use an absolute path or start with ~/.");
      return;
    }
    try {
      const resolved = resolvePath();
      await props.onSubmit(resolved.path, { createIfMissing: resolved.createIfMissing });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add project.");
    }
  };

  const isMac = platform.toLowerCase().includes("mac");
  const modifier = isMac ? "⌘" : "Ctrl";
  const hasHighlightedFolder = highlightedPath !== null;
  const hasHighlightedBrowseItem = hasHighlightedFolder || highlightedValue === "__browse_up__";

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const modifierPressed = isMac ? event.metaKey : event.ctrlKey;
    if (
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || (hasHighlightedFolder && modifierPressed))
    ) {
      event.preventDefault();
      void submit();
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

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(value) => setHighlightedValue(typeof value === "string" ? value : null)}
    >
      <CommandPanel className="overflow-hidden">
        <div className="relative">
          <DialogBackButton label="Back" onClick={props.onBack} />
          <CommandInput
            value={query}
            placeholder="Type or browse a folder path"
            startAddon={null}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
            className="pe-32 ps-8"
          />
          <Button
            variant="outline"
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
              <Kbd>{hasHighlightedFolder ? `${modifier} Enter` : "Enter"}</Kbd>
            </KbdGroup>
          </Button>
        </div>
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
        <NavigationKeyHints enterLabel="Select" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto px-2 text-xs text-muted-foreground/80 hover:bg-transparent hover:text-foreground"
          disabled={props.isBusy}
          onClick={async () => {
            try {
              const api = readNativeApi();
              if (!api) throw new Error("The app server is unavailable.");
              const picked = await api.dialogs.pickFolder();
              if (!picked) return;
              const target = props.cloneDirectoryName
                ? joinProjectPath(picked, props.cloneDirectoryName)
                : picked;
              await props.onSubmit(target, { createIfMissing: false });
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Unable to add project.");
            }
          }}
        >
          {fileManagerLabel(platform)}
        </Button>
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
      setStep("sources");
      setSource(null);
      setQuery("");
      setRepositoryInput("");
      setError(null);
      setIsWorking(false);
      setHighlightedSource(null);
    }
  }, [props.open]);

  const returnToSources = () => {
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
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="overflow-hidden" aria-label="Add project">
        {step === "local" ? (
          <ProjectPathBrowser
            homeDir={props.homeDir}
            initialQuery={getInitialBrowseQuery(props.defaultCloneDirectory || props.homeDir)}
            actionLabel="Add"
            busyLabel="Adding…"
            isBusy={isWorking}
            onBack={returnToSources}
            onSubmit={async (path, options) => {
              setIsWorking(true);
              try {
                await props.onAddProjectPath(path, options);
                props.onOpenChange(false);
              } finally {
                setIsWorking(false);
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
              setQuery(repositoryInput);
              setStep("repository");
            }}
            onSubmit={async (destinationPath) => {
              const api = readNativeApi();
              if (!api) throw new Error("The app server is unavailable.");
              setIsWorking(true);
              try {
                const result = await api.projects.cloneSource(
                  buildCloneProjectSourceInput({
                    source,
                    repositoryInput,
                    destinationPath,
                  }),
                );
                await props.onAddProjectPath(result.path);
                props.onOpenChange(false);
              } finally {
                setIsWorking(false);
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
                  onClick={() =>
                    step === "sources" ? props.onOpenChange(false) : returnToSources()
                  }
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
