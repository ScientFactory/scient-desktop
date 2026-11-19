import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChartNoAxesColumnIcon,
  // SCIENT-FORK:START — Scient Cloud conversations.
  CloudIcon,
  // SCIENT-FORK:END
  EllipsisVerticalIcon,
  ImportIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { T, useGT } from "gt-react";
import { memo } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../../navigationHistory";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  type SidebarStageBackdropVariant,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { IssueGlyph } from "../issue/issuePresentation";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

import { APP_BASE_NAME } from "../../branding";
import { ScientReleaseNotes } from "../../scient/releaseNotes/ScientReleaseNotes";
import { requestConversationImport } from "../../scient/conversationImport/requests";
// SCIENT-FORK:START — Scient Cloud conversations.
import { useCloudConversationsAvailable } from "../../scient/cloud/cloudConversationsAvailable";
// SCIENT-FORK:END
// SCIENT-FORK:START — Send feedback to Scient.
import { FeedbackIcon } from "../../scient/feedback/FeedbackCoordinator";
import { feedbackAvailable } from "../../scient/feedback/FeedbackDialog";
import { requestFeedback } from "../../scient/feedback/feedbackStore";
// SCIENT-FORK:END
import { ScientSymbol } from "../ScientSymbol";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const gt = useGT();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          {...(backdropVariant ? { stage: backdropVariant } : {})}
          data-stage-variant={backdropVariant ?? undefined}
          aria-label={gt("Toggle main sidebar")}
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        {/* SCIENT-FORK: min-w-0 keeps the brand shrinkable so its stage label truncates. */}
        <div className="flex min-w-0 items-center gap-1">
          <SidebarBrand
            onBackdrop={backdropVariant !== null}
            stageVariant={backdropVariant}
            stageLabel={backdropVariant ? stageLabel : null}
          />
          {isElectron ? (
            <div className="hidden items-center md:flex">
              <HistoryNavigationButton direction="back" />
              <HistoryNavigationButton direction="forward" />
            </div>
          ) : null}
        </div>
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function SidebarBrandWidthProbe({
  isElectron,
  onWidthChange,
}: {
  isElectron: boolean;
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex gap-1">
        <SidebarBrandMark onBackdrop={false} />
        {isElectron ? <div className="w-[calc(2*var(--workspace-titlebar-control-size))]" /> : null}
      </div>
    </div>
  );
}

function HistoryNavigationButton({ direction }: { direction: HistoryDirection }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const enabled = useCanNavigateHistory(direction);
  const gt = useGT();
  const label = direction === "back" ? gt("Go back") : gt("Go forward");
  const shortcutLabel = shortcutLabelForCommand(
    keybindings,
    direction === "back" ? "navigation.back" : "navigation.forward",
  );
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="[-webkit-app-region:no-drag]"
            disabled={!enabled}
            onClick={() => navigateHistory(direction)}
            size="icon-sm"
            // SCIENT-FORK: Scient's stage keeps theme colors, where white media icons would vanish.
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function SidebarBrand({
  onBackdrop,
  stageVariant,
  stageLabel,
}: {
  readonly onBackdrop: boolean;
  readonly stageVariant: SidebarStageBackdropVariant | null;
  readonly stageLabel: string | null;
}) {
  const gt = useGT();
  return (
    <Link
      aria-label={gt("{name} home", { name: APP_BASE_NAME })}
      className={cn(
        "sidebar-brand relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink items-center gap-1.5 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset group-data-[collapsible=icon]:hidden",
        onBackdrop ? "sidebar-brand-on-stage" : "text-foreground",
      )}
      data-stage-variant={stageVariant ?? undefined}
      to="/"
    >
      <ScientSymbol className="size-4" />
      <span className="truncate text-base font-semibold tracking-tight">{APP_BASE_NAME}</span>
      {stageLabel ? (
        <span className="sidebar-brand-stage sidebar-brand-stage-label truncate text-2xs font-medium">
          {stageLabel}
        </span>
      ) : null}
    </Link>
  );
}

function SidebarBrandMark({ onBackdrop: _onBackdrop }: { onBackdrop: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ScientSymbol className="size-4" />
      <span className="text-base font-semibold tracking-tight">{APP_BASE_NAME}</span>
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  secondary = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  secondary?: boolean;
}) {
  return (
    <SidebarMenuItem
      className="shrink-0"
      data-sidebar-utility={secondary ? "secondary" : undefined}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

// SCIENT-FORK: exported for Scient's update-pill and utility-row tests.
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleIssuesClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/issues", search: readIssueListPreferences() });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  // SCIENT-FORK:START - conversation import remains available in the sidebar.
  const handleImportClick = () => {
    closeMobileSidebar();
    requestConversationImport();
  };
  // SCIENT-FORK:END
  // SCIENT-FORK:START — conversations the person's computers copied to Scient Cloud.
  const cloudAvailable = useCloudConversationsAvailable();
  const handleCloudClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/cloud" });
  };
  // SCIENT-FORK:END
  // SCIENT-FORK:START — Send feedback to Scient.
  const canSendFeedback = feedbackAvailable();
  const handleFeedbackClick = () => {
    closeMobileSidebar();
    requestFeedback({ source: "sidebar" });
  };
  // SCIENT-FORK:END

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    // Container width follows the sidebar resize, rather than the app window.
    <div className="@container/sidebar-utilities pl-1">
      <SidebarMenu className="flex-row items-center @max-[14rem]/sidebar-utilities:has-[[data-update-active]]:[&_[data-sidebar-utility=secondary]]:hidden @max-[14rem]/sidebar-utilities:has-[[data-update-active]]:[&_[data-sidebar-utility=overflow]]:block">
        {isOnUtilityPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>
                <T>Back</T>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarUtilityItem
              icon={<ImportIcon />}
              label={gt("Import conversation")}
              onClick={handleImportClick}
              secondary
            />
            <SidebarUtilityItem
              icon={<SettingsIcon />}
              label={gt("Settings")}
              onClick={handleSettingsClick}
            />
            {pullRequestsSupported ? (
              <SidebarUtilityItem
                icon={<PullRequestGlyph.pullRequest />}
                label={gt("Pull Requests")}
                onClick={handlePullRequestsClick}
              />
            ) : null}
            {issuesSupported ? (
              <SidebarUtilityItem
                icon={<IssueGlyph.issue />}
                label={gt("Issues", { $context: "sidebar link to the list of issues" })}
                onClick={handleIssuesClick}
              />
            ) : null}
            <SidebarUtilityItem
              icon={<ChartNoAxesColumnIcon />}
              label={gt("Usage")}
              onClick={handleUsageClick}
              secondary
            />
            {/* SCIENT-FORK:START — Scient Cloud conversations. */}
            {cloudAvailable ? (
              <SidebarUtilityItem
                icon={<CloudIcon />}
                label={gt("Cloud conversations")}
                onClick={handleCloudClick}
                secondary
              />
            ) : null}
            {/* SCIENT-FORK:END */}
            {/* SCIENT-FORK:START — Send feedback to Scient. */}
            {canSendFeedback ? (
              <SidebarUtilityItem
                icon={<FeedbackIcon />}
                label={gt("Send feedback")}
                onClick={handleFeedbackClick}
                secondary
              />
            ) : null}
            {/* SCIENT-FORK:END */}
            <SidebarMenuItem className="hidden shrink-0" data-sidebar-utility="overflow">
              <Menu>
                <MenuTrigger
                  render={<SidebarMenuButton size="icon" aria-label={gt("More sidebar actions")} />}
                >
                  <EllipsisVerticalIcon />
                </MenuTrigger>
                <MenuPopup side="top" align="start">
                  <MenuItem onClick={handleImportClick}>
                    <ImportIcon />
                    <T>Import conversation</T>
                  </MenuItem>
                  <MenuItem onClick={handleUsageClick}>
                    <ChartNoAxesColumnIcon />
                    <T>Usage</T>
                  </MenuItem>
                  {/* SCIENT-FORK:START — Scient Cloud conversations. */}
                  {cloudAvailable ? (
                    <MenuItem onClick={handleCloudClick}>
                      <CloudIcon />
                      <T>Cloud conversations</T>
                    </MenuItem>
                  ) : null}
                  {/* SCIENT-FORK:END */}
                  {/* SCIENT-FORK:START — Send feedback to Scient. */}
                  {canSendFeedback ? (
                    <MenuItem onClick={handleFeedbackClick}>
                      <FeedbackIcon />
                      <T>Send feedback</T>
                    </MenuItem>
                  ) : null}
                  {/* SCIENT-FORK:END */}
                </MenuPopup>
              </Menu>
            </SidebarMenuItem>
          </>
        )}
        <SidebarThreadUndoNotice />
        <SidebarUpdatePill />
      </SidebarMenu>
    </div>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <div className="contents group-data-[collapsible=icon]:hidden">
        <ScientReleaseNotes />
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
      </div>
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
