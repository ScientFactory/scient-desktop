import type { RecordingSession, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { lazy, Suspense, useState } from "react";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../../components/ui/button";
import { listRecordingNotes, listSessionNotes, makeSessionNotes } from "../../rpc/transcription";
import { andFinally } from "../../lib/compilerSafe";
import { RecordingSelect } from "./RecordingSelect";
import { useRecordingRead } from "./useRecordingRead";

const Markdown = lazy(() => import("../../components/ChatMarkdown"));

export function SessionNotes({
  project,
  session,
  threadRef,
}: {
  project: string;
  session: RecordingSession;
  threadRef?: ScopedThreadRef | undefined;
}) {
  const gt = useGT();
  const [currentPath, setCurrentPath] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const revisions = [
    ...new Set(session.parts.flatMap(({ revision }) => (revision ? [revision] : []))),
  ];
  const priorSessions = [
    ...new Set(
      session.parts.flatMap(({ previousSessionId }) =>
        previousSessionId ? [previousSessionId] : [],
      ),
    ),
  ];
  const notes = useRecordingRead(
    JSON.stringify([session.id, revisions, priorSessions]),
    async (signal) => {
      const generated = await listSessionNotes(project, session.id, signal);
      const originals = await Promise.allSettled([
        ...priorSessions.map((id) => listSessionNotes(project, id, signal)),
        ...revisions.map((id) => listRecordingNotes(project, id, signal)),
      ]);
      return [
        ...new Map(
          [
            ...generated,
            ...originals.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
          ].map((note) => [note.path, note]),
        ).values(),
      ];
    },
    3000,
    refresh,
  );
  const current = notes.data?.find(({ path }) => path === currentPath) ?? notes.data?.[0];
  const make = async () => {
    setPending(true);
    setError("");
    await andFinally(
      async () => {
        try {
          const result = await makeSessionNotes(project, session.id, session.version);
          if ("needsModel" in result) setError(gt("Set up a model in Settings to make notes."));
          else {
            setCurrentPath("");
            setRefresh((value) => value + 1);
          }
        } catch {
          setError(gt("Could not make session notes. Check that each part has a transcript."));
        }
      },
      () => setPending(false),
    );
  };
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!session.archived && (
          <Button size="sm" onClick={() => void make()} disabled={pending}>
            {gt("Make notes")}
          </Button>
        )}
        {current?.text && threadRef && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => useRightPanelStore.getState().openFile(threadRef, current.path)}
          >
            {gt("Open notes file")}
          </Button>
        )}
        {current && (notes.data?.length ?? 0) > 1 && (
          <RecordingSelect
            label={gt("Notes version")}
            value={current.path}
            options={notes.data!.map((note, index) => ({
              value: note.path,
              label: gt("Notes {number}", { number: notes.data!.length - index }),
            }))}
            onChange={setCurrentPath}
          />
        )}
      </div>
      {error || notes.isError ? (
        <p role="status" className="text-sm text-muted-foreground">
          {error || gt("Could not load session notes.")}
        </p>
      ) : current?.text ? (
        <Suspense fallback={null}>
          <Markdown text={current.text} cwd={project} />
        </Suspense>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {current ? gt("Waiting for notes…") : gt("No session notes yet.")}
        </p>
      )}
    </section>
  );
}
