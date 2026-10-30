import { useStableCallback } from "~/hooks/useStableCallback";
import type { ComputeOutputProjection } from "@t3tools/client-runtime/state/compute";
import type { ComputeSessionRecord, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";

import { ComputeOutputView } from "./ComputeOutputView";
import { mergeComputeOutputs } from "./computeResultPresentation";

/** Output that belongs to the session rather than a run, such as kernel start-up warnings. */
export function ComputeSessionNotices(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly live: ComputeOutputProjection;
  readonly rehydrationToken: string | null;
  readonly session: ComputeSessionRecord;
  readonly threadRef: ScopedThreadRef;
}) {
  const [expanded, setExpanded] = useState(false);
  const persisted = useEnvironmentQuery(
    expanded
      ? computeEnvironment.outputs({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, sessionId: props.session.sessionId, executionId: null },
        })
      : null,
  );
  const outputs = mergeComputeOutputs(persisted.data?.outputs ?? [], props.live.outputs);
  const refresh = useStableCallback(() => persisted.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads persisted session outputs over the environment connection once per rehydration token while expanded
  useEffect(() => {
    if (expanded && props.rehydrationToken !== null) refresh();
  }, [expanded, props.rehydrationToken, refresh]);

  return (
    <section className="px-3 py-2">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Session messages
      </button>
      {expanded ? (
        <div className="mt-2">
          {persisted.error ? (
            <p className="text-xs text-destructive">Couldn&apos;t load these messages</p>
          ) : (
            <ComputeOutputView
              cwd={props.cwd}
              environmentId={props.environmentId}
              session={props.session}
              executionId={null}
              outputs={outputs}
              {...(persisted.data === null
                ? {}
                : { corruptLineCount: persisted.data.corruptLineCount })}
              clipped={persisted.data === null && props.live.clipped}
              threadRef={props.threadRef}
              source={null}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
