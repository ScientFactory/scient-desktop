import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import {
  BookOpenTextIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  CloudIcon,
  HouseIcon,
  ImportIcon,
  PlugIcon,
  SettingsIcon,
} from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  initializeScientProjectForOpening,
  inspectScientProjectForOpening,
} from "../../lib/scientProjectInitialization";
import { useScratchProject } from "../../hooks/useScratchProject";
import { openWholeLibrary } from "../sources/librarySourceRequest";
import { readPreparedConnection } from "../../state/session";
import { FeedbackIcon } from "../feedback/FeedbackCoordinator";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { IssueGlyph } from "../../components/issue/issuePresentation";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { toastManager } from "../../components/ui/toast";
import { stackedThreadToast } from "../../components/ui/toastHelpers";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useSidebarUtilityActions } from "./useSidebarUtilityActions";
import "./sidebarNavRail.css";
import { registerRailOtherUpdatesSlot } from "./railOtherUpdatesSlot";

// Keeps Clerk out of the sidebar's bundle; Settings loads the same module this way.
const T3ConnectRailAccount = lazy(() =>
  import("../../components/clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectRailAccount,
  })),
);

type RailPage =
  | "home"
  | "scheduled-tasks"
  | "extensions"
  | "pull-requests"
  | "issues"
  | "usage"
  | "cloud"
  | "settings";

function railPageFor(pathname: string): RailPage | null {
  if (pathname === "/") return "home";
  if (pathname === "/settings/scheduled-tasks") return "scheduled-tasks";
  if (pathname === "/settings/extensions" || pathname.startsWith("/settings/extensions/")) {
    return "extensions";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/pull-requests") return "pull-requests";
  if (pathname === "/issues") return "issues";
  if (pathname === "/usage") return "usage";
  if (pathname === "/cloud" || pathname.startsWith("/cloud/")) return "cloud";
  return null;
}

/**
 * Opens the whole personal Library beside a thread without a project. The Library lists through a
 * Scient project folder and opens PDFs beside a thread; the scratch project gives it both without
 * borrowing one of the person's projects, so its folder is set up as a Scient project first.
 */
function useOpenWholeLibrary() {
  const gt = useGT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  return async () => {
    const environmentId = scratchEnvironmentId(primaryEnvironmentId);
    const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
    if (environmentId === null || prepared === null) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: gt("The Library is not available yet"),
          description: gt("It opens once this computer's server is connected."),
        }),
      );
      return;
    }
    const project = await openScratchProject(environmentId, gt("Could not open the Library"));
    if (!project) return;
    try {
      const inspection = await inspectScientProjectForOpening(prepared, project.workspaceRoot);
      if (inspection.state !== "initialized" && inspection.canInitialize) {
        await initializeScientProjectForOpening({
          prepared,
          root: project.workspaceRoot,
          title: project.title,
        });
      }
    } catch (cause) {
      // The Library still opens and offers its own setup.
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not set up the Library"),
          description: cause instanceof Error ? cause.message : gt("Scient project setup failed."),
        }),
      );
    }
    const started = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    if (!started) return;
    openWholeLibrary({
      threadRef: scopeThreadRef(project.environmentId, started.threadId),
      root: project.workspaceRoot,
    });
  };
}

function RailItem({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              aria-current={active ? "page" : undefined}
              isActive={active}
              onClick={onClick}
              size="icon"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/**
 * Destinations along the sidebar's edge, in place of the footer's buttons. Inside the sidebar it
 * sits below the header over a 3rem inset the thread list and footer leave for it; collapsed, it
 * stands alone at the window's edge, full height, under the sidebar toggle.
 */
export function SidebarNavRail({ collapsed }: { collapsed: boolean }) {
  const gt = useGT();
  const navigate = useNavigate();
  const page = useLocation({ select: (location) => railPageFor(location.pathname) });
  const actions = useSidebarUtilityActions();
  const openLibrary = useOpenWholeLibrary();
  const go = (to: "/" | "/settings/scheduled-tasks" | "/settings/extensions") => () => {
    actions.closeMobileSidebar();
    void navigate({ to });
  };

  const nav = (
    <nav
      aria-label={gt("Sidebar destinations")}
      className={
        collapsed
          ? "absolute start-0 top-[var(--workspace-topbar-height)] bottom-0 flex w-12 flex-col items-center justify-between border-e border-sidebar-border py-2"
          : "absolute start-0 top-[var(--workspace-topbar-height)] bottom-0 z-[2] flex w-12 flex-col items-center justify-between border-e border-sidebar-border py-2"
      }
      data-sidebar-nav-rail={collapsed ? undefined : ""}
    >
      <SidebarMenu className="items-center">
        <RailItem
          icon={<HouseIcon />}
          label={gt("Home")}
          onClick={go("/")}
          active={page === "home"}
        />
        <RailItem
          icon={<BookOpenTextIcon />}
          label={gt("Library")}
          onClick={() => {
            actions.closeMobileSidebar();
            void openLibrary();
          }}
        />
        <RailItem
          icon={<CalendarClockIcon />}
          label={gt("Scheduled tasks")}
          onClick={go("/settings/scheduled-tasks")}
          active={page === "scheduled-tasks"}
        />
        <RailItem
          icon={<PlugIcon />}
          label={gt("Extensions")}
          onClick={go("/settings/extensions")}
          active={page === "extensions"}
        />
        {actions.pullRequestsSupported ? (
          <RailItem
            icon={<PullRequestGlyph.pullRequest />}
            label={gt("Pull Requests")}
            onClick={actions.handlePullRequestsClick}
            active={page === "pull-requests"}
          />
        ) : null}
        {actions.issuesSupported ? (
          <RailItem
            icon={<IssueGlyph.issue />}
            label={gt("Issues", { $context: "sidebar link to the list of issues" })}
            onClick={actions.handleIssuesClick}
            active={page === "issues"}
          />
        ) : null}
      </SidebarMenu>
      <SidebarMenu className="items-center">
        {actions.cloudAvailable ? (
          <RailItem
            icon={<CloudIcon />}
            label={gt("Cloud conversations")}
            onClick={actions.handleCloudClick}
            active={page === "cloud"}
          />
        ) : null}
        {/* The header's update control renders the circle for other updates here. */}
        <SidebarMenuItem
          className="flex size-8 shrink-0 items-center justify-center empty:hidden"
          ref={registerRailOtherUpdatesSlot}
        />
        <RailItem
          icon={<SettingsIcon />}
          label={gt("Settings")}
          onClick={actions.handleSettingsClick}
          active={page === "settings"}
        />
        <RailItem
          icon={<ChartNoAxesColumnIcon />}
          label={gt("Usage")}
          onClick={actions.handleUsageClick}
          active={page === "usage"}
        />
        {actions.canSendFeedback ? (
          <RailItem
            icon={<FeedbackIcon />}
            label={gt("Send feedback")}
            onClick={actions.handleFeedbackClick}
          />
        ) : null}
        <RailItem
          icon={<ImportIcon />}
          label={gt("Import conversation")}
          onClick={actions.handleImportClick}
        />
        <Suspense fallback={null}>
          <T3ConnectRailAccount />
        </Suspense>
      </SidebarMenu>
    </nav>
  );
  if (!collapsed) return nav;
  return (
    <div
      // The rail's border and fill start below the titlebar, so the window controls sit on the
      // main area's titlebar.
      className="relative h-dvh w-12 shrink-0 bg-background text-sidebar-foreground"
      data-sidebar-nav-rail-collapsed=""
    >
      {isElectron ? (
        // The window still drags by the strip above the icons, as it does by the sidebar header.
        <div className="drag-region h-[var(--workspace-topbar-height)]" />
      ) : null}
      {nav}
    </div>
  );
}

/** Keeps the rail at the window's edge while the sidebar is collapsed (desktop widths). */
export function CollapsedSidebarNavRail() {
  const enabled = useClientSettings((settings) => settings.sidebarNavRailEnabled);
  const { open, isMobile } = useSidebar();
  if (!enabled || open || isMobile) return null;
  return <SidebarNavRail collapsed />;
}
