import { ImportTranscriptDialog, type TranscriptMedia } from "./ImportTranscriptDialog";
import { openRecordingCapture } from "./recordingCaptureStore";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { recordingTime } from "./recordingPresentation";
import { useRouter } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { scientRecordingSurface } from "../rightPanel/surfaces";
import { RecordingBadge } from "./RecordingBadge";
import { capturedAt, fileName, type Recording, type Project } from "./recordingTypes";
import { formatBytes } from "../../lib/formatBytes";
import { useRecordingTitle } from "./recordingTitle";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogPanel,
} from "../../components/ui/dialog";
import { LegendList } from "@legendapp/list/react";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ThreadId,
} from "@t3tools/contracts";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { useGT, useLocale } from "gt-react";
import {
  AudioLinesIcon,
  ChevronDownIcon,
  ClapperboardIcon,
  EllipsisIcon,
  FileAudioIcon,
  FileTextIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { languageLabel } from "../../lib/languageLabel";
import { RecordingSelect } from "./RecordingSelect";
import { copyRecording } from "./copyRecording";
import { TranscribeDialog } from "./TranscribeDialog";
import {
  RecordingInfo,
  RecordingMenuItems,
  RecordingNameInput,
  type RecordingDetails,
  showRecordingMenu,
  trashRecording,
  type ManagedRecording,
  type RecordingAction,
} from "./RecordingManage";
import { useRecycleBin } from "./serverPlatform";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Checkbox } from "../../components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { MiddleTruncate } from "../../components/ui/middle-truncate";
import {
  linkRecordingThread,
  listRecordingThreads,
  transcriptionCommand,
  type RecordingStatus,
} from "../../rpc/transcription";
import { readThreadShell, useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useRecordingRead } from "./useRecordingRead";
import { andFinally, fail } from "../../lib/compilerSafe";

function RecordingProgress({ state }: { state: RecordingStatus["state"] }) {
  const gt = useGT();
  if (!state.total || !["transcribing", "paused", "interrupted"].includes(state.stage)) return null;
  const percent = Math.min(100, Math.round((state.completed / state.total) * 100));
  return (
    <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
      <span
        className="h-1 min-w-16 flex-1 rounded-full bg-muted-foreground/20"
        role="progressbar"
        aria-label={gt("Transcription progress")}
        aria-valuenow={percent}
      >
        <span
          className="block h-full rounded-full bg-primary motion-safe:transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </span>
      {percent}%
    </span>
  );
}

export function RecordingsPage({
  lockedProject,
  openSource,
  fromThread,
}: { lockedProject?: string; openSource?: string; fromThread?: string } = {}) {
  const gt = useGT();
  const locale = useLocale();
  const environmentId = usePrimaryEnvironmentId();
  const read = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const write = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const operate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const available = read && write && operate;
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      !project.isScratch &&
      (lockedProject === undefined || project.id === lockedProject),
  );
  const [projectFilter, setProjectFilter] = useState("");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().slice(0, 256));
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [dragging, setDragging] = useState(false);
  const formatDate = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const recordingTitle = useRecordingTitle();
  // The row whose name is being edited.
  const [renaming, setRenaming] = useState<string>();
  const [info, setInfo] = useState<{
    details: RecordingDetails;
    anchor: Element | { getBoundingClientRect: () => DOMRect };
  }>();
  const windows = useRecycleBin(environmentId);
  const router = useRouter();
  const newThread = useNewThreadHandler();
  const opening = useRef(false);
  const [openError, setOpenError] = useState(false);
  const [transcribe, setTranscribe] = useState<{
    project: Project;
    source: string;
    previousId?: string;
    batchSources?: readonly string[];
  }>();
  const [jobActionPending, setJobActionPending] = useState(false);
  const [jobActionError, setJobActionError] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(false);
  const [transcriptFile, setTranscriptFile] = useState<File>();
  const transcriptPicker = useRef<HTMLInputElement>(null);
  const [transcriptMatch, setTranscriptMatch] = useState<TranscriptMedia>();
  const chooseTranscript = (matched?: TranscriptMedia) => {
    setTranscriptMatch(matched);
    transcriptPicker.current?.click();
  };
  const picker = useRef<HTMLInputElement>(null);
  const importFile = useAtomCommand(copyRecording, { reportFailure: false });
  const bridge = window.desktopBridge;
  const [destinationId, setDestinationId] = useState("");
  const [pendingImport, setPendingImport] = useState<readonly File[]>();
  const destination = projects.find(({ id }) => id === (lockedProject ?? projectFilter));
  const chosenDestination = projects.find(({ id }) => id === destinationId);
  const canAdd =
    available &&
    !!bridge &&
    projects.length > 0 &&
    !bridge
      .getLocalEnvironmentBootstraps()
      .some(
        (bootstrap) =>
          bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID &&
          typeof bootstrap.runningDistro === "string",
      );
  const manageActions = (
    key: string,
    managed: ManagedRecording,
    busy: boolean,
    details: RecordingDetails,
  ): RecordingAction[] => {
    const os = windows ? "windows" : "other";
    return [
      {
        id: "info",
        label: gt("Info"),
        run: (at) => {
          const row = document.querySelector(`[data-recording="${CSS.escape(key)}"]`);
          setInfo({
            details,
            anchor:
              at || !row
                ? {
                    getBoundingClientRect: () =>
                      DOMRect.fromRect({ x: at?.x ?? 0, y: at?.y ?? 0, width: 0, height: 0 }),
                  }
                : row,
          });
        },
      },
      { id: "rename", label: gt("Rename"), run: () => setRenaming(key) },
      {
        id: "trash",
        label: gt("{os, select, windows {Move to Recycle Bin} other {Move to Trash}}", { os }),
        destructive: true,
        separatorBefore: true,
        disabled: busy,
        run: () =>
          void trashRecording(managed, {
            done: gt(
              "{os, select, windows {Moved {name} to the Recycle Bin} other {Moved {name} to the Trash}}",
              { os, name: managed.title },
            ),
            failed: gt("Could not move the recording"),
          }).then((trashed) => {
            if (!trashed) return;
            setSelection(new Set());
            refreshList();
          }),
      },
    ];
  };
  const copyTranscript = async (file: File, project: Project) => {
    const source = bridge?.getPathForFile(file);
    if (!source) fail("Transcript file is unavailable");
    const result = await importFile({
      environmentId: project.environmentId,
      input: {
        cwd: project.workspaceRoot,
        change: { _tag: "import", sources: [source], folder: "", collision: "keep-both" },
      },
    });
    const path = result._tag === "Success" ? result.value.entries[0]?.to : undefined;
    if (!path) fail("Transcript file could not be copied");
    return resolveWorkspaceFilePath(path, project.workspaceRoot);
  };
  const add = async (files: readonly File[], target = destination) => {
    if (!canAdd || !files.length || adding) return;
    if (!target) {
      setPendingImport(files);
      return;
    }
    const sources = files.flatMap((file) => {
      const path = bridge.getPathForFile(file);
      return path ? [path] : [];
    });
    if (!sources.length) return;
    setAdding(true);
    setAddError(false);
    await andFinally(
      async () => {
        try {
          // A file already in the project is used where it is; others are copied into it.
          const inPlace = await Promise.all(
            sources.map((source) =>
              transcriptionCommand("media-register", target.workspaceRoot, {
                source,
                onlyInProject: true,
              }),
            ),
          );
          const outside = sources.filter((_, index) => !inPlace[index]!.media.length);
          const copied = outside.length
            ? await importFile({
                environmentId: target.environmentId,
                input: {
                  cwd: target.workspaceRoot,
                  change: { _tag: "import", sources: outside, folder: "", collision: "keep-both" },
                },
              })
            : undefined;
          if (copied && copied._tag !== "Success") fail("Recording import failed");
          const registered = [
            ...inPlace,
            ...(await Promise.all(
              (copied?.value.entries ?? []).flatMap(({ to }) =>
                to
                  ? [
                      transcriptionCommand("media-register", target.workspaceRoot, {
                        source: resolveWorkspaceFilePath(to, target.workspaceRoot),
                      }),
                    ]
                  : [],
              ),
            )),
          ];
          const added = registered.flatMap(({ media }) => media.map(({ source }) => source));
          if (!added.length) fail("Recording registration failed");
          if (added.length <= 20)
            setTranscribe({
              project: target,
              source: added[0]!,
              ...(added.length > 1 ? { batchSources: added } : {}),
            });
        } catch {
          setAddError(true);
        }
      },
      () => {
        setAdding(false);
        refreshList();
      },
    );
  };
  const [refresh, setRefresh] = useState(0);
  const refreshList = () => setRefresh((current) => current + 1);
  const runJobAction = async (recording: Recording, mode: "pause" | "resume") => {
    const current = recording.revisions[0]!;
    setJobActionPending(true);
    setJobActionError(false);
    await andFinally(
      async () => {
        try {
          if (mode === "pause") {
            await transcriptionCommand("pause", recording.project.workspaceRoot, {
              id: current.job.id,
            });
          } else {
            const { settings, correction } = current.job;
            await transcriptionCommand("start", recording.project.workspaceRoot, {
              source: current.job.source,
              language: settings.language,
              model: settings.model,
              engine: "local",
              resume: current.job.id,
              revisionMode: "resume",
              ...(settings.rule ? { rule: settings.rule } : {}),
              ...(settings.rangeStart !== undefined && settings.rangeEnd !== undefined
                ? { range: { start: settings.rangeStart, end: settings.rangeEnd } }
                : {}),
              ...(correction?.mode !== "thorough" && correction?.mode
                ? { mode: correction.mode }
                : {}),
              ...(correction?.notes ? { notes: correction.notes } : {}),
              ...(correction?.modelSelection ? { correctionModel: correction.modelSelection } : {}),
            });
          }
          refreshList();
        } catch {
          setJobActionError(true);
        }
      },
      () => {
        setJobActionPending(false);
      },
    );
  };
  const list = useRecordingRead(
    available
      ? JSON.stringify([
          environmentId,
          query,
          projects.map(({ id, workspaceRoot }) => [id, workspaceRoot]),
        ])
      : "",
    async (signal) =>
      Promise.allSettled(
        projects.map(async (project) => {
          const [revisions, files] = await Promise.all([
            transcriptionCommand(
              "list",
              project.workspaceRoot,
              { includeCreated: true, ...(query ? { query } : {}) },
              signal,
            ),
            transcriptionCommand("media-list", project.workspaceRoot, {}, signal),
          ]);
          return { revisions, media: files.media };
        }),
      ),
    3000,
    refresh,
  );
  const grouped = new Map<string, Recording>();
  const durations = new Map<string, number>();
  const queuedRecordings = new Set<string>();
  const titles = new Map<string, string>();
  const added: {
    key: string;
    project: Project;
    source: string;
    size: number;
    created: number;
    queued?: boolean;
    duration?: number;
    title?: string;
  }[] = [];
  projects.forEach((project, index) => {
    const result = list.data?.[index];
    if (result?.status !== "fulfilled") return;
    const { revisions, media } = result.value;
    const transcribed = new Set(revisions.map(({ job }) => job.source));
    for (const file of media) {
      const key = `${project.id}/${file.source}`;
      if (file.duration !== undefined) durations.set(key, file.duration);
      if (file.queued) queuedRecordings.add(key);
      if (file.title) titles.set(key, file.title);
      if (!transcribed.has(file.source)) added.push({ key, project, ...file });
    }
    for (const revision of revisions) {
      const key = `${project.id}/${revision.job.source}`;
      const recording = grouped.get(key) ?? { project, revisions: [] };
      recording.revisions.push(revision);
      grouped.set(key, recording);
    }
  });
  const openRecording = async (
    recording: Recording,
    match?: { version: string; time: number; query: string },
    replace = false,
  ) => {
    if (opening.current || !recording.revisions.length) return;
    opening.current = true;
    setOpenError(false);
    const {
      project,
      revisions: [latest],
    } = recording;
    if (!latest) return;
    const panel = useRightPanelStore.getState();
    const open = (threadRef: ReturnType<typeof scopeThreadRef>) => {
      panel.openScient(
        threadRef,
        scientRecordingSurface(
          project.id,
          latest.job.source,
          match,
          recordingTitle(latest.job.source, titles.get(`${project.id}/${latest.job.source}`)),
        ),
      );
      panel.requestMaximize(threadRef);
      panel.setMaximized(threadRef, true);
    };
    await andFinally(
      async () => {
        try {
          const recordingIds = new Set(
            recording.revisions.map(({ job }) => job.recording ?? job.id),
          );
          const openInThread = async (threadId: ThreadId) => {
            const ref = scopeThreadRef(project.environmentId, threadId);
            const drafts = useComposerDraftStore.getState();
            const draft = drafts.getDraftThreadByRef(ref);
            const draftId = drafts.getDraftIdByRef(ref);
            if (draftId && draft?.projectId === project.id && !draft.promotedTo) {
              open(ref);
              await router.navigate({ to: "/draft/$draftId", params: { draftId }, replace });
              return true;
            }
            if (readThreadShell(ref)?.projectId === project.id) {
              open(ref);
              await router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(ref),
                replace,
              });
              return true;
            }
            return false;
          };
          const currentThreadId = fromThread ? ThreadId.make(fromThread) : null;
          if (currentThreadId && (await openInThread(currentThreadId))) {
            await settlePromise(() =>
              linkRecordingThread(project.workspaceRoot, latest.job.id, currentThreadId),
            );
            return;
          }
          const links = (
            await Promise.all(
              [...recordingIds].map((id) => listRecordingThreads(project.workspaceRoot, id)),
            )
          ).flat();
          for (const threadId of links) {
            if (await openInThread(threadId)) return;
          }
          const target = await newThread(scopeProjectRef(project.environmentId, project.id), {
            replace,
          });
          if (!target) return;
          open(scopeThreadRef(project.environmentId, target.threadId));
          await linkRecordingThread(project.workspaceRoot, latest.job.id, target.threadId);
        } catch {
          setOpenError(true);
        }
      },
      () => {
        opening.current = false;
      },
    );
  };

  const sourceRecording =
    lockedProject && openSource ? grouped.get(`${lockedProject}/${openSource}`) : undefined;
  const openRedirect = useEffectEvent((recording: Recording) =>
    openRecording(recording, undefined, true),
  );
  const redirectAttempted = useRef("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves the standalone URL once its project listing is ready, then navigates into the recording tab.
  useEffect(() => {
    if (!sourceRecording || !openSource || !lockedProject) return;
    const key = JSON.stringify([lockedProject, openSource]);
    if (redirectAttempted.current === key) return;
    redirectAttempted.current = key;
    void openRedirect(sourceRecording);
  }, [lockedProject, openSource, sourceRecording, redirectAttempted]);

  const unfilteredRows = [
    ...[...grouped.entries()].map(([key, recording]) => {
      const { job, created, state, reviewCount, duration } = recording.revisions[0]!;
      const matchedRevision = query
        ? recording.revisions.find((revision) => revision.snippet)
        : undefined;
      const queued = queuedRecordings.has(key);
      return {
        key,
        project: recording.project,
        source: job.source,
        title: recordingTitle(job.source, titles.get(key)),
        size: job.input.size,
        duration: durations.get(key) ?? duration,
        created: created ?? 0,
        recording,
        snippet: matchedRevision?.snippet,
        matchedRevision,
        queued,
        status: queued
          ? "queued"
          : reviewCount
            ? "review"
            : state.stage === "interrupted"
              ? "paused"
              : state.stage === "decoding" || state.stage === "writing"
                ? "transcribing"
                : state.stage,
      };
    }),
    ...added.map((file) => ({
      ...file,
      title: recordingTitle(file.source, file.title),
      recording: undefined,
      snippet: undefined,
      matchedRevision: undefined,
      status: file.queued ? "queued" : "untranscribed",
    })),
  ];
  const rows = unfilteredRows
    .filter(
      (row) =>
        (!projectFilter || projectFilter === row.project.id) &&
        (!statusFilter || statusFilter === row.status) &&
        ([row.title, fileName(row.source)].some((name) =>
          name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        ) ||
          row.snippet),
    )
    .sort((left, right) =>
      sort === "oldest"
        ? left.created - right.created
        : sort === "longest"
          ? (right.duration ?? 0) - (left.duration ?? 0)
          : sort === "name"
            ? left.title.localeCompare(right.title, locale)
            : right.created - left.created,
    );
  // The project is named on each row only when the list mixes projects.
  const manyProjects = new Set(rows.map((row) => row.project.id)).size > 1;
  const statusOptions = [
    { value: "", label: gt("All statuses") },
    { value: "untranscribed", label: gt("Not transcribed") },
    { value: "queued", label: gt("Queued") },
    { value: "transcribing", label: gt("Transcribing") },
    { value: "paused", label: gt("Paused") },
    { value: "review", label: gt("Needs review") },
    { value: "completed", label: gt("Done") },
    { value: "failed", label: gt("Couldn’t finish") },
  ];
  const statusLabels = new Map(statusOptions.map(({ value, label }) => [value, label]));
  const formatWhen = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const recordingDetails = (row: {
    title: string;
    project: Project;
    source: string;
    size: number;
    created: number;
    duration?: number | undefined;
    status: string;
    language?: string | undefined;
    versions?: number | undefined;
  }): RecordingDetails => {
    const recorded = capturedAt(row.source);
    const status = statusLabels.get(row.status);
    return {
      title: row.title,
      rows: [
        recorded
          ? [gt("Recorded"), formatWhen.format(recorded)]
          : [gt("Added"), row.created > 0 ? formatWhen.format(row.created) : undefined],
        [gt("Length"), row.duration ? recordingTime(row.duration) : undefined],
        [gt("Size"), row.size > 0 ? formatBytes(row.size) : undefined],
        [gt("Format"), /\.([^.]{1,5})$/.exec(row.source)?.[1]?.toUpperCase()],
        [gt("Language"), row.language],
        [
          gt("Transcript"),
          status && row.versions && row.versions > 1
            ? gt("{status} · {count} versions", { status, count: row.versions })
            : status,
        ],
        [gt("Project"), row.project.title],
      ],
    };
  };
  const selectedFiles = added.filter((file) => !file.queued && selection.has(file.key));
  const batchProject = selectedFiles[0]?.project;
  return (
    <WorkspacePageContainer
      width="readable"
      className={
        lockedProject
          ? "relative h-full min-h-0 gap-3! px-3! pt-3! pb-4"
          : "relative h-full min-h-0 pb-4"
      }
      onDragOver={(event) => {
        if (canAdd && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!canAdd || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        void add([...event.dataTransfer.files]);
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-medium">
          {gt("Recordings")}{" "}
          <span className="text-sm tabular-nums text-muted-foreground">{rows.length}</span>
        </h1>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!available || !projects.length}
            onClick={() => openRecordingCapture(destination?.id)}
          >
            <span aria-hidden className="size-2.5 rounded-full bg-destructive" />
            {gt("Record")}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!available || !projects.length}
                  aria-label={gt("Add recording")}
                />
              }
            >
              <PlusIcon aria-hidden />
              {gt("Add")}
              <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-max">
              <MenuItem disabled={!canAdd || adding} onClick={() => picker.current?.click()}>
                <FileAudioIcon aria-hidden />
                {gt("Audio or video files…")}
              </MenuItem>
              <MenuItem disabled={!canAdd} onClick={() => chooseTranscript()}>
                <FileTextIcon aria-hidden />
                {gt("Import a transcript…")}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <input
            type="file"
            ref={transcriptPicker}
            accept=".srt,.vtt,.ass,.ssa,.docx"
            hidden
            onChange={(event) => {
              setTranscriptFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept="audio/*,video/*,.mkv,.m4a,.flac,.ogg"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void add(files);
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {/* A pill, like Extensions: the control radius is a theme variable the input group reads. */}
        <div className="w-full [--control-radius:9999px] sm:w-60">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              size="sm"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              aria-label={gt("Search recordings and transcripts")}
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
        <div className="flex flex-wrap items-center gap-1">
          {!lockedProject && (
            <RecordingSelect
              label={gt("Project")}
              value={projectFilter}
              onChange={setProjectFilter}
              options={[
                { value: "", label: gt("All projects") },
                ...projects.map((project) => ({ value: project.id, label: project.title })),
              ]}
            />
          )}
          <RecordingSelect
            label={gt("Status")}
            value={statusFilter}
            options={statusOptions}
            onChange={setStatusFilter}
          />
          <RecordingSelect
            label={gt("Sort recordings")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "newest", label: gt("Newest") },
              { value: "oldest", label: gt("Oldest") },
              { value: "longest", label: gt("Longest") },
              { value: "name", label: gt("Title") },
            ]}
          />
          {(query || projectFilter || statusFilter) && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setSearch("");
                setProjectFilter("");
                setStatusFilter("");
              }}
            >
              {gt("Clear filters")}
            </Button>
          )}
        </div>
      </div>
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-10 grid place-items-center rounded-xl border border-dashed border-primary bg-background/95 text-sm">
          {destination
            ? gt("Drop to add to {project}", { project: destination.title })
            : gt("Drop to add recordings")}
        </div>
      )}
      {openError && <p role="status">{gt("Could not open the recording thread")}</p>}
      {jobActionError && <p role="status">{gt("Could not update the transcription job")}</p>}
      {addError && <p role="status">{gt("Could not copy the recording into the project")}</p>}
      {pendingImport && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingImport(undefined);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{gt("Choose a project")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <RecordingSelect
                label={gt("Destination project")}
                value={destinationId}
                options={projects.map(({ id, title }) => ({ value: id, label: title }))}
                onChange={setDestinationId}
              />
            </DialogPanel>
            <DialogFooter>
              <Button
                disabled={!chosenDestination}
                onClick={() => {
                  if (!chosenDestination) return;
                  setPendingImport(undefined);
                  void add(pendingImport, chosenDestination);
                }}
              >
                {gt("Add recording")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
      {transcriptFile && (
        <ImportTranscriptDialog
          file={transcriptFile}
          projects={projects}
          selectedProject={transcriptMatch?.project ?? destination}
          matched={transcriptMatch}
          media={unfilteredRows.flatMap(({ project, source, recording }) => {
            const latest = recording?.revisions[0]?.job;
            return latest?.transcriptOnly
              ? []
              : [{ project, source, ...(latest ? { revision: latest.id } : {}) }];
          })}
          copy={copyTranscript}
          onClose={() => setTranscriptFile(undefined)}
          onImported={() => {
            setTranscriptFile(undefined);
            refreshList();
          }}
        />
      )}
      {info && (
        <RecordingInfo
          details={info.details}
          anchor={info.anchor}
          onClose={() => setInfo(undefined)}
        />
      )}
      {transcribe && (
        <TranscribeDialog
          key={transcribe.source}
          project={transcribe.project.workspaceRoot}
          projectTitle={transcribe.project.title}
          source={transcribe.source}
          title={
            transcribe.batchSources
              ? gt("{count} recordings", { count: transcribe.batchSources.length })
              : fileName(transcribe.source)
          }
          {...(transcribe.batchSources ? { batchSources: transcribe.batchSources } : {})}
          {...(transcribe.previousId ? { previousId: transcribe.previousId } : {})}
          onClose={() => setTranscribe(undefined)}
          onStart={() => {
            setTranscribe(undefined);
            setSelection(new Set());
            refreshList();
          }}
        />
      )}
      {!available && (
        <p role="status" className="text-sm text-muted-foreground">
          {gt("Recordings are unavailable in this session")}
        </p>
      )}
      {list.data?.some((result) => result.status === "rejected") && (
        <p role="status" className="text-sm text-muted-foreground">
          {gt("Could not load recordings from every project")}
        </p>
      )}
      {available &&
        rows.length === 0 &&
        list.data?.every((result) => result.status === "fulfilled") && (
          <Empty>
            <EmptyMedia variant="icon">
              <AudioLinesIcon />
            </EmptyMedia>
            <EmptyTitle>
              {unfilteredRows.length ? gt("No matching recordings") : gt("No recordings yet")}
            </EmptyTitle>
            {unfilteredRows.length === 0 && (
              <EmptyDescription>
                {gt(
                  "Add a lecture, meeting or interview. Scient transcribes it here, in its project.",
                )}
              </EmptyDescription>
            )}
            {unfilteredRows.length === 0 ? (
              <Button disabled={!canAdd || adding} onClick={() => picker.current?.click()}>
                {gt("Add recording")}
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setProjectFilter("");
                  setStatusFilter("");
                }}
              >
                {gt("Clear filters")}
              </Button>
            )}
          </Empty>
        )}
      {batchProject && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 text-sm">
          <span className="flex-1">{gt("{count} selected", { count: selectedFiles.length })}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const sources = selectedFiles.map(({ source }) => source);
              setTranscribe({
                project: batchProject,
                source: sources[0]!,
                ...(sources.length > 1 ? { batchSources: sources } : {}),
              });
            }}
          >
            {gt("Transcribe selected")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>
            {gt("Clear selection")}
          </Button>
        </div>
      )}
      <LegendList
        className="-mx-2 min-h-0 flex-1"
        data={rows}
        estimatedItemSize={64}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => {
          const {
            key,
            project,
            source,
            title,
            recording,
            created,
            duration,
            snippet,
            matchedRevision,
          } = item;
          const MediaIcon = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(source)
            ? ClapperboardIcon
            : AudioLinesIcon;
          const visibleDate = created > 0 ? formatDate.format(created) : undefined;
          const queued = "queued" in item && item.queued === true;
          const managed = { workspaceRoot: project.workspaceRoot, source, title };
          const renamed = (changed: boolean) => {
            setRenaming(undefined);
            if (changed) refreshList();
          };
          if (!recording) {
            const actions: RecordingAction[] = [
              {
                id: "transcribe",
                label: gt("Transcribe…"),
                disabled: queued,
                run: () => setTranscribe({ project, source }),
              },
              {
                id: "import",
                label: gt("Import transcript"),
                disabled: !canAdd || queued,
                run: () => chooseTranscript({ project, source }),
              },
              ...manageActions(
                key,
                managed,
                queued,
                recordingDetails({ ...item, duration: item.duration }),
              ),
            ];
            return (
              <div
                data-recording={key}
                className="group/recording flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/60"
                onContextMenu={(event) => void showRecordingMenu(event, actions)}
              >
                {/* The checkbox takes the icon's place while the row is hovered, focused or chosen. */}
                <span className="relative grid size-9 shrink-0 place-items-center text-muted-foreground">
                  <MediaIcon
                    aria-hidden
                    className="size-4 group-hover/recording:opacity-0 group-focus-within/recording:opacity-0 group-has-[[aria-checked=true]]/recording:opacity-0 pointer-coarse:opacity-0"
                  />
                  <span className="absolute inset-0 grid place-items-center opacity-0 group-hover/recording:opacity-100 group-focus-within/recording:opacity-100 has-[[aria-checked=true]]:opacity-100 pointer-coarse:opacity-100">
                    <Checkbox
                      aria-label={gt("Select {recording}", { recording: fileName(source) })}
                      checked={selection.has(key)}
                      disabled={
                        queued ||
                        (batchProject !== undefined && batchProject.id !== project.id) ||
                        (!selection.has(key) && selectedFiles.length >= 20)
                      }
                      onCheckedChange={(checked) =>
                        setSelection((current) => {
                          const next = new Set(current);
                          if (checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                    />
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {renaming === key ? (
                      <RecordingNameInput recording={managed} onDone={renamed} />
                    ) : (
                      <MiddleTruncate value={title} />
                    )}
                  </p>
                  {manyProjects && <p className="text-xs text-muted-foreground">{project.title}</p>}
                </div>
                <Badge variant="secondary" size="sm">
                  {queued ? gt("Queued") : gt("Not transcribed")}
                </Badge>
                {!queued && (
                  <Button
                    disabled={queued}
                    variant="outline"
                    size="sm"
                    onClick={() => setTranscribe({ project, source })}
                  >
                    {gt("Transcribe")}
                  </Button>
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {[duration ? recordingTime(duration) : undefined, visibleDate]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost-muted-row"
                        aria-label={gt("Recording actions")}
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup>
                    <RecordingMenuItems actions={actions} />
                  </MenuPopup>
                </Menu>
              </div>
            );
          }
          const { job, state, reviewCount } = recording.revisions[0]!;
          const working = queued || ["decoding", "transcribing", "writing"].includes(state.stage);
          const actions: RecordingAction[] = [
            { id: "open", label: gt("Open"), run: () => void openRecording(recording) },
            ...(job.transcriptOnly
              ? []
              : [
                  {
                    id: "import",
                    label: gt("Import transcript"),
                    disabled: !canAdd || queued,
                    run: () => chooseTranscript({ project, source, revision: job.id }),
                  },
                ]),
            ...(!queued &&
            !job.transcriptOnly &&
            (state.stage === "completed" || state.stage === "failed")
              ? [
                  {
                    id: "again",
                    label: gt("Transcribe again"),
                    run: () => setTranscribe({ project, source, previousId: job.id }),
                  },
                ]
              : []),
            ...manageActions(
              key,
              managed,
              working,
              recordingDetails({
                ...item,
                language:
                  job.settings.language === "auto"
                    ? undefined
                    : languageLabel(job.settings.language, locale),
                versions: recording.revisions.length,
              }),
            ),
          ];
          const opener =
            "flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2 text-start outline-none";
          const content = (
            <>
              <span className="grid size-9 shrink-0 place-items-center text-muted-foreground">
                <MediaIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-sm font-medium">
                  {renaming === key ? (
                    <RecordingNameInput recording={managed} onDone={renamed} />
                  ) : (
                    <MiddleTruncate value={title} />
                  )}
                </span>
                {(manyProjects || job.settings.language !== "auto") && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      manyProjects ? project.title : undefined,
                      job.settings.language === "auto"
                        ? undefined
                        : languageLabel(job.settings.language, locale),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
                {snippet && (
                  <bdi className="block truncate text-xs text-muted-foreground">{snippet}</bdi>
                )}
                {!queued && <RecordingProgress state={state} />}
                {!queued && (state.stage === "paused" || state.stage === "interrupted") && (
                  <span className="block text-xs text-muted-foreground">
                    {gt("Paused. Resumes where it stopped")}
                  </span>
                )}
              </span>
              {queued ? (
                <Badge variant="secondary" size="sm">
                  {gt("Queued")}
                </Badge>
              ) : (
                <RecordingBadge state={state} reviewCount={reviewCount} />
              )}
            </>
          );
          return (
            <div
              data-recording={key}
              className="flex min-h-14 items-center gap-2 rounded-lg px-2 hover:bg-accent/60 has-focus-visible:bg-accent/60"
              onContextMenu={(event) => void showRecordingMenu(event, actions)}
            >
              {renaming === key ? (
                <div className={opener}>{content}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => void openRecording(recording)}
                  className={opener}
                >
                  {content}
                </button>
              )}
              {matchedRevision?.matchTime !== undefined ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void openRecording(recording, {
                      version: matchedRevision.job.id,
                      time: matchedRevision.matchTime!,
                      query,
                    })
                  }
                >
                  {gt("Open match · {time}", { time: recordingTime(matchedRevision.matchTime) })}
                </Button>
              ) : queued ? null : ["decoding", "transcribing"].includes(state.stage) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={jobActionPending}
                  onClick={() => void runJobAction(recording, "pause")}
                >
                  {gt("Pause")}
                </Button>
              ) : (state.stage === "interrupted" || state.stage === "paused") &&
                job.settings.engine === "local" &&
                job.correction?.mode !== "thorough" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={jobActionPending}
                  onClick={() => void runJobAction(recording, "resume")}
                >
                  {gt("Resume")}
                </Button>
              ) : state.stage === "failed" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTranscribe({ project, source, previousId: job.id })}
                >
                  {gt("Try again")}
                </Button>
              ) : reviewCount ? (
                <Button size="sm" variant="outline" onClick={() => void openRecording(recording)}>
                  {gt("Review")}
                </Button>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {[duration ? recordingTime(duration) : undefined, visibleDate]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted-row"
                      aria-label={gt("Recording actions")}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup>
                  <RecordingMenuItems actions={actions} />
                </MenuPopup>
              </Menu>
            </div>
          );
        }}
      />
    </WorkspacePageContainer>
  );
}
