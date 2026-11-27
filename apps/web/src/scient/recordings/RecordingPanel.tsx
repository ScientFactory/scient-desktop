import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import { transcriptionCommand } from "../../rpc/transcription";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProjects } from "../../state/entities";
import type { ScientRightPanelSurface } from "../rightPanel/surfaces";
import { RecordingFileView } from "./RecordingFileView";
import { RecordingView } from "./RecordingView";
import { SessionView } from "./SessionView";
import { useRecordingTitle } from "./recordingTitle";
import { useRecordingRead } from "./useRecordingRead";

export default function RecordingPanel({
  surface,
  threadRef,
  onRevealComposer,
  onClose,
}: {
  surface: Extract<ScientRightPanelSurface, { module: "recording" }>;
  threadRef: ScopedThreadRef;
  onRevealComposer: () => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const router = useRouter();
  const project = useProjects().find(
    (item) => item.id === surface.projectId && item.environmentId === threadRef.environmentId,
  );
  const [refresh, setRefresh] = useState(0);
  const [openPart, setOpenPart] = useState<string>();
  const source = openPart ?? surface.source;
  const list = useRecordingRead(
    project ? JSON.stringify([surface.id, source]) : "",
    async (signal) => {
      const [revisions, files, sessions] = await Promise.all([
        transcriptionCommand("list", project!.workspaceRoot, { includeCreated: true }, signal),
        transcriptionCommand("media-list", project!.workspaceRoot, {}, signal).catch(() => ({
          media: [],
        })),
        surface.sessionId
          ? transcriptionCommand(
              "session",
              project!.workspaceRoot,
              { command: { kind: "list" } },
              signal,
            )
          : undefined,
      ]);
      const file = files.media.find((item) => item.source === source);
      return {
        session: sessions?.sessions.find(({ id, trashed }) => id === surface.sessionId && !trashed),
        allRevisions: revisions,
        revisions: revisions.filter(({ job }) => job.source === source),
        file,
        title: file?.title,
        duration: file?.duration,
      };
    },
    3000,
    refresh,
  );
  const recordingTitle = useRecordingTitle();
  const tabTitle = list.data
    ? (list.data.session?.title ?? recordingTitle(surface.source, list.data.title))
    : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a tab opened before a rename shows the recording's current name.
  useEffect(() => {
    if (tabTitle && tabTitle !== surface.title)
      useRightPanelStore.getState().openScient(threadRef, { ...surface, title: tabTitle });
  }, [tabTitle, surface, threadRef]);
  const back = () => {
    if (openPart) {
      setOpenPart(undefined);
      return;
    }
    // The recording opened maximized over its thread; going back leaves that thread as it was.
    useRightPanelStore.getState().setMaximized(threadRef, false);
    onClose();
    void router.navigate({ to: "/recordings", search: { fromThread: threadRef.threadId } });
  };
  if (project && list.data?.session && !openPart) {
    return (
      <SessionView
        key={list.data.session.id}
        project={project}
        session={list.data.session}
        revisions={list.data.allRevisions}
        threadRef={threadRef}
        onRevealComposer={onRevealComposer}
        onBack={back}
        onChange={() => setRefresh((value) => value + 1)}
        onOpenPart={setOpenPart}
      />
    );
  }
  if (project && list.data?.revisions.length) {
    return (
      <RecordingView
        key={JSON.stringify(surface.match)}
        recording={{ project, revisions: list.data.revisions }}
        title={list.data.title}
        duration={list.data.duration}
        match={surface.match}
        threadRef={threadRef}
        onRevealComposer={onRevealComposer}
        onBack={back}
        onChange={() => setRefresh((value) => value + 1)}
      />
    );
  }
  if (project && list.data?.file) {
    const { file } = list.data;
    return (
      <RecordingFileView
        project={project}
        source={source}
        title={file.title}
        duration={file.duration}
        created={file.created}
        onBack={back}
        onStart={() => setRefresh((value) => value + 1)}
      />
    );
  }
  return (
    <p className="p-4 text-sm text-muted-foreground" role="status">
      {list.isError || list.data ? gt("Could not open the recording") : gt("Loading recording…")}
    </p>
  );
}
