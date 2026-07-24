// FILE: ActivityCenter.tsx
// Purpose: Renders the lower-left Activity entry and its compact reviewable history panel.
// Layer: Notification UI

import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { APP_VERSION } from "../branding";
import { formatConnectionRecoveryDiagnostics } from "../connectionRecoveryNotice";
import { copyTextToClipboard } from "../hooks/useCopyToClipboard";
import {
  BellIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "../lib/icons";
import { cn } from "../lib/utils";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import { SidebarGlyph } from "../components/sidebarGlyphs";
import { SidebarLeadingIcon } from "../components/SidebarLeadingIcon";
import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover";
import { SidebarMenuButton } from "../components/ui/sidebar";
import {
  ACTIVITY_GROUP_LABEL,
  ACTIVITY_GROUP_ORDER,
  activitySidebarSummary,
  formatActivityRelativeTime,
  groupActivityItems,
  prioritizeActivityItemsForPreview,
  unreadActivityCount,
} from "./activityCenter.logic";
import { type ActivityItem, type ActivityTone, useActivityStore } from "./activityStore";

const ACTIVITY_PREVIEW_LIMIT = 12;

const ACTIVITY_TONE_ICON = {
  error: CircleAlertIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} satisfies Record<ActivityTone, typeof InfoIcon>;

function ActivityItemIcon({ item }: { item: ActivityItem }) {
  if (item.status === "in_progress") {
    return (
      <LoaderCircleIcon
        aria-hidden
        className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    );
  }
  const Icon = ACTIVITY_TONE_ICON[item.tone];
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5",
        item.tone === "error" || item.tone === "warning"
          ? "text-destructive/85"
          : item.tone === "success"
            ? "text-emerald-600 dark:text-emerald-300"
            : "text-muted-foreground",
      )}
    />
  );
}

function ActivityRow({
  item,
  onActivate,
}: {
  item: ActivityItem;
  onActivate: (item: ActivityItem) => void;
}) {
  const [diagnosticFeedback, setDiagnosticFeedback] = useState<string | null>(null);
  const diagnosticDestination =
    item.destination?.type === "connection_diagnostics" ? item.destination : null;
  const copyDiagnostics = async () => {
    if (!diagnosticDestination) return;
    onActivate(item);
    try {
      await copyTextToClipboard(
        formatConnectionRecoveryDiagnostics({
          appVersion: APP_VERSION,
          desktopApp: Boolean(window.desktopBridge),
          generatedAt: new Date(),
          navigatorOnline: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
          platform: navigator.platform,
          state: "reconnecting",
          stateStartedAt: new Date(diagnosticDestination.stateStartedAt),
          visibility: document.visibilityState,
        }),
      );
      setDiagnosticFeedback("Connection summary copied");
    } catch {
      setDiagnosticFeedback("Could not copy the connection summary");
    }
  };
  const openLogs = async () => {
    const openLogsDirectory =
      typeof window === "undefined"
        ? undefined
        : window.desktopBridge?.diagnostics?.openLogsDirectory;
    if (!openLogsDirectory) return;
    onActivate(item);
    try {
      await openLogsDirectory();
      setDiagnosticFeedback("Logs folder opened");
    } catch {
      setDiagnosticFeedback("Could not open the logs folder");
    }
  };
  const content = (
    <>
      <span className="mt-0.5 flex size-4 shrink-0 items-start justify-center">
        <ActivityItemIcon item={item} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/92">
            {item.title}
          </span>
          <span className="shrink-0 text-[length:var(--app-font-size-ui-sm,11px)] tabular-nums text-muted-foreground/72">
            {formatActivityRelativeTime(item.updatedAt)}
          </span>
        </span>
        {item.description ? (
          <span className="mt-0.5 line-clamp-2 block text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground/82">
            {item.description}
          </span>
        ) : null}
      </span>
      {!item.readAt ? (
        <span aria-label="Unread" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/80" />
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "rounded-md transition-colors hover:bg-[var(--color-background-elevated-secondary)]",
        item.status === "needs_attention" && "bg-destructive/4",
      )}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => onActivate(item)}
      >
        {content}
      </button>
      {diagnosticDestination ? (
        <div className="flex flex-wrap items-center gap-1 px-8 pb-1.5">
          <Button size="xs" variant="ghost" onClick={() => void copyDiagnostics()}>
            Copy summary
          </Button>
          {typeof window !== "undefined" && window.desktopBridge?.diagnostics?.openLogsDirectory ? (
            <Button size="xs" variant="ghost" onClick={() => void openLogs()}>
              Open logs
            </Button>
          ) : null}
          <span aria-live="polite" className="text-[10px] text-muted-foreground">
            {diagnosticFeedback}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function ActivityCenter() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const items = useActivityStore((state) => state.items);
  const markRead = useActivityStore((state) => state.markRead);
  const markAllRead = useActivityStore((state) => state.markAllRead);
  const clearRead = useActivityStore((state) => state.clearRead);
  const visibleItems = useMemo(
    () => (showAll ? items : prioritizeActivityItemsForPreview(items, ACTIVITY_PREVIEW_LIMIT)),
    [items, showAll],
  );
  const groups = useMemo(() => groupActivityItems(visibleItems), [visibleItems]);
  const unreadCount = unreadActivityCount(items);
  const summary = activitySidebarSummary(items);
  const hasUnresolvedActivity = items.some((item) => item.status !== "recent");

  const activate = (item: ActivityItem) => {
    markRead(item.id);
    const destination = item.destination;
    if (!destination) return;
    if (destination.type === "connection_diagnostics") return;
    setOpen(false);
    if (destination.type === "thread") {
      void navigate({
        to: "/$threadId",
        params: { threadId: destination.threadId },
        search: (previous) => ({ ...previous, splitViewId: undefined }),
      });
      return;
    }
    void navigate({
      to: "/settings",
      search: (previous) => ({
        ...previous,
        section: destination.section,
        target: destination.target,
      }),
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setShowAll(false);
      }}
    >
      <PopoverTrigger
        render={
          <SidebarMenuButton
            aria-label={`Activity, ${summary}`}
            aria-expanded={open}
            size="sm"
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
              SIDEBAR_ROW_HOVER_CLASS_NAME,
              open && SIDEBAR_ROW_ACTIVE_CLASS_NAME,
            )}
          >
            <SidebarLeadingIcon size="sm" tone={SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME}>
              <SidebarGlyph icon={BellIcon} variant="leading" />
            </SidebarLeadingIcon>
            <span className="min-w-0 flex-1 truncate">Activity</span>
            <span
              className={cn(
                "max-w-28 truncate text-[length:var(--app-font-size-ui-sm,11px)]",
                hasUnresolvedActivity
                  ? "font-medium text-foreground/82"
                  : "text-muted-foreground/72",
              )}
            >
              {summary}
            </span>
            {unreadCount > 0 ? (
              <span className="inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/12 px-1 text-[10px] font-medium tabular-nums text-primary">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            ) : !hasUnresolvedActivity ? (
              <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/45" />
            ) : null}
          </SidebarMenuButton>
        }
      />
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={6}
        className="w-[min(21rem,calc(100vw-1rem))] p-0"
      >
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
          <div>
            <PopoverTitle className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
              Activity
            </PopoverTitle>
            <PopoverDescription className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/78">
              Background work and items that need you
            </PopoverDescription>
          </div>
          <PopoverClose
            aria-label="Close Activity"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <XIcon aria-hidden className="size-3.5" />
          </PopoverClose>
        </div>

        <div className="max-h-[min(28rem,var(--available-height))] overflow-y-auto px-1.5 py-1.5">
          {visibleItems.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <CircleCheckIcon className="mx-auto mb-2 size-5 text-muted-foreground/45" />
              <div className="text-[length:var(--app-font-size-ui,12px)] text-foreground/86">
                All caught up
              </div>
              <div className="mt-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/72">
                Background activity will appear here.
              </div>
            </div>
          ) : (
            ACTIVITY_GROUP_ORDER.map((status) => {
              const group = groups[status];
              if (group.length === 0) return null;
              return (
                <section
                  className="not-first:border-t not-first:border-border/60 not-first:pt-1.5 not-first:mt-1.5"
                  key={status}
                >
                  <div className="flex items-center justify-between px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-muted-foreground/78">
                    <span>{ACTIVITY_GROUP_LABEL[status]}</span>
                    <span className="tabular-nums">{group.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {group.map((item) => (
                      <ActivityRow item={item} key={item.id} onActivate={activate} />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/70 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1">
            {unreadCount > 0 ? (
              <Button size="xs" variant="ghost" onClick={markAllRead}>
                Mark all read
              </Button>
            ) : null}
            {items.some((item) => item.status === "recent" && item.readAt) ? (
              <Button size="xs" variant="ghost" onClick={clearRead}>
                Clear read history
              </Button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {items.length > ACTIVITY_PREVIEW_LIMIT ? (
              <Button size="xs" variant="ghost" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "Show less" : "View all activity"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings", search: { section: "notifications" } });
              }}
            >
              Settings
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
