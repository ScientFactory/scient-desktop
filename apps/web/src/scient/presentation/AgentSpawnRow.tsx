import { memo, type ComponentType, type ReactElement, type ReactNode } from "react";
import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import {
  isActiveSubagentStatus,
  projectedSubagentsToRuntime,
  type AgentPanelModel,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { agentSpawnRowLabel, deriveAgentSpawnSummary } from "~/components/chat/agentSpawnSummary";
import { WorkLogBlock } from "~/components/chat/WorkLog";
import { AgentSpawnMemberRow, compactScientAgentLabel } from "./AgentSpawnMemberRow";
import { cn } from "~/lib/utils";

type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

/** One workflow run, or a batch of direct spawns when workflowId is null. */
export interface AgentSpawn {
  /** Workflow coordinator taskId, or null for a direct-spawn batch. */
  readonly workflowId: string | null;
  readonly agentTaskIds: ReadonlyArray<string>;
}

/** The timeline row state an agent-spawn row reads its members from. */
export interface AgentSpawnRowContext {
  readonly agentPanelModel: AgentPanelModel;
  readonly expandedSpawnEntryIds: ReadonlySet<string>;
  readonly onToggleSpawnRow: (entryId: string, expanded: boolean, runId?: RunId) => void;
  readonly onOpenAgents: () => void;
}

/** Timeline renderers the spawn row shares with ordinary work rows. */
export interface AgentSpawnRowRenderers {
  readonly LiveActivityRow: ComponentType<{
    label: ReactNode;
    iconName: "bot";
    active: boolean;
    failed: boolean;
  }>;
  readonly WorkingTimer: ComponentType<{ createdAt: string }>;
  readonly failedToolIconClassName: string;
  readonly toolCallExpandedBodyClassName: string;
}

/** The agent panel roster behind a V2 sub-agent group, when the panel knows any member. */
export function subagentGroupRoster(
  agentPanelModel: AgentPanelModel,
  members: ReadonlyArray<SubagentItem>,
): AgentSpawn | null {
  const workflow = agentPanelModel.workflows.find((group) =>
    members.some((item) => item.subagentId === group.workflow.id),
  );
  const nativeMemberIds: ReadonlyArray<string> = members.map((item) => item.subagentId);
  const hasRoster =
    workflow !== undefined ||
    agentPanelModel.directAgents.some((agent) => nativeMemberIds.includes(agent.id));
  return hasRoster
    ? { workflowId: workflow?.workflow.id ?? null, agentTaskIds: nativeMemberIds }
    : null;
}

/** A roster-backed group; Scient child actions stay inside disclosure. */
export function renderSubagentRosterGroup(
  props: {
    rowId: string;
    continuesWorkLog: boolean | undefined;
    members: ReadonlyArray<SubagentItem>;
    roster: AgentSpawn;
    context: AgentSpawnRowContext & {
      readonly onToggleWorkEntry: (anchorKey: string, collapsed: boolean) => void;
      readonly onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
    };
  } & AgentSpawnRowRenderers,
): ReactElement {
  const { rowId, members, context: ctx } = props;
  const scientMembers =
    members.length > 0 && members.every((member) => member.driver === "scient")
      ? members
      : undefined;
  return (
    <WorkLogBlock continues={props.continuesWorkLog}>
      <AgentSpawnRow
        entryId={rowId}
        spawn={props.roster}
        scientMembers={scientMembers}
        onOpenThread={ctx.onOpenThread}
        onToggleEntry={(wasExpanded) => ctx.onToggleWorkEntry(rowId, wasExpanded)}
        context={ctx}
        LiveActivityRow={props.LiveActivityRow}
        WorkingTimer={props.WorkingTimer}
        failedToolIconClassName={props.failedToolIconClassName}
        toolCallExpandedBodyClassName={props.toolCallExpandedBodyClassName}
      />
      {!scientMembers &&
        members.flatMap((member) => {
          const childThreadId = member.childThreadId;
          return childThreadId === null
            ? []
            : [
                <button
                  key={member.id}
                  type="button"
                  aria-label="Open child thread"
                  onClick={() => ctx.onOpenThread(childThreadId)}
                  className="ms-7 mt-1 self-start text-xs text-muted-foreground hover:text-foreground"
                >
                  Open {member.title ?? "subagent"} thread ›
                </button>,
              ];
        })}
    </WorkLogBlock>
  );
}

/** One tool row per batch, with member results available on expansion. */
const AgentSpawnRow = memo(function AgentSpawnRow(
  props: {
    entryId: string;
    spawn: AgentSpawn;
    active?: boolean | undefined;
    onToggleEntry?: ((collapsed: boolean) => void) | undefined;
    context: AgentSpawnRowContext;
    scientMembers?: ReadonlyArray<SubagentItem> | undefined;
    onOpenThread?: ((threadId: SubagentItem["threadId"]) => void) | undefined;
  } & AgentSpawnRowRenderers,
) {
  const { entryId, spawn, LiveActivityRow, WorkingTimer } = props;
  const { agentPanelModel, expandedSpawnEntryIds, onToggleSpawnRow, onOpenAgents } = props.context;
  const expanded = expandedSpawnEntryIds.has(entryId);

  const memberIds = new Set(spawn.agentTaskIds);
  const workflowGroup = spawn.workflowId
    ? agentPanelModel.workflows.find((group) => group.workflow.id === spawn.workflowId)
    : undefined;
  const rosterAgents = workflowGroup
    ? [...workflowGroup.phases.flatMap((phase) => phase.members), ...workflowGroup.unphasedMembers]
    : agentPanelModel.directAgents.filter((agent) => memberIds.has(agent.id));
  const agents = props.scientMembers
    ? [
        ...rosterAgents,
        ...projectedSubagentsToRuntime(
          props.scientMembers
            .filter((member) => !rosterAgents.some((agent) => agent.id === member.subagentId))
            .map((member) => ({ ...member, id: member.subagentId, model: null })),
        ),
      ]
    : rosterAgents;
  const scientMembers = props.scientMembers;
  if (scientMembers && !workflowGroup) {
    agents.sort(
      (left, right) =>
        left.firstSeenAt.localeCompare(right.firstSeenAt) ||
        scientMembers.findIndex((member) => member.subagentId === left.id) -
          scientMembers.findIndex((member) => member.subagentId === right.id),
    );
  }
  const agentCount = Math.max(
    agents.length,
    Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0),
  );
  const summary = deriveAgentSpawnSummary({
    agents,
    agentCount,
    coordinatorStatus: workflowGroup?.workflow.status,
  });
  const { live } = summary;
  const failed = summary.tone === "failed";
  const workflowName =
    workflowGroup?.workflow.workflowName ?? workflowGroup?.workflow.title ?? null;
  const rawLabel = agentSpawnRowLabel(summary, workflowName);
  const label = props.scientMembers ? compactScientAgentLabel(rawLabel) : rawLabel;
  // The longest-running agent still at work: a quiet row keeps counting.
  const workingSince = agents
    .filter((agent) => isActiveSubagentStatus(agent.status) && agent.startedAt !== null)
    .map((agent) => agent.startedAt!)
    .toSorted()[0];
  const toggleExpanded = () => {
    props.onToggleEntry?.(expanded);
    onToggleSpawnRow(entryId, !expanded, props.scientMembers?.[0]?.runId ?? undefined);
  };

  return (
    <div className={cn("flex flex-col", props.scientMembers && "min-w-0")}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggleExpanded}
        className={cn(
          "flex cursor-pointer select-none rounded-md text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          props.scientMembers && "min-w-0",
        )}
      >
        <LiveActivityRow
          label={
            live && workingSince ? (
              <span className="flex min-w-0">
                <span className="min-w-0 truncate">{label}</span>
                <span className="shrink-0 whitespace-pre tabular-nums">
                  {" · "}
                  <WorkingTimer createdAt={workingSince} />
                </span>
              </span>
            ) : (
              label
            )
          }
          iconName="bot"
          active={live && props.active !== false}
          failed={failed}
        />
      </button>
      {expanded ? (
        <div className={cn("ms-7 mt-0.5 flex flex-col", props.scientMembers && "min-w-0")}>
          {agents.map((agent) => {
            const member = props.scientMembers?.find((item) => item.subagentId === agent.id);
            const childThreadId = member?.childThreadId;
            return (
              <AgentSpawnMemberRow
                key={agent.id}
                agent={agent}
                scientDetail={
                  props.scientMembers
                    ? {
                        assignment: member?.prompt,
                        action:
                          childThreadId && props.onOpenThread ? (
                            <button
                              type="button"
                              aria-label={`Open ${compactScientAgentLabel(agent.title)} thread`}
                              onClick={() => props.onOpenThread?.(childThreadId)}
                              className="mb-1 ms-1 max-w-full self-start rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                            >
                              Open child thread ›
                            </button>
                          ) : null,
                      }
                    : undefined
                }
                onToggleEntry={props.onToggleEntry}
                WorkingTimer={WorkingTimer}
                failedToolIconClassName={props.failedToolIconClassName}
                toolCallExpandedBodyClassName={props.toolCallExpandedBodyClassName}
              />
            );
          })}
          <button
            type="button"
            onClick={onOpenAgents}
            className="mt-1 self-start rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open Agents panel ›
          </button>
        </div>
      ) : null}
    </div>
  );
});
