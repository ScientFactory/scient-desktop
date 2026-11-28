import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { EnvironmentFilePath } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";
import { ChevronLeftIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { MiddleTruncate } from "../../components/ui/middle-truncate";
import { fail } from "../../lib/compilerSafe";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { RecordingPlayer } from "./RecordingPlayer";
import { useRecordingTitle } from "./recordingTitle";
import type { Project } from "./recordingTypes";
import { TranscribeDialog } from "./TranscribeDialog";
import { useRecordingRead } from "./useRecordingRead";

/** A recording added to Scient that has no transcript yet: play it, or transcribe it. */
export function RecordingFileView({
  project,
  source,
  title,
  duration,
  created,
  onBack,
  onStart,
}: {
  project: Project;
  source: string;
  title?: string | undefined;
  duration?: number | undefined;
  created?: number | undefined;
  onBack: () => void;
  onStart: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const recordingTitle = useRecordingTitle();
  const baseUrl = useEnvironmentHttpBaseUrl(project.environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const resume = useRef<{ time: number; play: boolean }>(undefined);
  const [time, setTime] = useState(0);
  const [theater, setTheater] = useState(false);
  const [transcribe, setTranscribe] = useState(false);
  const mediaQuery = useRecordingRead(
    baseUrl ? source : "",
    async () => {
      const request = {
        environmentId: project.environmentId,
        input: {
          resource: {
            _tag: "environment-file" as const,
            path: EnvironmentFilePath.make(source),
            access: "exact" as const,
          },
        },
      };
      // The link expires; after that, ask the server for a new one.
      if (mediaRefresh > 0) appAtomRegistry.refresh(assetEnvironment.createUrl(request));
      const result = await createAssetUrl(request);
      if (result._tag === "Failure") fail(gt("Could not open the recording"));
      return resolveAssetUrl(baseUrl!, result.value.relativeUrl);
    },
    undefined,
    mediaRefresh,
  );
  const video = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(source);
  return (
    <div className="@container/recording flex h-full min-h-0 flex-col overflow-auto scrollbar-gutter-both">
      {transcribe && (
        <TranscribeDialog
          project={project.workspaceRoot}
          projectTitle={project.title}
          source={source}
          title={recordingTitle(source, title)}
          onClose={() => setTranscribe(false)}
          onStart={() => {
            setTranscribe(false);
            onStart();
          }}
        />
      )}
      <header
        className={
          video
            ? "flex shrink-0 items-center gap-2 border-b px-3 py-2"
            : "mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 px-4 pt-8 pb-2"
        }
      >
        <span className={video ? undefined : "-ms-2"}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label={gt("Back to recordings")}
          >
            <ChevronLeftIcon />
          </Button>
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-medium">
            <MiddleTruncate value={recordingTitle(source, title)} />
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {project.title}
            {created
              ? ` · ${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(created)}`
              : ""}
          </p>
        </div>
        <Button size="sm" onClick={() => setTranscribe(true)}>
          {gt("Transcribe…")}
        </Button>
      </header>
      <div className={`shrink-0 ${video ? "" : "mx-auto w-full max-w-3xl px-4 pt-4"}`}>
        {mediaQuery.data && (
          <RecordingPlayer
            key={mediaQuery.data}
            knownDuration={duration}
            onMedia={() => undefined}
            src={mediaQuery.data}
            video={video}
            onReady={(element) => {
              const pending = resume.current;
              if (!pending) return;
              resume.current = undefined;
              element.currentTime = pending.time;
              if (pending.play) void element.play().catch(() => undefined);
            }}
            onStale={(wasPlaying) => {
              resume.current = { time, play: wasPlaying };
              setMediaRefresh((value) => value + 1);
            }}
            time={time}
            onTime={setTime}
            theater={theater}
            onTheater={() => setTheater(!theater)}
            caption=""
          />
        )}
        {mediaQuery.isError && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {gt("Could not open the recording")}
          </p>
        )}
      </div>
    </div>
  );
}
