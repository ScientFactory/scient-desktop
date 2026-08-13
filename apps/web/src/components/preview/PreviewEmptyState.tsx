import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDown, Globe, History, RadioTower } from "lucide-react";
import { useMemo, useState } from "react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";
import {
  groupPreviewServers,
  localServerKey,
  localUrlKey,
  useDiscoveredLocalServers,
} from "./useDiscoveredLocalServers";

interface Props {
  environmentId: EnvironmentId;
  threadId: string;
  environmentHttpBaseUrl?: string | null | undefined;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentlySeenUrls?: ReadonlyArray<string> | undefined;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({
  environmentId,
  threadId,
  environmentHttpBaseUrl,
  configuredUrls,
  recentlySeenUrls,
  recentEntries,
  onRemoveRecent,
  onOpenUrl,
}: Props) {
  const [showOtherListening, setShowOtherListening] = useState(false);
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
    recentlySeenUrls,
  });
  const groups = useMemo(
    () => groupPreviewServers({ servers, threadId, environmentHttpBaseUrl }),
    [environmentHttpBaseUrl, servers, threadId],
  );
  const relevantServerKeys = useMemo(
    () => new Set(groups.relevant.map(localServerKey)),
    [groups.relevant],
  );
  const recents = recentEntries
    .filter((entry) => URL.canParse(entry.url))
    .filter((entry) => {
      const key = localUrlKey(entry.url);
      return key === null || !relevantServerKeys.has(key);
    })
    .slice(0, 8);
  const recentLocalKeys = new Set(
    recents.map((entry) => localUrlKey(entry.url)).filter((key): key is string => key !== null),
  );
  const otherListening = groups.otherListening.filter(
    (server) => !recentLocalKeys.has(localServerKey(server)),
  );

  if (groups.relevant.length === 0 && recents.length === 0 && otherListening.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No preview yet</EmptyTitle>
        <EmptyDescription>
          Type a URL above, or run a project dev script. Relevant local previews will show up here
          automatically.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="m-auto flex w-full max-w-xl flex-col gap-6">
        {groups.relevant.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RadioTower className="size-4 shrink-0" />
              <h2 className="font-medium">Local previews</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {groups.relevant.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {recents.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="size-4 shrink-0" />
              <h2 className="font-medium">Recently used</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {otherListening.length > 0 ? (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              aria-expanded={showOtherListening}
              onClick={() => setShowOtherListening((current) => !current)}
              className="flex w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RadioTower className="size-4 shrink-0" />
              <span>Find another local server</span>
              <span className="text-xs tabular-nums">{otherListening.length}</span>
              <ChevronDown
                className={`size-3.5 transition-transform ${showOtherListening ? "rotate-180" : ""}`}
              />
            </button>
            {showOtherListening ? (
              <>
                <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
                  {otherListening.map((server) => (
                    <PreviewLocalServerCard
                      key={`${server.host}:${server.port}`}
                      server={server}
                      onOpen={() => onOpenUrl(server.requestedUrl)}
                    />
                  ))}
                </div>
                <p className="px-1 text-xs text-muted-foreground">
                  Other listening ports on this environment may not be web apps.
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
