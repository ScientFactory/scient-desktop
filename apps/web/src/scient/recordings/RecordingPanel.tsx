import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useState } from "react";
import { transcriptionCommand } from "../../rpc/transcription";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProjects } from "../../state/entities";
import type { ScientRightPanelSurface } from "../rightPanel/surfaces";
import { RecordingView } from "./RecordingView";
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
      const revisions = await transcriptionCommand(
        "list",
        project!.workspaceRoot,
        { includeCreated: true },
        signal,
      );
      return revisions.filter(({ job }) => job.source === surface.source);
    },
    3000,
    refresh,
  );
  if (project && list.data?.length) {
    return (
      <RecordingView
        key={JSON.stringify(surface.match)}
        recording={{ project, revisions: list.data }}
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
