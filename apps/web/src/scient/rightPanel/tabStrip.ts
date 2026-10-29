import { useEffect, useEffectEvent } from "react";

import type { RightPanelTabsProps } from "~/components/RightPanelTabs";

import { isScientNewTabSurface } from "./surfaces";

/**
 * Scient's tab look, after T3's own tab classes (later classes win): slightly larger
 * tabs with a faint divider before each one. In Scient's strip the open tab takes
 * the page colour and joins the page below it, as in Chrome; dividers give way
 * beside it.
 */
export const SCIENT_PANEL_TAB_CLASS = [
  "relative h-7 max-w-40 gap-1 pl-2 text-sm",
  "not-first:before:pointer-events-none not-first:before:absolute not-first:before:inset-y-1.75 not-first:before:-left-0.75 not-first:before:w-0.5 not-first:before:scale-x-75 not-first:before:rounded-full not-first:before:bg-border/70",
  "in-data-[scient-tabstrip]:min-w-19 in-data-[scient-tabstrip]:shrink",
  "in-data-[scient-tabstrip=content]:data-[active-tab=true]:h-8 in-data-[scient-tabstrip=content]:data-[active-tab=true]:self-end in-data-[scient-tabstrip=content]:data-[active-tab=true]:pb-1",
  "in-data-[scient-tabstrip=content]:data-[active-tab=true]:rounded-t-lg in-data-[scient-tabstrip=content]:data-[active-tab=true]:rounded-b-none in-data-[scient-tabstrip=content]:data-[active-tab=true]:bg-background",
  "in-data-[scient-tabstrip]:data-[active-tab=true]:before:opacity-0 in-data-[scient-tabstrip]:[[data-active-tab=true]+&]:before:opacity-0",
].join(" ");

/**
 * What Scient's tab strip shows. The launcher is what a New tab shows, and an open,
 * empty panel gets a New tab, so the page always appears as a tab. Without
 * `onAddNewTab` the panel keeps T3's strip.
 */
export function useScientTabStrip(
  props: Pick<RightPanelTabsProps, "surfaces" | "activeSurfaceId" | "open" | "onAddNewTab">,
) {
  const activeSurface = props.surfaces.find((surface) => surface.id === props.activeSurfaceId);
  const activeNewTab =
    activeSurface && isScientNewTabSurface(activeSurface) ? activeSurface : undefined;
  const needsNewTab = props.open !== false && props.surfaces.length === 0;
  const addNewTab = useEffectEvent(() => props.onAddNewTab?.({ whenEmpty: true }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- An open panel emptied by any owner (close, move, thread switch) gets its New tab.
  useEffect(() => {
    if (needsNewTab) addNewTab();
  }, [needsNewTab]);
  return {
    activeSurface,
    activeNewTab,
    showsLauncher: props.activeSurfaceId === null || activeNewTab !== undefined,
    /** Lets Scient's stylesheet even out where each kind of page starts. */
    activeSurfaceKey: !props.onAddNewTab
      ? undefined
      : activeSurface?.kind === "scient"
        ? `scient-${activeSurface.module}`
        : activeSurface?.kind,
  };
}
