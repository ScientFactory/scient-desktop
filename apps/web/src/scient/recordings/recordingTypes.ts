import type { useProjects } from "../../state/entities";
import type { RecordingStatus } from "../../rpc/transcription";

export type Project = ReturnType<typeof useProjects>[number];
export type Recording = { project: Project; revisions: RecordingStatus[] };

export const fileName = (path: string) => path.split(/[/\\]/).at(-1) ?? path;

/** When Scient recorded the file, from the name it gives a recording it captures. */
export function capturedAt(path: string) {
  const match = /^Recording (\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z [0-9a-f]{8}\.\w+$/.exec(
    fileName(path),
  );
  return match
    ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
    : undefined;
}
