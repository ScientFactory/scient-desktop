import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { EnvironmentFilePath, type RecordingSessionPart } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useRef, useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { fail } from "../../lib/compilerSafe";
import { RecordingPlayer } from "./RecordingPlayer";
import type { Project } from "./recordingTypes";
import { useRecordingRead } from "./useRecordingRead";

export type SessionPosition = { partId: string; time: number };

export function SessionTimeline({
  project,
  parts,
  position,
  onPosition,
  onMedia,
}: {
  project: Project;
  parts: readonly RecordingSessionPart[];
  position: SessionPosition;
  onPosition: (position: SessionPosition) => void;
  onMedia: (element: HTMLMediaElement | null) => void;
}) {
  const gt = useGT();
  const base = useEnvironmentHttpBaseUrl(project.environmentId);
  const asset = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const [refresh, setRefresh] = useState(0);
  const [theater, setTheater] = useState(false);
  const resume = useRef(false);
  const media = useRef<HTMLMediaElement>(null);
  const active = parts.find((part) => part.id === position.partId);
  const source = active?.mediaSource ?? active?.source;
  const activeIndex = parts.findIndex((part) => part.id === active?.id);
  const duration = parts.reduce((sum, part) => sum + part.duration, 0);
  const offset = parts
    .slice(0, Math.max(0, activeIndex))
    .reduce((sum, part) => sum + part.duration, 0);
  const url = useRecordingRead(
    base && source && !active?.transcriptOnly ? source : "",
    async () => {
      const request = {
        environmentId: project.environmentId,
        input: {
          resource: {
            _tag: "environment-file" as const,
            path: EnvironmentFilePath.make(source!),
            access: "exact" as const,
          },
        },
      };
      if (refresh > 0) appAtomRegistry.refresh(assetEnvironment.createUrl(request));
      const result = await asset(request);
      if (result._tag === "Failure") fail(gt("Could not open the recording"));
      return resolveAssetUrl(base!, result.value.relativeUrl);
    },
    undefined,
    refresh,
  );
  const seek = (seconds: number) => {
    let start = 0;
    for (const part of parts) {
      const end = start + part.duration;
      if (part.duration > 0 && (seconds < end || (end === duration && seconds === duration))) {
        const time = Math.max(0, seconds - start);
        if (active?.id === part.id && media.current) media.current.currentTime = time;
        else resume.current = media.current?.paused === false;
        onPosition({ partId: part.id, time });
        break;
      }
      start = end;
    }
  };
  return (
    <div className="space-y-2">
      {url.data && active ? (
        <RecordingPlayer
          key={JSON.stringify([active.id, url.data])}
          src={url.data}
          video={/\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(source ?? "")}
          caption=""
          theater={theater}
          onTheater={() => setTheater((value) => !value)}
          knownDuration={active.duration}
          time={position.time}
          timeline={
            parts.length > 1 && duration > 0
              ? {
                  time: offset + position.time,
                  duration,
                  onSeek: seek,
                }
              : undefined
          }
          onTime={(time) => onPosition({ partId: active.id, time })}
          onMedia={(element) => {
            media.current = element;
            onMedia(element);
          }}
          onReady={(element) => {
            element.currentTime = position.time;
            if (resume.current) void element.play().catch(() => undefined);
            resume.current = false;
          }}
          onStale={(playing) => {
            resume.current = playing;
            setRefresh((value) => value + 1);
          }}
          onEnded={() => {
            const next = parts.slice(activeIndex + 1).find((part) => part.duration > 0);
            if (next) {
              resume.current = true;
              onPosition({ partId: next.id, time: 0 });
            }
          }}
        />
      ) : active && !active.transcriptOnly ? (
        <p role="status" className="text-sm text-muted-foreground">
          {url.isError ? gt("Could not open the recording") : gt("Loading recording…")}
        </p>
      ) : null}
    </div>
  );
}
