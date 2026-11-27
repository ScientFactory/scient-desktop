import { LegendList } from "@legendapp/list/react";
import { useGT, useLocale } from "gt-react";
import { ArrowLeftIcon, AudioLinesIcon, ClapperboardIcon, SearchIcon, XIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Empty, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { MiddleTruncate } from "../../components/ui/middle-truncate";
import { andFinally } from "../../lib/compilerSafe";
import { transcriptionCommand } from "../../rpc/transcription";
import { recordingTime } from "./recordingPresentation";
import { fileName, type Project } from "./recordingTypes";
import { useRecordingRead } from "./useRecordingRead";

type Found = {
  key: string;
  project: Project;
  source: string;
  folder: string;
  size: number;
  created: number;
  duration?: number;
};

const separators = /[/\\]+$/;
const within = (root: string, path: string) => {
  const base = root.replace(separators, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
};

/** Audio and video files in the projects that were never added, grouped by project. */
export function ProjectMediaFinder({
  projects,
  onBack,
  onAdded,
}: {
  projects: readonly Project[];
  onBack: () => void;
  onAdded: (added: readonly { project: Project; sources: readonly string[] }[]) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const formatDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLocaleLowerCase());
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(false);
  const list = useRecordingRead(
    JSON.stringify(projects.map(({ id, workspaceRoot }) => [id, workspaceRoot])),
    (signal) =>
      Promise.allSettled(
        projects.map((project) =>
          transcriptionCommand("media-list", project.workspaceRoot, { found: true }, signal),
        ),
      ),
    5000,
  );
  // A file inside nested projects belongs to the innermost one.
  const owner = (source: string) =>
    projects
      .filter((project) => within(project.workspaceRoot, source))
      .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
  const found = new Map<string, Found>();
  projects.forEach((project, index) => {
    const result = list.data?.[index];
    if (result?.status !== "fulfilled") return;
    for (const file of result.value.media) {
      const inner = owner(file.source);
      // Only the innermost project's own listing knows whether the file was already added there.
      if (inner && inner.id !== project.id) continue;
      const home = inner ?? project;
      const key = `${home.id}/${file.source}`;
      const relative = file.source.slice(home.workspaceRoot.replace(separators, "").length + 1);
      found.set(key, {
        key,
        project: home,
        source: file.source,
        folder: relative.split(/[/\\]/).slice(0, -1).join("/"),
        size: file.size,
        created: file.created,
        ...(file.duration === undefined ? {} : { duration: file.duration }),
      });
    }
  });
  const files = [...found.values()].filter(
    (file) =>
      !query || `${file.folder}/${fileName(file.source)}`.toLocaleLowerCase().includes(query),
  );
  const rows = projects.flatMap((project) => {
    const own = files
      .filter((file) => file.project.id === project.id)
      .toSorted((left, right) => right.created - left.created);
    return own.length
      ? [{ key: `project:${project.id}`, project, count: own.length } as const, ...own]
      : [];
  });
  const selected = [...found.values()].filter(({ key }) => selection.has(key));
  const toggle = (key: string, checked: boolean) =>
    setSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  const add = async () => {
    if (adding || !selected.length) return;
    setAdding(true);
    setAddError(false);
    await andFinally(
      async () => {
        try {
          const byProject = new Map<Project, Found[]>();
          for (const file of selected)
            byProject.set(file.project, [...(byProject.get(file.project) ?? []), file]);
          const added = await Promise.all(
            [...byProject].map(async ([project, chosen]) => {
              const registered = await Promise.all(
                chosen.map(({ source }) =>
                  transcriptionCommand("media-register", project.workspaceRoot, {
                    source,
                    onlyInProject: true,
                  }),
                ),
              );
              return {
                project,
                sources: registered.flatMap(({ media }) => media.map(({ source }) => source)),
              };
            }),
          );
          setSelection(new Set());
          onAdded(added.filter(({ sources }) => sources.length));
        } catch {
          setAddError(true);
        }
      },
      () => setAdding(false),
    );
  };
  const loading = list.data === undefined && !list.isError;
  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("Back to recordings")}
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-lg font-medium">
          {gt("In your projects")}{" "}
          {!loading && (
            <span className="text-sm tabular-nums text-muted-foreground">{found.size}</span>
          )}
        </h1>
      </div>
      <div className="w-full [--control-radius:9999px] sm:w-60">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            aria-label={gt("Search files")}
            placeholder={gt("Search")}
          />
          {search && (
            <InputGroupAddon align="inline-end">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Clear search")}
                onClick={() => setSearch("")}
              >
                <XIcon />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      {addError && <p role="status">{gt("Could not add the files")}</p>}
      {list.data?.some((result) => result.status === "rejected") && (
        <p role="status" className="text-sm text-muted-foreground">
          {gt("Could not look in every project")}
        </p>
      )}
      {!loading && rows.length === 0 && (
        <Empty>
          <EmptyMedia variant="icon">
            <AudioLinesIcon />
          </EmptyMedia>
          <EmptyTitle>
            {found.size ? gt("No matching files") : gt("No other audio or video in your projects")}
          </EmptyTitle>
        </Empty>
      )}
      <LegendList
        className="-mx-2 min-h-0 flex-1"
        data={rows}
        estimatedItemSize={52}
        keyExtractor={(row) => row.key}
        contentContainerStyle={{ paddingBottom: selected.length ? 72 : 0 }}
        renderItem={({ item }) => {
          if ("count" in item)
            return (
              <h2 className="flex items-baseline gap-2 px-2 pt-5 pb-1 text-xs font-medium text-muted-foreground">
                {item.project.title}
                <span className="tabular-nums">{item.count}</span>
              </h2>
            );
          const MediaIcon = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/i.test(item.source)
            ? ClapperboardIcon
            : AudioLinesIcon;
          const checked = selection.has(item.key);
          return (
            <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/60">
              <span className="grid size-9 shrink-0 place-items-center">
                <Checkbox
                  aria-label={gt("Select {file}", { file: fileName(item.source) })}
                  checked={checked}
                  onCheckedChange={(next) => toggle(item.key, next === true)}
                />
              </span>
              <MediaIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">
                  <MiddleTruncate value={fileName(item.source)} />
                </span>
                {item.folder && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.folder}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {[
                  item.duration ? recordingTime(item.duration) : undefined,
                  item.created > 0 ? formatDate.format(item.created) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </label>
          );
        }}
      />
      {selected.length > 0 && (
        <SelectionBar
          count={selected.length}
          onClear={() => setSelection(new Set())}
          clearLabel={gt("Clear selection")}
        >
          <Button size="sm" disabled={adding} onClick={() => void add()}>
            {gt("Add")}
          </Button>
        </SelectionBar>
      )}
    </>
  );
}

/** Actions for the selected rows, floating over the list so selecting never moves it. */
export function SelectionBar({
  count,
  onClear,
  clearLabel,
  children,
}: {
  count: number;
  onClear: () => void;
  clearLabel: string;
  children: React.ReactNode;
}) {
  const gt = useGT();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-popover py-1 ps-4 pe-1 text-sm shadow-lg/5">
        <span className="tabular-nums">{gt("{count} selected", { count })}</span>
        {children}
        <Button size="icon-sm" variant="ghost" aria-label={clearLabel} onClick={onClear}>
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
