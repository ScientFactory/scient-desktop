import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { isWorkspaceVideoPreviewPath } from "@t3tools/shared/filePreview";
import { isWorkspaceAudioPreviewPath } from "@t3tools/shared/mediaPreview";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { AudioLinesIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";

import { FileSurfaceAction } from "../../components/files/fileSurfaceChrome";
import { toastManager } from "../../components/ui/toast";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  linkRecordingThread,
  transcriptionCommand,
  type RecordingStatus,
} from "../../rpc/transcription";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { scientRecordingSurface } from "../rightPanel/surfaces";
import { fileName } from "./recordingTypes";
import { TranscribeDialog } from "./TranscribeDialog";
import { useRecordingRead } from "./useRecordingRead";

export const isTranscribablePath = (path: string) =>
  isWorkspaceAudioPreviewPath(path) || isWorkspaceVideoPreviewPath(path);

/** Transcribes a project's audio or video file where it is, then opens its transcript: in the
 * given or routed thread's panel, else through Recordings. A file with a transcript opens it. */
export function useTranscribeFile(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef?: ScopedThreadRef | null;
  readonly onStarted?: () => void;
}) {
  const gt = useGT();
  const router = useRouter();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const read = useEnvironmentScope(input.environmentId, AuthFilesystemReadScope);
  const write = useEnvironmentScope(input.environmentId, AuthFilesystemWriteScope);
  const operate = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const project = useProjects().find(
    (item) =>
      item.environmentId === input.environmentId &&
      item.workspaceRoot === input.cwd &&
      !item.isScratch,
  );
  const routeThreadRef = useThreadRouteRef();
  const threadRef = input.threadRef ?? routeThreadRef;
  const [pending, setPending] = useState<string>();
  const available =
    project !== undefined &&
    input.environmentId === primaryEnvironmentId &&
    read &&
    write &&
    operate;

  const latestTranscript = async (source: string, signal?: AbortSignal) => {
    if (!project) return undefined;
    const revisions = await transcriptionCommand(
      "list",
      project.workspaceRoot,
      { includeCreated: true, source },
      signal,
    );
    return revisions[0];
  };
  const openTranscript = async (recording: RecordingStatus) => {
    if (!project) return;
    const { source } = recording.job;
    if (!threadRef) {
      await router.navigate({ to: "/recordings", search: { project: project.id, source } });
      return;
    }
    const panel = useRightPanelStore.getState();
    panel.openScient(threadRef, scientRecordingSurface(project.id, source));
    panel.requestMaximize(threadRef);
    panel.setMaximized(threadRef, true);
    await settlePromise(() =>
      linkRecordingThread(project.workspaceRoot, recording.job.id, threadRef.threadId),
    );
  };
  const failed = () =>
    toastManager.add({ type: "error", title: gt("Could not open the recording") });
  const transcribe = async (source: string) => {
    try {
      const latest = await latestTranscript(source);
      if (latest) await openTranscript(latest);
      else setPending(source);
    } catch {
      failed();
    }
  };
  const started = async (source: string) => {
    input.onStarted?.();
    try {
      const latest = await latestTranscript(source);
      if (latest) await openTranscript(latest);
    } catch {
      failed();
    }
  };

  return {
    available,
    latestTranscript,
    openTranscript: (recording: RecordingStatus) => openTranscript(recording).catch(failed),
    transcribe: (source: string) => void transcribe(source),
    dialog:
      pending && project ? (
        <TranscribeDialog
          key={pending}
          project={project.workspaceRoot}
          projectTitle={project.title}
          source={pending}
          title={fileName(pending)}
          onClose={() => setPending(undefined)}
          onStart={() => {
            setPending(undefined);
            void started(pending);
          }}
        />
      ) : null,
  };
}

/** The file viewer's Transcribe, or Open transcript once the file has one. */
export function TranscribeFileAction(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly absolutePath: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const gt = useGT();
  const [refresh, setRefresh] = useState(0);
  const action = useTranscribeFile({ ...props, onStarted: () => setRefresh((value) => value + 1) });
  const shown = action.available && isTranscribablePath(props.absolutePath);
  const transcript = useRecordingRead(
    shown ? props.absolutePath : "",
    (signal) => action.latestTranscript(props.absolutePath, signal),
    undefined,
    refresh,
  );
  if (!shown) return null;
  const latest = transcript.data;
  return (
    <>
      <FileSurfaceAction
        label={latest ? gt("Open transcript") : gt("Transcribe")}
        onPress={() =>
          latest ? void action.openTranscript(latest) : action.transcribe(props.absolutePath)
        }
      >
        {latest ? <FileTextIcon className="size-3.5" /> : <AudioLinesIcon className="size-3.5" />}
      </FileSurfaceAction>
      {action.dialog}
    </>
  );
}
