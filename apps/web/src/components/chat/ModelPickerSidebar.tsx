import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, type Dispatch, type SetStateAction, useLayoutEffect, useRef, useState } from "react";
import { msg, T, useMessages, Var } from "gt-react";
import { ChevronRightIcon, SplitIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "../../i18n/messages";
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
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
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
  resolve: MessageResolver,
): string {
  const label = entry.displayName;
  const settingsAction = unavailableSettingsAction(entry, hasSetupSurface);
  if (settingsAction) {
    return settingsAction === "enable"
      ? resolve(msg("{label} is disabled. Open Settings → Providers to enable it.", { label }))
      : resolve(
          msg("{label} is unavailable. Open Settings → Providers to install or reconnect it.", {
            label,
          }),
        );
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  return resolve(msg("{label} needs setup. Select it to install or reconnect.", { label }));
}

function SettingsPathTooltip(props: { label: string; action: "enable" | "install or reconnect" }) {
  const badgeClassName =
    "inline-flex rounded bg-muted px-1 py-px text-2xs font-medium text-primary/80";
  const chevronClassName = "mx-0.5 inline size-3 align-[-0.1em] text-muted-foreground/70";
  return (
    <span className="block text-left leading-snug [text-wrap:wrap]">
      <span className="block">
        {props.action === "enable" ? (
          <T>
            <Var>{props.label}</Var> is disabled.
          </T>
        ) : (
          <T>
            <Var>{props.label}</Var> is unavailable.
          </T>
        )}
      </span>
      <span className="mt-0.5 block">
        {props.action === "enable" ? (
          <T>
            Open <span className={badgeClassName}>Settings</span>
            <ChevronRightIcon className={chevronClassName} aria-hidden />
            <span className="sr-only">then</span>
            <span className={badgeClassName}>Providers</span> to enable it.
          </T>
        ) : (
          <T>
            Open <span className={badgeClassName}>Settings</span>
            <ChevronRightIcon className={chevronClassName} aria-hidden />
            <span className="sr-only">then</span>
            <span className={badgeClassName}>Providers</span> to install or reconnect it.
          </T>
        )}
      </span>
    </span>
  );
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;
const PICKER_TOOLTIP_CLASS = "max-w-64";
const SETTINGS_TOOLTIP_CLASS = "max-w-64 text-left";

const ModelPickerSidebarItem = memo(function ModelPickerSidebarItem(props: {
  entry: ProviderInstanceEntry;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  selected: boolean;
  hovered: boolean;
  setupAvailable: boolean;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  getDisabledInstanceTooltip: ((entry: ProviderInstanceEntry) => string) | undefined;
  messageResolver: MessageResolver;
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  setHoveredInstanceId: Dispatch<SetStateAction<ProviderInstanceId | null>>;
}) {
  const isUnavailable = !isProviderInstancePickerReady(props.entry);
  const isContextDisabled = props.disabledInstanceIds?.has(props.entry.instanceId) ?? false;
  const unavailableSelectionIsReachable =
    props.selectableUnavailableInstanceIds?.has(props.entry.instanceId) ?? false;
  // SCIENT-FORK:START — setup remains available from the picker and explains unavailable entries.
  const isDisabled =
    (isUnavailable && !props.setupAvailable && !unavailableSelectionIsReachable) ||
    isContextDisabled;
  const showInstanceBadge = shouldShowInstanceBadge(props.entry, props.instanceEntries);
  const settingsAction = isUnavailable
    ? unavailableSettingsAction(props.entry, props.setupAvailable)
    : null;
  const tooltip =
    settingsAction || (isUnavailable && !isContextDisabled)
      ? describeUnavailableInstance(props.entry, props.setupAvailable, props.messageResolver)
      : isContextDisabled
        ? (props.getDisabledInstanceTooltip?.(props.entry) ?? props.entry.displayName)
        : props.entry.displayName;
  // SCIENT-FORK:END

  const button = (
    <Toolbar.Button
      className={cn(
        "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
        isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
      )}
      data-provider-accent-color={props.entry.accentColor}
      onClick={() => !isDisabled && props.onSelectInstance(props.entry.instanceId)}
      onMouseEnter={() => props.setHoveredInstanceId(props.entry.instanceId)}
      onMouseLeave={() =>
        props.setHoveredInstanceId((current) =>
          current === props.entry.instanceId ? null : current,
        )
      }
      onFocus={() => props.setHoveredInstanceId(props.entry.instanceId)}
      onBlur={() =>
        props.setHoveredInstanceId((current) =>
          current === props.entry.instanceId ? null : current,
        )
      }
      disabled={isDisabled}
      focusableWhenDisabled={!isDisabled}
      aria-pressed={props.selected}
      type="button"
      aria-label={isUnavailable || isContextDisabled ? tooltip : props.entry.displayName}
    >
      <ProviderInstanceIcon
        driverKind={props.entry.driverKind}
        displayName={props.entry.displayName}
        accentColor={props.entry.accentColor}
        acpRegistryAgentId={props.entry.acpRegistryAgentId}
        acpRegistryIconUrl={props.entry.acpRegistryIconUrl}
        showBadge={showInstanceBadge}
        className="size-6 z-30"
        iconClassName="size-5"
        indicatorBackground={
          props.hovered && !isDisabled
            ? "var(--muted)"
            : props.selected
              ? "var(--background)"
              : "color-mix(in oklab, var(--muted) 30%, transparent)"
        }
        {...(props.entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
      />
    </Toolbar.Button>
  );

  const trigger = isDisabled ? <span className="relative block w-full">{button}</span> : button;

  return (
    <div className="relative w-full" data-model-picker-provider={props.entry.instanceId}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipPopup
          side={PICKER_TOOLTIP_SIDE}
          sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
          align="center"
          className={settingsAction ? SETTINGS_TOOLTIP_CLASS : PICKER_TOOLTIP_CLASS}
        >
          {settingsAction ? (
            <SettingsPathTooltip label={props.entry.displayName} action={settingsAction} />
          ) : isContextDisabled ? (
            <span className="flex items-center gap-1.5">
              <SplitIcon className="size-3.5 shrink-0 rotate-90 text-primary/80" aria-hidden />
              <span className="min-w-0 text-left [text-wrap:wrap]">{tooltip}</span>
            </span>
          ) : (
            tooltip
          )}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  /**
   * Not-ready instances that have an in-picker setup surface. They remain
   * selectable so connecting one provider never hides setup for the others.
   */
  setupAvailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
}) {
  const m = useMessages();
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected provider item's DOM offset to position the selection indicator
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
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    showFavorites,
  ]);

  return (
    <Toolbar.Root
      className="w-11 shrink-0 overflow-hidden bg-muted/30"
      data-model-picker-sidebar="true"
      aria-label={m(msg("Providers"))}
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <div className="relative w-full" data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toolbar.Button
                        className={cn(
                          "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
                        )}
                        onClick={() => props.onSelectInstance("favorites")}
                        type="button"
                        aria-label={m(msg("Favorites"))}
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      >
                        <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                      </Toolbar.Button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    <T>Favorites</T>
                  </TooltipPopup>
                </Tooltip>
              </div>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {props.instanceEntries.map((entry) => (
            <ModelPickerSidebarItem
              key={entry.instanceId}
              entry={entry}
              instanceEntries={props.instanceEntries}
              selected={props.selectedInstanceId === entry.instanceId}
              hovered={hoveredInstanceId === entry.instanceId}
              setupAvailable={props.setupAvailableInstanceIds?.has(entry.instanceId) ?? false}
              disabledInstanceIds={props.disabledInstanceIds}
              selectableUnavailableInstanceIds={props.selectableUnavailableInstanceIds}
              getDisabledInstanceTooltip={props.getDisabledInstanceTooltip}
              messageResolver={m}
              onSelectInstance={props.onSelectInstance}
              setHoveredInstanceId={setHoveredInstanceId}
            />
          ))}
        </div>
      </div>
    </Toolbar.Root>
  );
});
