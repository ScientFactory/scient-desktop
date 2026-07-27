// FILE: ForkProvenanceMarker.tsx
// Purpose: Render a compact, accessible source marker at the start of forked transcripts.
// Layer: Web chat presentation component

import type { ThreadId } from "@synara/contracts";

import { ConversationForkIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ForkProvenance } from "./forkProvenance";

interface ForkProvenanceMarkerProps {
  provenance: ForkProvenance;
  onOpenSource?: (threadId: ThreadId) => void;
}

export function ForkProvenanceMarker({ provenance, onOpenSource }: ForkProvenanceMarkerProps) {
  const hasMessageBoundary = provenance.sourceMessageId !== null;
  const sourceLabel = provenance.sourceTitle ?? "another conversation";
  const canOpenSource = provenance.sourceAvailable && onOpenSource !== undefined;

  return (
    <div
      role="note"
      aria-label="Fork provenance"
      data-fork-provenance="true"
      data-fork-source-thread-id={provenance.sourceThreadId}
      data-fork-source-message-id={provenance.sourceMessageId ?? undefined}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3 py-2 font-system-ui text-xs text-muted-foreground"
    >
      <ConversationForkIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground/70"
      />
      <p className="min-w-0 [overflow-wrap:anywhere] leading-5">
        <span>{hasMessageBoundary ? "Forked from a message in " : "Forked from "}</span>
        {canOpenSource ? (
          <button
            type="button"
            className={cn(
              "max-w-full rounded-sm font-medium text-foreground/80 underline decoration-border underline-offset-2",
              "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            )}
            aria-label={`Open source conversation: ${sourceLabel}`}
            title={`Open source conversation: ${sourceLabel}`}
            onClick={() => onOpenSource(provenance.sourceThreadId)}
          >
            {sourceLabel}
          </button>
        ) : (
          <span className="font-medium text-foreground/70">{sourceLabel}</span>
        )}
        {!provenance.sourceAvailable ? (
          <span className="text-muted-foreground/70"> · Source unavailable</span>
        ) : null}
      </p>
    </div>
  );
}
