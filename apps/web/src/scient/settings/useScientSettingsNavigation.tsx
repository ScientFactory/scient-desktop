import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
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

const SETTINGS_PAGE_SECTIONS: Partial<
  Readonly<Record<SettingsPath, ReadonlyArray<{ label: string; targetId: string }>>>
> = {
  "/settings/general": [
    { label: "Organization", targetId: "organization" },
    { label: "Behavior", targetId: "behavior" },
    { label: "Projects & threads", targetId: "projects-and-threads" },
    { label: "Confirmations", targetId: "confirmations" },
    { label: "Text generation", targetId: "text-generation" },
    { label: "About", targetId: "about" },
    { label: "Legacy features", targetId: "legacy-features" },
  ],
  "/settings/appearance": [
    { label: "Colors & themes", targetId: "appearance" },
    { label: "Interface", targetId: "appearance-interface" },
    { label: "Motion", targetId: "motion" },
    { label: "Typography", targetId: "typography" },
  ],
  "/settings/source-control": [
    { label: "Version control", targetId: "source-control" },
    { label: "Text generation", targetId: "source-control-text-generation" },
  ],
  "/settings/connections": [
    { label: "This environment", targetId: "connections-environment" },
    { label: "Remote environments", targetId: "remote-environments" },
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
            aria-label={`${pageSectionsExpanded ? "Hide" : "Show"} ${item.label} sections`}
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
                    <span className="ms-0.5">{section.label}</span>
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
