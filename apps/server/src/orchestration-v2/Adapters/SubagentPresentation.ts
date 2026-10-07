import type { OrchestrationV2SubagentPresentation } from "@t3tools/contracts";

type Usage = NonNullable<OrchestrationV2SubagentPresentation["usage"]>;

/** Native usage frames are sparse cumulative observations within one activation. */
function mergeUsage(previous: Usage | undefined, update: Usage | undefined): Usage | undefined {
  if (update === undefined) return previous;
  if (previous === undefined) return update;
  const keys = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "toolUses",
    "durationMs",
  ] as const;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const before = previous[key];
      const next = update[key];
      const observed =
        before === undefined ? next : next === undefined ? before : Math.max(before, next);
      return observed === undefined ? [] : [[key, observed]];
    }),
  );
}

/** Sparse observations enrich display state; execution state remains on the entity. */
export function mergeSubagentPresentation(
  previous: OrchestrationV2SubagentPresentation | undefined,
  update: Partial<OrchestrationV2SubagentPresentation> | undefined,
  now: string,
  reopened = false,
): OrchestrationV2SubagentPresentation {
  const retained: OrchestrationV2SubagentPresentation | undefined =
    previous === undefined
      ? undefined
      : reopened
        ? (({ usage: _usage, outputFile: _output, lastToolName: _tool, ...identity }) => identity)(
            previous,
          )
        : previous;
  const usage = mergeUsage(retained?.usage, update?.usage);
  return {
    kind: previous?.kind ?? "subagent",
    ...retained,
    ...update,
    ...(usage === undefined ? {} : { usage }),
    ...(update?.runHandles === undefined
      ? {}
      : {
          runHandles: { ...previous?.runHandles, ...update.runHandles },
        }),
    firstSeenAt: previous?.firstSeenAt ?? update?.firstSeenAt ?? now,
    activationCount: reopened
      ? (previous?.activationCount ?? 1) + 1
      : (previous?.activationCount ?? update?.activationCount ?? 1),
  };
}
