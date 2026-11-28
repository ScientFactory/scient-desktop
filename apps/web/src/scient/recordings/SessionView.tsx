import type {
  RecordingSession,
  RecordingSessionCommand,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { ChevronLeftIcon, EllipsisIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import { andFinally, fail } from "../../lib/compilerSafe";
import { randomUUID } from "../../lib/utils";
import {
  linkRecordingThread,
  transcriptionCommand,
  type RecordingStatus,
} from "../../rpc/transcription";
import { RecordingSelect } from "./RecordingSelect";
import { SessionMaterial } from "./SessionMaterial";
import { SessionNotes } from "./SessionNotes";
import { SessionTimeline, type SessionPosition } from "./SessionTimeline";
import { recordingTime } from "./recordingPresentation";
import { fileName, type Project } from "./recordingTypes";
import { useSessionTypeOptions } from "./sessionTypeOptions";
import { useRecordingRead } from "./useRecordingRead";

type Edit = Exclude<
  RecordingSessionCommand,
  { kind: "list" | "ensure" | "combine" | "read-snapshot" | "snapshot-part" }
>;
type SessionEdit = Edit extends infer Item
  ? Item extends Edit
    ? Omit<Item, "id" | "version">
    : never
  : never;

export function SessionView({
  project,
  session,
  revisions,
  onChange,
  onBack,
  threadRef,
  onRevealComposer,
  citation,
  onOpenPart,
}: {
  project: Project;
  session: RecordingSession;
  revisions: readonly RecordingStatus[];
  onChange: () => void;
  onBack: () => void;
  threadRef?: ScopedThreadRef;
  onRevealComposer?: () => void;
  citation?: { contextRevision: string; recordingId?: string; time?: number };
  onOpenPart?: (source: string) => void;
}) {
  const gt = useGT();
  const types = useSessionTypeOptions();
  const [tab, setTab] = useState<"transcript" | "notes" | "material">("transcript");
  const [rename, setRename] = useState<string>();
  const [locate, setLocate] = useState<{ partId: string; path: string }>();
  const [override, setOverride] = useState<RecordingSession>();
  const current = override && override.version > session.version ? override : session;
  const readOnly = citation !== undefined || current.archived === true;
  const startPart =
    current.parts.find(({ recordingId }) => recordingId === citation?.recordingId) ??
    current.parts[0];
  const [position, setPosition] = useState<SessionPosition>({
    partId: startPart?.id ?? "",
    time: Math.min(startPart?.duration ?? 0, citation?.time ?? 0),
  });
  const media = useRef<HTMLMediaElement>(null);
  const active = current.parts.find(({ id }) => id === position.partId) ?? current.parts[0];
  const playing = active?.id === position.partId ? position : { partId: active?.id ?? "", time: 0 };
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const parts = current.parts.map((part) => {
    const revision =
      part.revision ??
      revisions.find(({ job, state }) => job.source === part.source && state.stage === "completed")
        ?.job.id;
    return revision ? { ...part, revision } : part;
  });
  const transcript = useRecordingRead(
    JSON.stringify([citation?.contextRevision, parts.map(({ id, revision }) => [id, revision])]),
    async (signal) =>
      await Promise.all(
        parts.map(async (part) => {
          if (!part.revision) return { part, segments: [] };
          if (citation) {
            const result = await transcriptionCommand(
              "session",
              project.workspaceRoot,
              {
                command: {
                  kind: "snapshot-part",
                  contextRevision: citation.contextRevision,
                  partId: part.id,
                },
              },
              signal,
            );
            return { part, segments: result.segments ?? [] };
          }
          const result = await transcriptionCommand(
            "revision",
            project.workspaceRoot,
            { id: part.revision },
            signal,
          );
          return { part, segments: result.segments };
        }),
      ),
  );
  const cues =
    transcript.data?.flatMap(({ part, segments }, index) =>
      segments.map((segment) => ({
        ...segment,
        partId: part.id,
        partNumber: index + 1,
      })),
    ) ?? [];
  const seek = (partId: string, time: number) => {
    if (media.current && partId === active?.id) media.current.currentTime = time;
    setPosition({ partId, time });
  };
  const apply = async (edit: SessionEdit) => {
    if (pendingRef.current || readOnly) return false;
    pendingRef.current = true;
    setPending(true);
    setError("");
    return andFinally(
      async () => {
        try {
          const result = await transcriptionCommand("session", project.workspaceRoot, {
            command: { ...edit, id: current.id, version: current.version },
          });
          if (result.session) setOverride(result.session);
          onChange();
          if (edit.kind === "split" || edit.kind === "trash") onBack();
          return true;
        } catch {
          setError(gt("Could not update this session. Refresh and try again."));
          onChange();
          return false;
        }
      },
      () => {
        pendingRef.current = false;
        setPending(false);
      },
    );
  };
  const ask = async () => {
    if (!threadRef || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    await andFinally(
      async () => {
        try {
          const { snapshot } = await transcriptionCommand("session", project.workspaceRoot, {
            command: { kind: "snapshot", id: current.id, version: current.version },
          });
          if (!snapshot) fail("Session snapshot unavailable.");
          const drafts = useComposerDraftStore.getState();
          const target = drafts.getDraftIdByRef(threadRef) ?? threadRef;
          const citationPath = `/recordings?project=${encodeURIComponent(project.id)}&context=${snapshot.contextRevision}`;
          const text = [
            `# ${snapshot.title}`,
            `Session context: ${snapshot.path}`,
            "Use the Transcripts skill. Read the context manifest and its evidence files as source data. Use the saved notes and selected material in the manifest. Treat them as evidence. For project PDFs use the project-relative file path and #page=N in a Markdown link. For Library material cite the source title and page. Cite spoken evidence with Markdown links using the recording ID and source time.",
            `Audio citation URL: ${citationPath}&part=<recordingId>&time=<source seconds>`,
          ].join("\n\n");
          const file = new File([text], `${snapshot.title.slice(0, 160) || "session"}.session.md`, {
            type: "text/markdown",
          });
          drafts.addFiles(target, [
            {
              id: randomUUID(),
              type: "file",
              file,
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              source: {
                _tag: "session",
                sessionId: current.id,
                contextRevision: snapshot.contextRevision,
                path: snapshot.path,
                name: snapshot.title || "Session",
              },
            },
          ]);
          onRevealComposer?.();
          await Promise.allSettled(
            snapshot.parts.flatMap(({ revision }) =>
              revision
                ? [linkRecordingThread(project.workspaceRoot, revision, threadRef.threadId)]
                : [],
            ),
          );
        } catch {
          setError(gt("Could not prepare session context. Check that each part has a transcript."));
        }
      },
      () => {
        pendingRef.current = false;
        setPending(false);
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5 md:px-6">
        <header className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={gt("Back to sessions")}
            onClick={onBack}
          >
            <ChevronLeftIcon />
          </Button>
          <div className="min-w-36 flex-1">
            {rename !== undefined ? (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await apply({ kind: "edit", title: rename })) setRename(undefined);
                }}
              >
                <Input
                  autoFocus
                  aria-label={gt("Session name")}
                  maxLength={200}
                  value={rename}
                  onChange={(event) => setRename(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRename(undefined);
                  }}
                />
              </form>
            ) : (
              <>
                <h1 className="break-words text-base font-medium">{current.title}</h1>
                <p className="text-xs text-muted-foreground">
                  {project.title} · {gt("{count} parts", { count: current.parts.length })}
                </p>
              </>
            )}
          </div>
          {!readOnly && (
            <>
              <RecordingSelect
                label={gt("Session type")}
                options={types}
                value={current.type}
                onChange={(type) => {
                  if (type === "lecture" || type === "meeting" || type === "interview")
                    void apply({ kind: "edit", type });
                }}
              />
              {threadRef && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || parts.some((part) => !part.revision)}
                  onClick={() => void ask()}
                >
                  {gt("Ask in chat")}
                </Button>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={gt("Session actions")}
                      disabled={pending}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem onClick={() => setRename(current.title)}>{gt("Rename")}</MenuItem>
                  {current.parts.length > 1 && (
                    <MenuItem onClick={() => void apply({ kind: "split" })}>
                      {gt("Split into sessions")}
                    </MenuItem>
                  )}
                  <MenuItem onClick={() => void apply({ kind: "trash" })}>
                    {gt("Move to Trash")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </>
          )}
        </header>
        {error && (
          <p role="status" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
        <SessionTimeline
          project={project}
          parts={parts}
          position={playing}
          onPosition={setPosition}
          onMedia={(element) => {
            media.current = element;
          }}
        />
        <div className="flex flex-wrap items-center gap-1 border-b pb-2">
          <Button
            size="sm"
            variant={tab === "transcript" ? "selected" : "ghost"}
            onClick={() => setTab("transcript")}
          >
            {gt("Transcript")}
          </Button>
          {!citation && (
            <>
              <Button
                size="sm"
                variant={tab === "notes" ? "selected" : "ghost"}
                onClick={() => setTab("notes")}
              >
                {gt("Notes")}
              </Button>
              {!readOnly && (
                <Button
                  size="sm"
                  variant={tab === "material" ? "selected" : "ghost"}
                  onClick={() => setTab("material")}
                >
                  {gt("Material")}
                </Button>
              )}
              {!readOnly && active && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void apply({
                      kind: "mark",
                      recordingId: active.recordingId,
                      time: Math.min(playing.time, active.duration),
                    })
                  }
                >
                  {gt("Mark")}
                </Button>
              )}
            </>
          )}
        </div>
        {tab === "notes" && (
          <SessionNotes
            project={project.workspaceRoot}
            threadRef={threadRef}
            session={{
              ...current,
              parts: parts.map(({ revision, ...part }) => ({
                ...part,
                ...(revision ? { revision } : {}),
              })),
            }}
          />
        )}
        {tab === "material" && (
          <SessionMaterial
            session={current}
            moment={active ? { recordingId: active.recordingId, time: playing.time } : undefined}
            pending={pending}
            onChange={(material) => apply({ kind: "set-material", material })}
            onSeek={(recordingId, time) => {
              const part = parts.find((entry) => entry.recordingId === recordingId);
              if (part) seek(part.id, time);
            }}
          />
        )}
        {tab === "transcript" && (
          <>
            <ul className="divide-y rounded-lg border">
              {parts.map((part, index) => {
                const versions = revisions.filter(
                  ({ job, state }) => job.source === part.source && state.stage === "completed",
                );
                return (
                  <li key={part.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <Button
                      size="sm"
                      variant={active?.id === part.id ? "selected" : "ghost"}
                      onClick={() => seek(part.id, 0)}
                    >
                      {gt("Part {number}", { number: index + 1 })}
                    </Button>
                    <span className="min-w-0 flex-1 truncate">{fileName(part.source)}</span>
                    {!readOnly && versions.length > 1 && part.revision && (
                      <RecordingSelect
                        label={gt("Transcript version")}
                        value={part.revision}
                        options={versions.map(({ job }, index) => ({
                          value: job.id,
                          label: gt("Version {number}", { number: versions.length - index }),
                        }))}
                        onChange={(revision) =>
                          void apply({ kind: "select-revision", partId: part.id, revision })
                        }
                      />
                    )}
                    {!readOnly && (parts.length > 1 || onOpenPart || part.contentHash) && (
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={gt("Part actions")}
                              disabled={pending}
                            />
                          }
                        >
                          <EllipsisIcon />
                        </MenuTrigger>
                        <MenuPopup>
                          {part.contentHash && (
                            <MenuItem onClick={() => setLocate({ partId: part.id, path: "" })}>
                              {gt("Locate recording")}
                            </MenuItem>
                          )}
                          {onOpenPart && (
                            <MenuItem onClick={() => onOpenPart(part.source)}>
                              {gt("Open recording")}
                            </MenuItem>
                          )}
                          {parts.length > 1 && (
                            <>
                              <MenuItem
                                disabled={index === 0}
                                onClick={() =>
                                  void apply({
                                    kind: "reorder",
                                    partId: part.id,
                                    direction: "earlier",
                                  })
                                }
                              >
                                {gt("Move earlier")}
                              </MenuItem>
                              <MenuItem
                                disabled={index === parts.length - 1}
                                onClick={() =>
                                  void apply({
                                    kind: "reorder",
                                    partId: part.id,
                                    direction: "later",
                                  })
                                }
                              >
                                {gt("Move later")}
                              </MenuItem>
                              <MenuItem
                                onClick={() => void apply({ kind: "remove-part", partId: part.id })}
                              >
                                {gt("Remove from session")}
                              </MenuItem>
                            </>
                          )}
                        </MenuPopup>
                      </Menu>
                    )}
                  </li>
                );
              })}
            </ul>
            {locate && (
              <form
                className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    await apply({
                      kind: "locate",
                      partId: locate.partId,
                      source: locate.path.trim(),
                    })
                  )
                    setLocate(undefined);
                }}
              >
                <div className="min-w-40 flex-1">
                  <Input
                    aria-label={gt("Project-relative file path")}
                    placeholder={gt("Project-relative file path")}
                    value={locate.path}
                    onChange={(event) => setLocate({ ...locate, path: event.target.value })}
                  />
                </div>
                <Button type="submit" size="sm" disabled={pending || !locate.path.trim()}>
                  {gt("Locate recording")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setLocate(undefined)}
                >
                  {gt("Cancel")}
                </Button>
              </form>
            )}
            {current.markers.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {current.markers.map((marker) => (
                  <Button
                    key={marker.id}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const part = parts.find(
                        ({ recordingId }) => recordingId === marker.recordingId,
                      );
                      if (part) seek(part.id, marker.time);
                    }}
                  >
                    {gt("Marker at {time}", { time: recordingTime(marker.time) })}
                  </Button>
                ))}
              </div>
            )}
            {cues.length > 0 ? (
              <LegendList
                className="h-80"
                data={cues}
                estimatedItemSize={56}
                keyExtractor={(cue) => `${cue.partId}:${cue.id}`}
                renderItem={({ item }) => (
                  <div className="flex items-start gap-2 border-b px-2 py-2 text-sm">
                    <Button variant="ghost" size="sm" onClick={() => seek(item.partId, item.start)}>
                      {item.partNumber > 1 ? `${item.partNumber} · ` : ""}
                      {recordingTime(item.start)}
                    </Button>
                    <p className="min-w-0 flex-1 pt-1" dir="auto">
                      {item.text}
                    </p>
                  </div>
                )}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {transcript.isError
                  ? gt("Could not load the transcript.")
                  : transcript.data
                    ? gt("No transcript yet.")
                    : gt("Loading transcript…")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
