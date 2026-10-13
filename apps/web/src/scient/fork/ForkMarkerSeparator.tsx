import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

/**
 * "Conversation forked here", linked to the conversation it came from when
 * that is known (scient/fork/forkTimelineMarkers.ts places the rows).
 */
export function ForkMarkerSeparator({
  environmentId,
  originThreadId,
}: {
  environmentId: EnvironmentId;
  originThreadId: ThreadId | undefined;
}) {
  return (
    <div className="flex items-center gap-3 px-1 py-3 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border/60" />
      <span className="shrink-0 rounded-full border border-border/70 bg-muted/35 px-2.5 py-1">
        {originThreadId ? (
          <Link
            to="/$environmentId/$threadId"
            params={{
              environmentId,
              threadId: originThreadId,
            }}
            className="hover:text-foreground hover:underline"
            aria-label="Open original conversation"
          >
            Conversation forked here
          </Link>
        ) : (
          "Conversation forked here"
        )}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}
