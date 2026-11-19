import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** "Ran 2 subagents", "Launched 1 subagent and 2 batches": what the row started, as one sentence. */
function spawnLead(
  input: { readonly individuals: number; readonly batches: number; readonly live: boolean },
  resolve: MessageResolver,
): string {
  const { individuals, batches, live } = input;
  if (batches > 0)
    return individuals > 0
      ? resolve(
          msg(
            "Launched {individuals, plural, one {{individuals} subagent} other {{individuals} subagents}} and {batches, plural, one {{batches} batch} other {{batches} batches}}",
            { individuals, batches },
          ),
        )
      : resolve(
          msg(
            "{count, plural, one {Launched {count} subagent batch} other {Launched {count} subagent batches}}",
            { count: batches },
          ),
        );
  if (individuals > 0)
    return live
      ? resolve(
          msg(
            "{count, plural, one {Kicked off {count} subagent} other {Kicked off {count} subagents}}",
            { count: individuals },
          ),
        )
      : resolve(
          msg("{count, plural, one {Ran {count} subagent} other {Ran {count} subagents}}", {
            count: individuals,
          }),
        );
  return live ? resolve(msg("Kicked off subagents")) : resolve(msg("Ran subagents"));
}

export function deriveAgentSpawnSummary(
  {
    agents,
    agentCount,
    coordinatorStatus,
  }: {
    agents: ReadonlyArray<Pick<RuntimeSubagent, "kind" | "status">>;
    agentCount: number;
    coordinatorStatus?: RuntimeSubagent["status"] | undefined;
  },
  resolve: MessageResolver = m,
) {
  const working = agents.filter((agent) => isActiveSubagentStatus(agent.status)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted",
  ).length;
  const batches = agents.filter((agent) => agent.kind === "subagent_batch").length;
  const individuals = agentCount - batches;
  const live =
    coordinatorStatus !== undefined ? !isTerminalSubagentStatus(coordinatorStatus) : working > 0;
  const lead = spawnLead({ individuals, batches, live }, resolve);

  const completed =
    !live &&
    coordinatorStatus !== "failed" &&
    coordinatorStatus !== "cancelled" &&
    coordinatorStatus !== "interrupted" &&
    failed === 0 &&
    stopped === 0 &&
    idle === 0 &&
    (coordinatorStatus === "completed" || (agents.length > 0 && agents.length >= agentCount));
  const status = live
    ? working > 0
      ? resolve(msg("{count} working", { count: working }))
      : resolve(msg("working", { $context: "subagents are still running" }))
    : coordinatorStatus === "failed"
      ? resolve(msg("Workflow failed"))
      : coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted"
        ? resolve(msg("Workflow stopped"))
        : failed > 0
          ? resolve(msg("{count} failed", { count: failed }))
          : stopped > 0
            ? resolve(msg("{count} stopped", { count: stopped }))
            : idle > 0
              ? resolve(msg("{count} idle", { count: idle }))
              : completed
                ? resolve(msg("✓ completed"))
                : resolve(msg("Status unavailable"));
  const tone = live
    ? "working"
    : failed > 0 || coordinatorStatus === "failed"
      ? "failed"
      : completed
        ? "completed"
        : "inactive";
  return { live, lead, status, tone };
}

/**
 * The collapsed row's text: what was launched and, unless everything simply
 * completed, how it stands ("1 working", "1 failed", "1 stopped"), so a row
 * nobody opens still says whether the agents are alive and how they ended.
 */
export function agentSpawnRowLabel(
  summary: Pick<ReturnType<typeof deriveAgentSpawnSummary>, "lead" | "status" | "tone">,
  workflowName: string | null,
): string {
  const lead = workflowName ? `${summary.lead} · ${workflowName}` : summary.lead;
  return summary.tone === "completed" ? lead : `${lead} · ${summary.status}`;
}
