import { toastManager } from "../../components/ui/toast";
import { formatTranscript, type TranscriptFormat } from "./transcriptExport";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { EnvironmentFilePath, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  EllipsisIcon,
  LocateFixedIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRecordingTitle } from "./recordingTitle";
import { MiddleTruncate } from "../../components/ui/middle-truncate";
import { Button } from "../../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { Sheet, SheetPopup, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { languageLabel } from "../../lib/languageLabel";
import { listRecordingNotes, transcriptionCommand } from "../../rpc/transcription";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useClientSettings } from "../../hooks/useSettings";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { AskRecordingButton } from "./AskRecordingButton";

import { RecordingNotesPane } from "./RecordingNotesPane";
import { RecordingPlayer } from "./RecordingPlayer";
import { RecordingSelect } from "./RecordingSelect";
import { recordingTime, segmentDirection, transcriptParagraphs } from "./recordingPresentation";
import { fileName, type Recording } from "./recordingTypes";
import { TranscribeDialog } from "./TranscribeDialog";
import { useRecordingRead } from "./useRecordingRead";
import { andFinally, fail } from "../../lib/compilerSafe";

export function RecordingView({
  recording,
  threadRef,
  onRevealComposer,
  match,
  onBack,
  onChange,
  title,
  duration,
}: {
  recording: Recording;
  /** The name the person gave it. */
  title?: string | undefined;
  /** The length Scient measured when the file was added. */
  duration?: number | undefined;
  threadRef: ScopedThreadRef;
  onRevealComposer: () => void;
  match?: { version: string; time: number; query: string } | undefined;
  onBack: () => void;
  onChange: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const recordingTitle = useRecordingTitle();
  const [version, setVersion] = useState(match?.version ?? "");
  const current =
    recording.revisions.find(({ job }) => job.id === version) ?? recording.revisions[0]!;
  const { project } = recording;
  const media = useRef<HTMLMediaElement | null>(null);
  const [playingTime, setPlayingTime] = useState(match?.time ?? 0);
  const pendingMatch = useRef(match?.time);
  const baseUrl = useEnvironmentHttpBaseUrl(project.environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  // A media link expires; a player that outlives it asks for a fresh one and resumes in place.
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const resumeAfterRefresh = useRef(false);
  const mediaQuery = useRecordingRead(
    baseUrl && !current.job.transcriptOnly ? current.job.source : "",
    async () => {
      const request = {
        environmentId: project.environmentId,
        input: {
          resource: {
            _tag: "environment-file" as const,
            path: EnvironmentFilePath.make(current.job.source),
            access: "exact" as const,
          },
        },
      };
      // The link is cached per file; after it expired, ask the server for a new one.
      if (mediaRefresh > 0) appAtomRegistry.refresh(assetEnvironment.createUrl(request));
      const result = await createAssetUrl(request);
      if (result._tag === "Failure") fail(gt("Could not open the recording"));
      return resolveAssetUrl(baseUrl!, result.value.relativeUrl);
    },
    undefined,
    mediaRefresh,
  );
  const revision = useRecordingRead(
    current.job.id,
    (signal) =>
      transcriptionCommand("revision", project.workspaceRoot, { id: current.job.id }, signal),
    ["decoding", "writing", "transcribing"].includes(current.state.stage) ? 1500 : undefined,
  );
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const review = async (accept: boolean, item: number) => {
    setReviewPending(true);
    setReviewError(false);
    await andFinally(
      async () => {
        try {
          const result = await transcriptionCommand(
            accept ? "review-accept" : "review-reject",
            project.workspaceRoot,
            { id: current.job.id, item },
          );
          setVersion(result.job.id);
          setReviewIndex(undefined);
          onChange();
        } catch {
          setReviewError(true);
        }
      },
      () => {
        setReviewPending(false);
      },
    );
  };
  const segments = revision.data?.segments ?? [];
  const [follow, setFollow] = useState(true);
  const [showFind, setShowFind] = useState(Boolean(match));
  const [find, setFind] = useState(match?.query ?? "");
  const [findMatch, setFindMatch] = useState(0);
  const notes = useRecordingRead(
    current.job.id,
    (signal) => listRecordingNotes(project.workspaceRoot, current.job.id, signal),
    5000,
  );
  const [notesOpen, setNotesOpen] = useState(false);
  const [rerun, setRerun] = useState(false);
  const [raw, setRaw] = useState(false);
  const [theater, setTheater] = useState(false);
  const [clipEnd, setClipEnd] = useState<number>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reviewIndex, setReviewIndex] = useState<number>();
  const direction = useClientSettings((settings) => settings.contentDirection);
  const list = useRef<LegendListRef>(null);
  const findField = useRef<HTMLInputElement>(null);
  const playingIndex = segments.findIndex(
    (item) => playingTime >= item.start && playingTime < item.end,
  );
  const reviewItems = revision.data?.reviewItems ?? [];
  const projection = (() => {
    const directions = segments.reduce<("ltr" | "rtl")[]>((resolved, item) => {
      resolved.push(
        segmentDirection(item.text, current.job.settings.language, resolved.at(-1), direction),
      );
      return resolved;
    }, []);
    return { ...transcriptParagraphs(segments, directions, raw), directions };
  })();
  const cueOffsets: number[] = [];
  let joined = "";
  for (const text of projection.texts) {
    if (joined) joined += " ";
    cueOffsets.push(joined.length);
    joined += text;
  }
  const searchable = joined.toLocaleLowerCase();
  const findHits = (query: string) => {
    const needle = query.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
    const found: { start: number; end: number; row: number }[] = [];
    if (!needle) return found;
    let cue = 0;
    for (
      let index = searchable.indexOf(needle);
      index >= 0;
      index = searchable.indexOf(needle, index + needle.length)
    ) {
      while ((cueOffsets[cue + 1] ?? Infinity) <= index) cue++;
      found.push({ start: index, end: index + needle.length, row: projection.rows[cue]! });
    }
    return found;
  };
  const matches = findHits(find);
  const currentHit = matches[findMatch];
  const activeParagraph = projection.rows[playingIndex];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the mounted virtual list in step with media playback.
  useEffect(() => {
    if (follow && activeParagraph !== undefined)
      void list.current?.scrollToIndex({
        index: activeParagraph,
        animated: false,
        viewPosition: 0.5,
      });
  }, [follow, activeParagraph]);
  const seek = (seconds: number, play = false) => {
    const element = media.current;
    if (!element) return;
    const maximum = Number.isFinite(element.duration) ? element.duration : Infinity;
    element.currentTime = Math.max(0, Math.min(seconds, maximum));
    setPlayingTime(element.currentTime);
    if (play) void element.play().catch(() => undefined);
  };
  const findNext = (offset: number) => {
    if (!matches.length) return;
    const index = (findMatch + offset + matches.length) % matches.length;
    setFindMatch(index);
    setFollow(false);
    void list.current?.scrollToIndex({ index: matches[index]!.row, animated: false });
  };
  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(formatTranscript(segments, "txt"));
      toastManager.add({ type: "success", title: gt("Transcript copied") });
    } catch {
      toastManager.add({ type: "error", title: gt("Could not copy the transcript") });
    }
  };
  const exportTranscript = (format: TranscriptFormat) => {
    const text = formatTranscript(segments, format);
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.download = `${fileName(current.job.source)}.${format}`;
    anchor.href = url;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const video = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(current.job.source);
  const playable = !current.job.transcriptOnly;
  const formatVersionTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const closeFind = () => {
    setShowFind(false);
    setFind("");
  };
  return (
    <div
      className="@container/recording flex h-full min-h-0 flex-col overflow-auto scrollbar-gutter-both"
      onKeyDown={(event) => {
        if (event.key === "F6") {
          const regions = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("[data-recording-focus]"),
          ];
          if (!regions.length) return;
          event.preventDefault();
          const current = regions.findIndex(
            (element) =>
              element === document.activeElement || element.contains(document.activeElement),
          );
          const step = event.shiftKey ? -1 : 1;
          regions[(current + step + regions.length) % regions.length]?.focus();
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setNotesOpen(false);
          if (showFind) findField.current?.focus();
          else setShowFind(true);
          return;
        }
        if (
          event.altKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown") &&
          reviewItems.length
        ) {
          event.preventDefault();
          const index =
            ((reviewIndex ?? (event.key === "ArrowDown" ? -1 : 0)) +
              (event.key === "ArrowDown" ? 1 : -1) +
              reviewItems.length) %
            reviewItems.length;
          const segment = segments.findIndex(({ id }) => id === reviewItems[index]?.segmentId);
          if (segment >= 0) {
            setFollow(false);
            void list.current?.scrollToIndex({ index: projection.rows[segment]!, animated: false });
            setReviewIndex(index);
          }
          return;
        }
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          !(event.target instanceof HTMLElement) ||
          event.target.closest(
            "button, input, select, textarea, [contenteditable], [role=combobox], [role=dialog]",
          )
        )
          return;
        const element = media.current;
        if (!element) return;
        const key = event.key.toLowerCase();
        if (key === "f" || key === "t" || key === "m") {
          const control = event.currentTarget.querySelector<HTMLButtonElement>(
            `[data-player-key="${key}"]`,
          );
          if (control) {
            event.preventDefault();
            control.click();
          }
        } else if (key === " " || key === "k") {
          event.preventDefault();
          if (element.paused) void element.play().catch(() => undefined);
          else element.pause();
        } else if (key === "j" || key === "l" || key === "arrowleft" || key === "arrowright") {
          event.preventDefault();
          const step = event.shiftKey || key === "j" || key === "l" ? 15 : 5;
          seek(element.currentTime + (key === "j" || key === "arrowleft" ? -step : step));
        } else if (key === "arrowup" || key === "arrowdown") {
          const index = Math.max(
            0,
            Math.min(segments.length - 1, playingIndex + (key === "arrowup" ? -1 : 1)),
          );
          const item = segments[index];
          if (item) {
            event.preventDefault();
            seek(item.start, true);
          }
        }
      }}
    >
      {rerun && (
        <TranscribeDialog
          project={project.workspaceRoot}
          projectTitle={project.title}
          source={current.job.source}
          title={fileName(current.job.source)}
          previousId={current.job.id}
          onClose={() => setRerun(false)}
          onStart={() => {
            setRerun(false);
            onChange();
          }}
        />
      )}
      {/* Audio reads as one centered column with room above it; video keeps a full-width bar. */}
      <header
        className={
          video
            ? "flex shrink-0 items-center gap-2 border-b px-3 py-2"
            : "mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 px-4 pt-8 pb-2"
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className={video ? undefined : "-ms-2"}
          onClick={onBack}
          aria-label={gt("Back to recordings")}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-medium">
            <MiddleTruncate value={recordingTitle(current.job.source, title)} />
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {project.title}
            {current.created
              ? ` · ${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(current.created)}`
              : ""}
          </p>
        </div>
        {reviewItems.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const next = ((reviewIndex ?? -1) + 1) % reviewItems.length;
              const index = segments.findIndex((item) => item.id === reviewItems[next]?.segmentId);
              if (index < 0) return;
              setNotesOpen(false);
              setFollow(false);
              void list.current?.scrollToIndex({ index: projection.rows[index]!, animated: false });
              setReviewIndex(next);
            }}
          >
            {gt("Needs review · {count}", { count: reviewItems.length })}
          </Button>
        )}
        <AskRecordingButton
          threadRef={threadRef}
          onRevealComposer={onRevealComposer}
          project={project.workspaceRoot}
          revision={current.job.id}
          name={fileName(current.job.source)}
          segments={current.state.stage === "completed" ? segments : []}
        />
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={gt("More recording actions")}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!segments.length} onClick={() => void copyTranscript()}>
              {gt("Copy transcript")}
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger disabled={!segments.length}>{gt("Export transcript")}</MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem onClick={() => exportTranscript("md")}>{gt("Markdown (.md)")}</MenuItem>
                <MenuItem onClick={() => exportTranscript("txt")}>
                  {gt("Plain text (.txt)")}
                </MenuItem>
                <MenuItem onClick={() => exportTranscript("srt")}>
                  {gt("Subtitles (.srt)")}
                </MenuItem>
                <MenuItem onClick={() => exportTranscript("vtt")}>{gt("WebVTT (.vtt)")}</MenuItem>
              </MenuSubPopup>
            </MenuSub>
            <MenuItem onClick={() => setRaw(!raw)}>
              {raw ? gt("Show as paragraphs") : gt("Show timed lines")}
            </MenuItem>
            <MenuSeparator />
            {playable && (
              <MenuItem onClick={() => setRerun(true)}>{gt("Transcribe again…")}</MenuItem>
            )}
            <MenuItem onClick={() => setDetailsOpen(true)}>{gt("Recording details")}</MenuItem>
          </MenuPopup>
        </Menu>
        <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
          <SheetPopup>
            <SheetHeader>
              <SheetTitle>{gt("Recording details")}</SheetTitle>
            </SheetHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 p-3 text-sm">
              <dt className="text-muted-foreground">{gt("Project")}</dt>
              <dd>{project.title}</dd>
              <dt className="text-muted-foreground">{gt("Engine")}</dt>
              <dd className="break-all">
                {current.modelName ??
                  `${current.job.settings.engine} · ${current.job.settings.model}`}
              </dd>
              <dt className="text-muted-foreground">{gt("Language")}</dt>
              <dd>
                {current.job.settings.language === "auto"
                  ? gt("Auto-detect")
                  : languageLabel(current.job.settings.language, locale)}
              </dd>
              {current.created ? (
                <>
                  <dt className="text-muted-foreground">{gt("Transcribed")}</dt>
                  <dd>{formatVersionTime.format(current.created)}</dd>
                </>
              ) : null}
            </dl>
          </SheetPopup>
        </Sheet>
      </header>
      <div
        className={`flex min-h-0 flex-1 flex-col ${video && !theater ? "@[1200px]/recording:grid @[1200px]/recording:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]" : ""}`}
      >
        {playable && (
          <div className={`shrink-0 ${video ? "" : "mx-auto w-full max-w-3xl px-4 pt-4"}`}>
            {mediaQuery.data && (
              <RecordingPlayer
                key={mediaQuery.data}
                knownDuration={
                  duration ?? recording.revisions.find((revision) => revision.duration)?.duration
                }
                onMedia={(element) => {
                  media.current = element;
                }}
                src={mediaQuery.data}
                video={video}
                onReady={(element) => {
                  if (pendingMatch.current !== undefined) {
                    element.currentTime = pendingMatch.current;
                    setPlayingTime(element.currentTime);
                    pendingMatch.current = undefined;
                  }
                  if (resumeAfterRefresh.current) {
                    resumeAfterRefresh.current = false;
                    void element.play().catch(() => undefined);
                  }
                }}
                onStale={(wasPlaying) => {
                  pendingMatch.current = playingTime;
                  resumeAfterRefresh.current = wasPlaying;
                  setMediaRefresh((value) => value + 1);
                }}
                time={playingTime}
                onTime={(time) => {
                  setPlayingTime(time);
                  if (clipEnd !== undefined && time >= clipEnd) {
                    media.current?.pause();
                    setClipEnd(undefined);
                  }
                }}
                theater={theater}
                onTheater={() => setTheater(!theater)}
                caption={segments[playingIndex]?.text ?? ""}
                frontier={
                  [
                    "queued",
                    "paused",
                    "interrupted",
                    "decoding",
                    "writing",
                    "transcribing",
                  ].includes(current.state.stage)
                    ? segments.at(-1)?.end
                    : undefined
                }
              />
            )}
            {mediaQuery.isError && (
              <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                {gt("Could not open the recording")}
              </p>
            )}
          </div>
        )}
        {current.state.error && (
          <p
            role="status"
            className="mx-auto w-full max-w-3xl px-4 pt-2 text-sm text-muted-foreground"
          >
            {current.state.error.message}
          </p>
        )}
        <section
          className={`mx-auto flex w-full max-w-3xl min-w-0 flex-1 flex-col px-4 ${video ? (theater ? "min-h-64" : "min-h-64 @[1200px]/recording:min-h-0") : "min-h-0"}`}
        >
          <div
            className={`flex min-h-12 flex-wrap items-center gap-2 ${video ? "py-2" : "pt-5 pb-2"}`}
          >
            <ToggleGroup
              variant="segmented"
              value={[notesOpen ? "notes" : "transcript"]}
              onValueChange={(value) => {
                if (value.length) setNotesOpen(value[0] === "notes");
              }}
            >
              <Toggle value="transcript">{gt("Transcript")}</Toggle>
              <Toggle value="notes">
                {gt("Notes")}
                {notes.data?.length ? (
                  <span className="text-muted-foreground tabular-nums">{notes.data.length}</span>
                ) : null}
              </Toggle>
            </ToggleGroup>
            <div className="ms-auto flex min-w-0 items-center gap-1">
              {!notesOpen &&
                (showFind ? (
                  <InputGroup className="w-64 max-w-full">
                    <InputGroupAddon>
                      <SearchIcon />
                    </InputGroupAddon>
                    <InputGroupInput
                      ref={(element: HTMLInputElement | null) => {
                        findField.current = element;
                      }}
                      autoFocus
                      size="sm"
                      aria-label={gt("Find text")}
                      placeholder={gt("Find in transcript")}
                      value={find}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setFind(value);
                        setFindMatch(0);
                        const match = findHits(value)[0]?.row ?? -1;
                        if (match >= 0) {
                          setFollow(false);
                          void list.current?.scrollToIndex({ index: match, animated: false });
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") findNext(event.shiftKey ? -1 : 1);
                        if (event.key === "Escape") closeFind();
                      }}
                    />
                    <InputGroupAddon align="inline-end">
                      {find.trim() && (
                        <span role="status" className="text-xs tabular-nums text-muted-foreground">
                          {gt("{current}/{count}", {
                            current: matches.length ? findMatch + 1 : 0,
                            count: matches.length,
                          })}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!matches.length}
                        aria-label={gt("Previous match")}
                        onClick={() => findNext(-1)}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!matches.length}
                        aria-label={gt("Next match")}
                        onClick={() => findNext(1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={gt("Close find")}
                        onClick={closeFind}
                      >
                        <XIcon />
                      </Button>
                    </InputGroupAddon>
                  </InputGroup>
                ) : (
                  <ScientTooltip content={gt("Find in transcript")}>
                    <Button
                      variant="ghost-muted"
                      size="icon-sm"
                      aria-label={gt("Find in transcript")}
                      onClick={() => setShowFind(true)}
                    >
                      <SearchIcon />
                    </Button>
                  </ScientTooltip>
                ))}
              {!notesOpen && playable && (
                <ScientTooltip content={gt("Keep the playing line in view")}>
                  <Button
                    variant={follow ? "secondary" : "ghost-muted"}
                    size="sm"
                    aria-pressed={follow}
                    onClick={() => setFollow(!follow)}
                  >
                    <LocateFixedIcon />
                    {gt("Follow")}
                  </Button>
                </ScientTooltip>
              )}
              {recording.revisions.length > 1 && (
                <RecordingSelect
                  label={gt("Version")}
                  value={current.job.id}
                  onChange={setVersion}
                  display={gt("Version {number}", {
                    number:
                      recording.revisions.length -
                      recording.revisions.findIndex(({ job }) => job.id === current.job.id),
                  })}
                  options={recording.revisions.map((item, index) => ({
                    value: item.job.id,
                    label: [
                      gt("Version {number}", { number: recording.revisions.length - index }),
                      item.created ? formatVersionTime.format(item.created) : undefined,
                      item.modelName,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  }))}
                />
              )}
            </div>
          </div>
          {revision.isError && (
            <p role="status" className="text-sm text-muted-foreground">
              {gt("Could not load the transcript")}
            </p>
          )}
          {!notesOpen && (
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              onWheel={() => setFollow(false)}
              onTouchMove={() => setFollow(false)}
            >
              {!segments.length && (
                <p role="status" className="py-4 text-sm text-muted-foreground">
                  {revision.data
                    ? gt("Transcript text will appear here.")
                    : gt("Loading transcript…")}
                </p>
              )}
              <LegendList
                ref={list}
                role="list"
                data-recording-focus
                tabIndex={0}
                aria-label={gt("Transcript")}
                className="min-h-0 flex-1"
                data={projection.paragraphs}
                extraData={{
                  reviewIndex,
                  reviewPending,
                  reviewError,
                  playingIndex,
                  find,
                  findMatch,
                  direction,
                }}
                estimatedItemSize={52}
                recycleItems={false}
                keyExtractor={(paragraph) => segments[paragraph.start]!.id}
                renderItem={({ item: paragraph }) => {
                  const first = segments[paragraph.start]!;
                  const selectedDirection = projection.directions[paragraph.start] ?? "ltr";
                  return (
                    <div
                      role="listitem"
                      dir={selectedDirection}
                      className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-3 py-2.5"
                    >
                      <Button
                        variant="ghost-muted"
                        size="xs"
                        className="mt-0.5 justify-self-start"
                        disabled={!playable}
                        aria-label={gt("Play from {time}", { time: recordingTime(first.start) })}
                        onClick={() => seek(first.start, true)}
                      >
                        <span dir="ltr" className="tabular-nums">
                          {recordingTime(first.start)}
                        </span>
                      </Button>
                      <div className="text-start text-[15px] leading-relaxed [unicode-bidi:isolate]">
                        {paragraph.speaker && (
                          <bdi className="block text-xs font-medium text-muted-foreground">
                            {paragraph.speaker}
                          </bdi>
                        )}
                        {segments.slice(paragraph.start, paragraph.end).map((item, cueIndex) => {
                          const index = paragraph.start + cueIndex;
                          const text = projection.texts[index] ?? item.text;
                          const cueOffset = cueOffsets[index] ?? 0;
                          const markStart = currentHit
                            ? Math.max(0, currentHit.start - cueOffset)
                            : 0;
                          const markEnd = currentHit
                            ? Math.min(text.length, currentHit.end - cueOffset)
                            : 0;

                          const reviews = reviewItems.flatMap((entry, order) =>
                            entry.segmentId === item.id ? [{ entry, order }] : [],
                          );
                          const primary = reviews[0];
                          const offset = primary?.entry.before
                            ? text.indexOf(primary.entry.before)
                            : -1;
                          const playing = playingIndex === index;
                          const play = () => seek(item.start, true);
                          const renderReview = (
                            reviewItem: NonNullable<typeof primary>,
                            text: string,
                          ) => (
                            <Popover
                              key={reviewItem.order}
                              open={reviewIndex === reviewItem.order}
                              onOpenChange={(open) =>
                                setReviewIndex(open ? reviewItem.order : undefined)
                              }
                            >
                              <PopoverTrigger
                                render={
                                  <button
                                    type="button"
                                    className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-3 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                    aria-label={gt("Review {text}", { text })}
                                  />
                                }
                              >
                                {text}
                              </PopoverTrigger>
                              <PopoverPopup dir={selectedDirection}>
                                <div className="max-w-72 space-y-2 p-3 text-sm">
                                  <p className="flex flex-wrap items-center gap-2">
                                    <bdi>{reviewItem.entry.before}</bdi>
                                    <span aria-hidden>
                                      {selectedDirection === "rtl" ? "←" : "→"}
                                    </span>
                                    <bdi>{reviewItem.entry.after}</bdi>
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {reviewItem.entry.reason}
                                  </p>
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => {
                                        setClipEnd(item.end + 0.5);
                                        play();
                                      }}
                                    >
                                      {gt("▶ Replay")}
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="default"
                                      disabled={reviewPending}
                                      onClick={() => void review(true, reviewItem.order)}
                                    >
                                      {gt("Accept")}
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      disabled={reviewPending}
                                      onClick={() => void review(false, reviewItem.order)}
                                    >
                                      {gt("Keep original")}
                                    </Button>
                                  </div>
                                  {reviewError && (
                                    <p role="status">{gt("Could not save the review decision")}</p>
                                  )}
                                </div>
                              </PopoverPopup>
                            </Popover>
                          );
                          return (
                            <span key={item.id}>
                              {cueIndex > 0 && " "}
                              <span
                                className={`rounded ${playable ? "cursor-pointer" : ""} ${playing ? "bg-accent" : ""}`}
                                aria-current={playing || undefined}
                                onClick={(event) => {
                                  if (
                                    event.target instanceof HTMLElement &&
                                    event.currentTarget.contains(event.target) &&
                                    playable &&
                                    !event.target.closest("button") &&
                                    window.getSelection()?.isCollapsed !== false
                                  )
                                    play();
                                }}
                              >
                                {primary && offset >= 0 ? (
                                  <>
                                    {text.slice(0, offset)}
                                    {renderReview(primary, primary.entry.before)}
                                    {text.slice(offset + primary.entry.before.length)}
                                  </>
                                ) : markStart < markEnd ? (
                                  <>
                                    {text.slice(0, markStart)}
                                    <mark className="rounded bg-primary/20 text-foreground">
                                      {text.slice(markStart, markEnd)}
                                    </mark>
                                    {text.slice(markEnd)}
                                  </>
                                ) : (
                                  text
                                )}
                                {(offset >= 0 ? reviews.slice(1) : reviews).map((entry) => (
                                  <span
                                    key={entry.order}
                                    className="ms-2 text-xs text-muted-foreground"
                                  >
                                    {renderReview(entry, gt("Review wording"))}
                                  </span>
                                ))}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                }}
              />
            </div>
          )}
          {notesOpen && (
            <RecordingNotesPane
              project={project.workspaceRoot}
              id={current.job.id}
              environmentId={project.environmentId}
              completed={current.state.stage === "completed"}
            />
          )}
        </section>
      </div>
    </div>
  );
}
