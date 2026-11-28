import { createFileRoute, useRouter } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";
import { RecordingsPage } from "../scient/recordings/RecordingsPage";
import { SessionView } from "../scient/recordings/SessionView";
import { useRecordingRead } from "../scient/recordings/useRecordingRead";
import { transcriptionCommand } from "../rpc/transcription";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useGT } from "gt-react";

export const Route = createFileRoute("/_chat/recordings")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    project?: string;
    source?: string;
    fromThread?: string;
    context?: string;
    part?: string;
    time?: number;
  } => ({
    ...(typeof search.context === "string" && /^[a-f0-9-]{36}$/.test(search.context)
      ? { context: search.context }
      : {}),
    ...(typeof search.part === "string" && /^[a-f0-9-]{36}$/.test(search.part)
      ? { part: search.part }
      : {}),
    ...(typeof search.time === "number" && Number.isFinite(search.time) && search.time >= 0
      ? { time: search.time }
      : {}),
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(typeof search.source === "string" ? { source: search.source } : {}),
    ...(typeof search.fromThread === "string" && search.fromThread
      ? { fromThread: search.fromThread }
      : {}),
  }),
  component: RecordingsRoute,
});

function RecordingsRoute() {
  const { project, source, fromThread, context, part, time } = Route.useSearch();
  return (
    <SidebarInset className="h-dvh min-w-0">
      {project && context ? (
        <SessionCitation
          key={JSON.stringify([project, context, part, time])}
          projectId={project}
          contextRevision={context}
          recordingId={part}
          time={time}
        />
      ) : (
        <RecordingsPage
          key={project ?? "all"}
          {...(project ? { lockedProject: project } : {})}
          {...(source ? { openSource: source } : {})}
          {...(fromThread ? { fromThread } : {})}
        />
      )}
    </SidebarInset>
  );
}

function SessionCitation({
  projectId,
  contextRevision,
  recordingId,
  time,
}: {
  projectId: string;
  contextRevision: string;
  recordingId: string | undefined;
  time: number | undefined;
}) {
  const gt = useGT();
  const router = useRouter();
  const environmentId = usePrimaryEnvironmentId();
  const project = useProjects().find(
    (item) => item.id === projectId && item.environmentId === environmentId,
  );
  const evidence = useRecordingRead(project ? contextRevision : "", (signal) =>
    transcriptionCommand(
      "session",
      project!.workspaceRoot,
      {
        command: { kind: "read-snapshot", contextRevision },
      },
      signal,
    ),
  );
  const snapshot = evidence.data?.snapshot;
  if (!project || !snapshot) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        {evidence.isError
          ? gt("Could not open session evidence.")
          : gt("Loading session evidence…")}
      </p>
    );
  }
  return (
    <SessionView
      project={project}
      session={{ ...snapshot, id: snapshot.sessionId, version: 1, created: 0 }}
      revisions={[]}
      citation={{
        contextRevision,
        ...(recordingId ? { recordingId } : {}),
        ...(time !== undefined ? { time } : {}),
      }}
      onBack={() => void router.navigate({ to: "/recordings", search: { project: projectId } })}
      onChange={() => {}}
    />
  );
}
