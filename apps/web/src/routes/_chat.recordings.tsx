import { createFileRoute } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";
import { RecordingsPage } from "../scient/recordings/RecordingsPage";

export const Route = createFileRoute("/_chat/recordings")({
  validateSearch: (search: Record<string, unknown>): { project?: string; source?: string } => ({
    ...(typeof search.project === "string" ? { project: search.project } : {}),
    ...(typeof search.source === "string" ? { source: search.source } : {}),
  }),
  component: RecordingsRoute,
});

function RecordingsRoute() {
  const { project, source } = Route.useSearch();
  return (
    <SidebarInset className="h-dvh min-w-0">
      <RecordingsPage
        key={project ?? "all"}
        {...(project ? { lockedProject: project } : {})}
        {...(source ? { openSource: source } : {})}
      />
    </SidebarInset>
  );
}
