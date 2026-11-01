import type { ConnectorProviderSupport, ExtensionAudience } from "@t3tools/contracts";
import { useState } from "react";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { useExtensionsEnvironment, GHOST_LINK_CLASS } from "./ExtensionsPage";
import { audienceLabel, audienceSupport, worksWithCardAgents } from "./extensionsView";

/** An agent's logo with its name below; an amber dot marks one that works with limits. */
function AgentTileContent({
  entry,
  iconUrl,
}: {
  readonly entry: ConnectorProviderSupport;
  readonly iconUrl: string | undefined;
}) {
  return (
    <>
      <ProviderInstanceIcon
        driverKind={entry.driver}
        displayName={entry.displayName}
        acpRegistryIconUrl={iconUrl}
        iconClassName="size-7"
        indicatorBackground="var(--popover)"
        {...(entry.status !== "supported" ? { statusDotClassName: "bg-warning" } : {})}
      />
      <span className="line-clamp-2 w-full text-xs leading-tight text-muted-foreground">
        {entry.displayName}
      </span>
    </>
  );
}

const AGENT_TILE_CLASS = "flex w-[4.5rem] flex-col items-center gap-1.5 py-1 text-center";

/** How long the pointer rests on "Works with" before its card opens. */
const WORKS_WITH_OPEN_DELAY_MS = 200;

/**
 * A press pins the reason even if hover/focus just opened it; otherwise a tap following focus would
 * immediately close the explanation. Keep the tooltip inside the card's open scope.
 */
function LimitedAgentTile({
  entry,
  iconUrl,
}: {
  readonly entry: ConnectorProviderSupport;
  readonly iconUrl: string | undefined;
}) {
  const [shown, setShown] = useState<"closed" | "shown" | "pinned">("closed");
  const reason = entry.reason ?? "Works with limits";
  return (
    <Tooltip
      open={shown !== "closed"}
      onOpenChange={(next, details) => {
        // Presses are handled below; everything else shows or hides it.
        if (details.reason === "trigger-press") return;
        if (!next) setShown("closed");
        else setShown((current) => (current === "pinned" ? "pinned" : "shown"));
      }}
    >
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${entry.displayName}: ${reason}`}
            onClick={() => setShown((current) => (current === "pinned" ? "closed" : "pinned"))}
            className={cn(
              AGENT_TILE_CLASS,
              "cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          />
        }
      >
        <AgentTileContent entry={entry} iconUrl={iconUrl} />
      </TooltipTrigger>
      <TooltipPopup side="top">{reason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Move keyboard focus into the card so Tab can reach limited agents' reasons; omit unusable agents
 * because the count already communicates their absence.
 */
const SCIENT_AUDIENCE = { layer: "scient" } as const;

export function WorksWithValue({
  audience = SCIENT_AUDIENCE,
}: {
  readonly audience?: ExtensionAudience | undefined;
}) {
  const { inventory, providers } = useExtensionsEnvironment();
  const support = audienceSupport(audience, providers, inventory?.providerSupport ?? []);
  if (support.length === 0) {
    return <span className="text-muted-foreground">No agents reported</span>;
  }
  const usable = worksWithCardAgents(audience, support);
  const count = audienceLabel(audience);
  if (usable.length === 0) return <span>{count}</span>;
  const iconUrlOf = (entry: ConnectorProviderSupport) =>
    providers.find((provider) => provider.instanceId === entry.providerInstanceId)?.iconUrl;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={WORKS_WITH_OPEN_DELAY_MS}
        closeDelay={120}
        render={
          <button
            type="button"
            aria-label={`Works with: ${count}`}
            className={cn(GHOST_LINK_CLASS, "text-foreground")}
          />
        }
      >
        {count}
      </PopoverTrigger>
      {/* Above the count, left edges aligned; below only when there is no room
          above, and shifted sideways only as far as the viewport needs. */}
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
        padding="comfortable"
        aria-label="Agents"
        initialFocus={(openType) => openType === "keyboard"}
        className="w-max"
      >
        {/* The width limit sits on the content, independent of the positioner's
            measurements, so the card is measured, and placed, at that width.
            A wide 4rem fade marks whichever edge still has more agents, so the
            row reads as scrollable. */}
        <ScrollArea
          scrollFade
          hideScrollbars
          className="h-auto max-w-[min(396px,calc(100vw-3rem))] [&>[data-slot=scroll-area-viewport]]:[--fade-size:4rem]"
        >
          <ul className="flex w-max gap-1">
            {usable.map((entry) => (
              <li
                key={entry.providerInstanceId}
                data-support={entry.status}
                className={entry.status !== "supported" ? undefined : AGENT_TILE_CLASS}
              >
                {entry.status !== "supported" ? (
                  <LimitedAgentTile entry={entry} iconUrl={iconUrlOf(entry)} />
                ) : (
                  <AgentTileContent entry={entry} iconUrl={iconUrlOf(entry)} />
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
}
