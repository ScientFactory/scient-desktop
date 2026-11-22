import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { msg, useGT, useMessages } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsiblePanel } from "../../components/ui/collapsible";
import {
  SidebarMenuAction,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { scrollToSettingsTarget } from "../../components/settings/settingsLayout";
import {
  getVisibleSettingsSectionIds,
  observeSettingsSectionVisibility,
  type SettingsSectionVisibilityState,
} from "./settingsSectionVisibility";
import type { SettingsPath } from "../../components/settings/settingsSearch";
import { cn } from "../../lib/utils";

/** Section labels are `msg()` strings, resolved where they show. */
const SETTINGS_PAGE_SECTIONS: Partial<
  Readonly<Record<SettingsPath, ReadonlyArray<{ label: string; targetId: string }>>>
> = {
  "/settings/general": [
    { label: msg("Notifications", { $context: "settings section" }), targetId: "notifications" },
    { label: msg("Sidebar", { $context: "settings section" }), targetId: "sidebar" },
    { label: msg("Confirmations"), targetId: "confirmations" },
    {
      label: msg("Display", { $context: "settings section about what is shown" }),
      targetId: "display",
    },
  ],
  "/settings/appearance": [
    { label: msg("Colors & themes"), targetId: "appearance" },
    { label: msg("Interface", { $context: "settings section" }), targetId: "appearance-interface" },
    { label: msg("Typography"), targetId: "typography" },
  ],
  "/settings/threads": [
    { label: msg("New projects"), targetId: "new-projects" },
    { label: msg("New threads"), targetId: "project-defaults" },
    { label: msg("Usage limits"), targetId: "usage-limits" },
    { label: msg("Auto-settle"), targetId: "auto-settle" },
    { label: msg("Text generation"), targetId: "text-generation" },
    { label: msg("Forks", { $context: "settings section" }), targetId: "forks" },
  ],
  "/settings/browser": [
    { label: msg("Agent access"), targetId: "browser-agent-access" },
    { label: msg("Browsing", { $context: "settings section" }), targetId: "browser" },
    { label: msg("Recordings", { $context: "settings section" }), targetId: "browser-recordings" },
  ],
  "/settings/source-control": [
    { label: msg("Repositories"), targetId: "source-control-defaults" },
    { label: msg("Version control"), targetId: "source-control" },
    { label: msg("Writing & review"), targetId: "source-control-text-generation" },
  ],
  "/settings/maintenance": [
    { label: msg("Updates", { $context: "settings section" }), targetId: "updates" },
    { label: msg("Background activity"), targetId: "background" },
    { label: msg("Artifacts and logs"), targetId: "storage-artifacts" },
    { label: msg("Diagnostics"), targetId: "diagnostics-section" },
  ],
  "/settings/about": [
    { label: msg("App", { $context: "settings section about the app" }), targetId: "about" },
    { label: msg("Legal", { $context: "settings section" }), targetId: "legal" },
  ],
};

function SettingsSubmenuCollapse({
  id,
  open,
  children,
}: {
  readonly id: string;
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible open={open}>
      <CollapsiblePanel id={id} motion="fast">
        {children}
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function useScientSettingsNavigation(
  pathname: string,
  items: ReadonlyArray<{ to: SettingsPath; label: string }>,
) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const resolvedPathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname });
  const [expandedSettingsPath, setExpandedSettingsPath] = useState<SettingsPath | null>(null);
  const [sectionVisibility, setSectionVisibility] = useState<SettingsSectionVisibilityState | null>(
    null,
  );
  const activeSettingsPath = items.find(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  )?.to;
  // The page whose content is on screen. The watcher's lifetime is keyed on this string, not
  // on an object built during render: that object's identity follows the compiler's memo
  // grouping, so a report could rebuild it and restart the watcher, which reports again.
  const observedSettingsPath = items.find(
    (item) => resolvedPathname === item.to || resolvedPathname?.startsWith(`${item.to}/`) === true,
  )?.to;
  // Results describe one visit. Dropping them once another page is observed keeps a return
  // visit from showing what was in view last time.
  if (sectionVisibility && sectionVisibility.path !== observedSettingsPath) {
    setSectionVisibility(null);
  }
  const visiblePageSectionIds = getVisibleSettingsSectionIds({
    activePath: activeSettingsPath,
    observedPath: observedSettingsPath,
    visibility: sectionVisibility,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes settings section visibility in the page container DOM and mirrors it into state
  useEffect(() => {
    if (!observedSettingsPath) return;
    const pageSections = SETTINGS_PAGE_SECTIONS[observedSettingsPath];
    if (!pageSections) return;
    const container = document.querySelector<HTMLElement>("[data-settings-page-layout]");
    if (!container) return;

    return observeSettingsSectionVisibility({
      container,
      targetIds: pageSections.map((section) => section.targetId),
      onChange(targetIds) {
        setSectionVisibility({ path: observedSettingsPath, targetIds: new Set(targetIds) });
      },
    });
  }, [observedSettingsPath]);

  const handlePageSectionClick = (to: SettingsPath, targetId: string) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (pathname === to && scrollToSettingsTarget(targetId, { highlight: false })) {
      return;
    }
    void navigate({
      to,
      hash: targetId,
      replace: true,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: false },
    });
  };

  return (item: { to: SettingsPath; label: string }) => {
    const pageSections = SETTINGS_PAGE_SECTIONS[item.to];
    const isActive = activeSettingsPath === item.to;
    const pageSectionsId = `settings-page-sections-${item.to.slice("/settings/".length)}`;
    const pageSectionsExpanded = isActive && expandedSettingsPath === item.to;
    return (
      <>
        {isActive && pageSections ? (
          <SidebarMenuAction
            type="button"
            aria-label={
              pageSectionsExpanded
                ? gt("Hide {page} sections", { page: item.label })
                : gt("Show {page} sections", { page: item.label })
            }
            aria-expanded={pageSectionsExpanded}
            aria-controls={pageSectionsId}
            onClick={() => {
              setExpandedSettingsPath((currentPath) => (currentPath === item.to ? null : item.to));
            }}
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                pageSectionsExpanded && "rotate-90",
              )}
            />
          </SidebarMenuAction>
        ) : null}
        {pageSections ? (
          <SettingsSubmenuCollapse id={pageSectionsId} open={pageSectionsExpanded}>
            <SidebarMenuSub variant="plain">
              {pageSections.map((section) => (
                <SidebarMenuSubItem key={section.targetId}>
                  <SidebarMenuSubButton
                    render={<button type="button" />}
                    size="sm"
                    data-visible={visiblePageSectionIds.has(section.targetId)}
                    className={cn(
                      "w-full text-sidebar-muted-foreground/65",
                      visiblePageSectionIds.has(section.targetId) &&
                        "font-medium text-sidebar-foreground",
                    )}
                    onClick={() => handlePageSectionClick(item.to, section.targetId)}
                  >
                    <span className="ms-0.5">{messages(section.label)}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </SettingsSubmenuCollapse>
        ) : null}
      </>
    );
  };
}
