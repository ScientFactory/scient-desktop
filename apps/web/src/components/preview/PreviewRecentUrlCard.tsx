import type { ScopedThreadRef } from "@t3tools/contracts";
import { X } from "lucide-react";

import { isValidHistoryTimestamp, type BrowserHistoryEntry } from "~/browserHistoryStore";
import { RelativeTime } from "~/components/RelativeTime";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";

interface Props {
  threadRef: ScopedThreadRef;
  entry: BrowserHistoryEntry;
  onOpen: () => void;
  onRemove: () => void;
}

export function PreviewRecentUrlCard({ threadRef, entry, onOpen, onRemove }: Props) {
  const parsed = new URL(entry.url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  const visitedAt = isValidHistoryTimestamp(entry.lastVisitedAt) ? (
    <RelativeTime timestamp={new Date(entry.lastVisitedAt).toISOString()} />
  ) : null;
  return (
    <div className="group relative flex w-full items-center">
      {/* SCIENT-FORK:START — Scient Browser: one thin line per recent site. */}
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 pr-10 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <PreviewFaviconIcon threadRef={threadRef} url={entry.url} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {entry.title ?? label}
        </span>
        <span className="max-w-1/2 truncate text-xs text-muted-foreground">
          {entry.title ? `${parsed.host} · ` : ""}
          {visitedAt}
        </span>
      </button>
      {/* SCIENT-FORK:END */}
      <button
        type="button"
        aria-label={`Remove ${label} from history`}
        onClick={onRemove}
        className="absolute right-3 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
