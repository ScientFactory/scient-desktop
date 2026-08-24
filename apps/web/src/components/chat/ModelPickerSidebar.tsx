import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { ChevronRightIcon, SparklesIcon, SplitIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/** Build concise picker guidance without exposing server diagnostics in the composer. */
function unavailableSettingsAction(
  entry: ProviderInstanceEntry,
  hasSetupSurface: boolean,
): "enable" | "install or reconnect" | null {
  if (!entry.enabled || entry.status === "disabled") {
    return "enable";
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return null;
  }
  if (hasSetupSurface) {
    return null;
  }
  return "install or reconnect";
}

function describeUnavailableInstance(
  entry: ProviderInstanceEntry,
  hasSetupSurface: boolean,
): string {
  const settingsAction = unavailableSettingsAction(entry, hasSetupSurface);
  if (settingsAction) {
    const state = settingsAction === "enable" ? "disabled" : "unavailable";
    return `${entry.displayName} is ${state}. Open Settings → Providers to ${settingsAction} it.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return entry.displayName;
  }
  return `${entry.displayName} needs setup. Select it to install or reconnect.`;
}

function SettingsPathTooltip(props: { label: string; action: "enable" | "install or reconnect" }) {
  const state = props.action === "enable" ? "disabled" : "unavailable";
  return (
    <span className="block text-left leading-snug [text-wrap:wrap]">
      <span className="block">
        {props.label} is {state}.
      </span>
      <span className="mt-0.5 block">
        Open{" "}
        <span className="inline-flex rounded bg-muted px-1 py-px text-[11px] font-medium text-primary/80">
          Settings
        </span>
        <ChevronRightIcon
          className="mx-0.5 inline size-3 align-[-0.1em] text-muted-foreground/70"
          aria-hidden
        />
        <span className="sr-only">then</span>
        <span className="inline-flex rounded bg-muted px-1 py-px text-[11px] font-medium text-primary/80">
          Providers
        </span>{" "}
        to {props.action} it.
      </span>
    </span>
  );
}

const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary";
const BADGE_BASE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-transparent shadow-sm ";
const NEW_BADGE_CLASS = `${BADGE_BASE_CLASS} text-update-foreground `;

/** Opens toward the rail so the list stays readable (not over the model names). */
const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;
const PICKER_TOOLTIP_CLASS = "max-w-64 text-balance font-normal leading-snug";
const SETTINGS_TOOLTIP_CLASS = "max-w-64 text-left font-normal leading-snug";

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  /**
   * Instance entries to render as rail buttons. Each entry becomes one icon
   * keyed by `instanceId`, so the default built-in Codex and a user-authored
   * `codex_personal` appear as two distinct rail items, each routing to
   * their own model list.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Render the favorites rail entry. Hidden for locked-provider instance switching. */
  showFavorites?: boolean;
  /** Instance ids shown in the rail but unavailable for the current picker context. */
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  /**
   * Not-ready instances that have an in-picker setup surface. They remain
   * selectable so connecting one provider never hides setup for the others.
   */
  setupAvailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  /**
   * Instance id values that should render the "new" sparkle badge. Callers
   * pass the subset of default built-in ids they want flagged (custom
   * instances are never flagged — the user just made them).
   */
  newBadgeInstanceIds?: ReadonlySet<ProviderInstanceId>;
}) {
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [props.instanceEntries, props.selectedInstanceId, showFavorites]);

  return (
    <div className="w-11 shrink-0 overflow-hidden bg-muted/30" data-model-picker-sidebar="true">
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className={cn(
                SELECTED_INDICATOR_CLASS,
                "right-0 translate-y-0 transition-[top] duration-200 ease-out",
              )}
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {/* Favorites section */}
          {showFavorites ? (
            <>
              <div className="relative w-full" data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        className={cn(
                          "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] focus-visible:outline-none",
                        )}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label="Favorites"
                      >
                        <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                      </button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={PICKER_TOOLTIP_CLASS}
                  >
                    Favorites
                  </TooltipPopup>
                </Tooltip>
              </div>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {/* Instance buttons (one per configured instance — built-in + custom) */}
          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const hasSetupSurface = props.setupAvailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled = (isUnavailable && !hasSetupSurface) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showNewBadge = props.newBadgeInstanceIds?.has(entry.instanceId) ?? false;
            const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);
            const settingsAction = isUnavailable
              ? unavailableSettingsAction(entry, hasSetupSurface)
              : null;

            const tooltip = settingsAction
              ? describeUnavailableInstance(entry, hasSetupSurface)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : isUnavailable
                  ? describeUnavailableInstance(entry, hasSetupSurface)
                  : showNewBadge
                    ? `${entry.displayName} — New`
                    : entry.displayName;

            const button = (
              <button
                className={cn(
                  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] focus-visible:outline-none",
                  isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                )}
                data-provider-accent-color={entry.accentColor}
                onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                onMouseLeave={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                disabled={isDisabled}
                type="button"
                aria-label={
                  isUnavailable || isContextDisabled
                    ? tooltip
                    : showNewBadge
                      ? `${entry.displayName}, new`
                      : entry.displayName
                }
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  showBadge={showInstanceBadge}
                  className="size-6"
                  iconClassName="size-5"
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--muted)"
                      : isSelected
                        ? "var(--background)"
                        : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(entry.accentColor
                    ? { badgeClassName: "h-3 min-w-3 px-0.5 text-[7px]" }
                    : {})}
                />
                {showNewBadge ? (
                  <span className={NEW_BADGE_CLASS} aria-hidden>
                    <SparklesIcon className="size-2" />
                  </span>
                ) : null}
              </button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={entry.instanceId}
                className="relative w-full"
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={settingsAction ? SETTINGS_TOOLTIP_CLASS : PICKER_TOOLTIP_CLASS}
                  >
                    {settingsAction ? (
                      <SettingsPathTooltip label={entry.displayName} action={settingsAction} />
                    ) : isContextDisabled ? (
                      <span className="flex items-center gap-1.5">
                        <SplitIcon
                          className="size-3.5 shrink-0 rotate-90 text-primary/80"
                          aria-hidden
                        />
                        <span className="min-w-0 text-left [text-wrap:wrap]">{tooltip}</span>
                      </span>
                    ) : (
                      tooltip
                    )}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
