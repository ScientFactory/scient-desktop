import { useState, type ComponentType } from "react";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { cn } from "~/lib/utils";

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

const AGENT_MEMBER_STATUS_LABEL: Record<RuntimeSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

export function AgentSpawnMemberRow({
  agent,
  onToggleEntry,
  WorkingTimer,
  failedToolIconClassName,
  toolCallExpandedBodyClassName,
}: {
  agent: RuntimeSubagent;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
  WorkingTimer: ComponentType<{ createdAt: string }>;
  failedToolIconClassName: string;
  toolCallExpandedBodyClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const activeStatus = isActiveSubagentStatus(agent.status);
  const activity = activeStatus
    ? (agent.progress ?? (agent.lastToolName ? `▸ ${agent.lastToolName}` : null))
    : (agent.error ?? agent.result ?? agent.progress ?? null);
  const durationMs =
    agent.startedAt && agent.completedAt
      ? Date.parse(agent.completedAt) - Date.parse(agent.startedAt)
      : null;
  const meta = [
    durationMs !== null && durationMs >= 0 ? formatDuration(durationMs) : null,
    agent.usage?.totalTokens !== undefined && agent.usage.totalTokens > 0
      ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Settled members show their metrics; anything other than success keeps
  // the status word so the outcome remains explicit.
  const statusLabel =
    activeStatus || !meta
      ? AGENT_MEMBER_STATUS_LABEL[agent.status]
      : agent.status === "completed"
        ? meta
        : `${AGENT_MEMBER_STATUS_LABEL[agent.status]} · ${meta}`;
  const role =
    agent.role && agent.role.trim().toLowerCase() !== agent.title.trim().toLowerCase()
      ? agent.role
      : null;
  const firstLine = activity?.split("\n").find((line) => line.trim().length > 0) ?? null;
  const body = [activity?.trim() || null, formatSubagentModelLabel(agent.model, agent.effort)]
    .filter(Boolean)
    .join("\n\n");
  const canExpand = body.length > 0;
  const toggleOpen = () => {
    onToggleEntry?.(open);
    setOpen((value) => !value);
  };

  return (
    <div
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-label={canExpand ? `${agent.title}, ${statusLabel}` : undefined}
      aria-expanded={canExpand ? open : undefined}
      onClick={canExpand ? toggleOpen : undefined}
      onKeyDown={
        canExpand
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleOpen();
              }
            }
          : undefined
      }
      className={cn(
        "flex flex-col rounded-md px-1 py-1 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      <div className="flex select-none items-center gap-1.5">
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
          <span
            className={cn(
              "min-w-0 truncate",
              agent.status === "failed" ? failedToolIconClassName : "text-foreground/80",
            )}
          >
            {agent.title}
          </span>
          {role ? (
            <span className="scient-reading-micro max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-muted-foreground">
              {role}
            </span>
          ) : null}
        </p>
        <span className="scient-reading-compact shrink-0 font-mono tabular-nums text-muted-foreground">
          {activeStatus && agent.startedAt ? (
            <>
              {`${statusLabel} · `}
              <WorkingTimer createdAt={agent.startedAt} />
            </>
          ) : (
            statusLabel
          )}
        </span>
      </div>
      {!open && firstLine ? (
        <p className="truncate text-xs text-muted-foreground">{firstLine}</p>
      ) : null}
      {open ? (
        <div
          className="mt-1 cursor-default rounded-md bg-muted/40 px-3 py-2"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className={toolCallExpandedBodyClassName}>{body}</pre>
        </div>
      ) : null}
    </div>
  );
}
