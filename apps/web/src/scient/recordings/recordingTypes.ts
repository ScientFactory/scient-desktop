import type { useProjects } from "../../state/entities";
import type { RecordingStatus } from "../../rpc/transcription";

export type Project = ReturnType<typeof useProjects>[number];
export type Recording = { project: Project; revisions: RecordingStatus[] };

export const fileName = (path: string) => path.split(/[/\\]/).at(-1) ?? path;
