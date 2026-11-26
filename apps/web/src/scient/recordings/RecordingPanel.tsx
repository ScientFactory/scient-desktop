import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import { transcriptionCommand } from "../../rpc/transcription";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProjects } from "../../state/entities";
import type { ScientRightPanelSurface } from "../rightPanel/surfaces";
import { RecordingView } from "./RecordingView";
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
  const list = useRecordingRead(
    project ? surface.id : "",
    async (signal) => {
      const [revisions, files] = await Promise.all([
        transcriptionCommand("list", project!.workspaceRoot, { includeCreated: true }, signal),
        transcriptionCommand("media-list", project!.workspaceRoot, {}, signal).catch(() => ({
          media: [],
        })),
      ]);
      const file = files.media.find((item) => item.source === surface.source);
      return {
        revisions: revisions.filter(({ job }) => job.source === surface.source),
        title: file?.title,
        duration: file?.duration,
      };
    },
    3000,
    refresh,
  );
  const recordingTitle = useRecordingTitle();
  const tabTitle = list.data ? recordingTitle(surface.source, list.data.title) : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a tab opened before a rename shows the recording's current name.
  useEffect(() => {
    if (tabTitle && tabTitle !== surface.title)
      useRightPanelStore.getState().openScient(threadRef, { ...surface, title: tabTitle });
  }, [tabTitle, surface, threadRef]);
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
        onBack={() => {
          // The recording opened maximized over its thread; going back leaves that thread as it was.
          useRightPanelStore.getState().setMaximized(threadRef, false);
          onClose();
          void router.navigate({ to: "/recordings", search: { fromThread: threadRef.threadId } });
        }}
        onChange={() => setRefresh((value) => value + 1)}
      />
    );
  }
  return (
    <p className="p-4 text-sm text-muted-foreground" role="status">
      {list.isError || list.data ? gt("Could not open the recording") : gt("Loading recording…")}
    </p>
  );
}
