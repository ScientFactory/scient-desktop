import type { ComputeSubscriptionState } from "@t3tools/client-runtime/state/compute";
import type { ComputeExecutionRecord, ComputeSessionRecord } from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { observeResize } from "~/lib/observeResize";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";

import type { ComputeFeedEntry } from "./computeFeedModel";
import { ComputeRunEntry, type ComputeRunEntryProps } from "./ComputeRunEntry";

const FEED_PAGE = 30;
const FOLLOW_SLACK = 32;

type SharedRunProps = Omit<
  ComputeRunEntryProps,
  "session" | "execution" | "live" | "newest" | "fresh" | "dependencyRecovery"
>;

function liveOutputs(
  events: ComputeSubscriptionState | null,
  session: ComputeSessionRecord,
  execution: ComputeExecutionRecord,
) {
  return events?.outputs.get(`${session.sessionId}/${execution.request.executionId}`);
}

/** A Run fresh session's runs, read from its own history. */
function ComputeFreshEntry(
  props: SharedRunProps & {
    readonly session: ComputeSessionRecord;
    readonly events: ComputeSubscriptionState | null;
    readonly newest: boolean;
  },
) {
  const { session, events, newest, ...shared } = props;
  const executions = useEnvironmentQuery(
    computeEnvironment.executions({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, sessionId: session.sessionId, limit: 10 },
    }),
  );
  const byId = new Map<string, ComputeExecutionRecord>();
  for (const execution of executions.data ?? []) byId.set(execution.request.executionId, execution);
  for (const execution of events?.executions.get(session.sessionId)?.values() ?? []) {
    byId.set(execution.request.executionId, execution);
  }
  return [...byId.values()]
    .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt))
    .map((execution) => (
      <ComputeRunEntry
        key={execution.request.executionId}
        {...shared}
        session={session}
        execution={execution}
        live={liveOutputs(events, session, execution)}
        newest={newest}
        fresh
      />
    ));
}

/**
 * A session's runs as one cumulative feed, newest last. It follows new output while scrolled to the
 * bottom and stops when the reader scrolls up; a newly submitted run resumes following.
 */
export function ComputeResultsFeed(
  props: SharedRunProps & {
    readonly entries: ReadonlyArray<ComputeFeedEntry>;
    readonly events: ComputeSubscriptionState | null;
    readonly dependencyRecoveryFor: (
      entry: Extract<ComputeFeedEntry, { readonly kind: "run" }>,
    ) => ComputeRunEntryProps["dependencyRecovery"];
    readonly followRequest: string | null;
    readonly onFollowRequestConsumed?: (request: string) => void;
    readonly lead?: ReactNode;
    readonly empty: ReactNode;
  },
) {
  const {
    entries,
    events,
    dependencyRecoveryFor,
    followRequest,
    onFollowRequestConsumed,
    lead,
    empty,
    ...shared
  } = props;
  const [shown, setShown] = useState(FEED_PAGE);
  const following = useRef(true);
  const viewport = useRef<HTMLDivElement>(null);
  const visible = entries.slice(-shown);
  const newestKey = entries.findLast((entry) => entry.kind !== "restart")?.key ?? null;

  // Content and viewport both report; the reader's position decides whether to stay at the end.
  const observe = (content: HTMLDivElement | null) => {
    const node = content?.parentElement;
    if (content == null || node == null) return;
    const onScroll = () => {
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    const stop = observeResize([content, node], () => {
      if (following.current) node.scrollTop = node.scrollHeight;
    });
    return () => {
      node.removeEventListener("scroll", onScroll);
      stop();
    };
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a submitted run moves the scroll container to the end and reports the request consumed
  useEffect(() => {
    if (followRequest === null) return;
    following.current = true;
    const node = viewport.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
    onFollowRequestConsumed?.(followRequest);
  }, [followRequest, onFollowRequestConsumed]);

  if (entries.length === 0 && lead == null) return <>{empty}</>;
  return (
    <div ref={viewport} className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto">
      <div ref={observe} className="divide-y divide-border/60 pb-2">
        {lead}
        {entries.length > visible.length ? (
          <div className="flex justify-center py-1.5">
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                following.current = false;
                setShown((current) => current + FEED_PAGE);
              }}
            >
              Show earlier runs
            </Button>
          </div>
        ) : null}
        {visible.map((entry) => {
          switch (entry.kind) {
            case "restart":
              return (
                <div
                  key={entry.key}
                  role="separator"
                  className="px-3 py-1 text-center text-[11px] text-muted-foreground"
                >
                  Restarted
                </div>
              );
            case "fresh":
              return (
                <ComputeFreshEntry
                  key={entry.key}
                  {...shared}
                  session={entry.session}
                  events={events}
                  newest={entry.key === newestKey}
                />
              );
            case "run": {
              const recovery = dependencyRecoveryFor(entry);
              return (
                <ComputeRunEntry
                  key={entry.key}
                  {...shared}
                  {...(recovery === undefined ? {} : { dependencyRecovery: recovery })}
                  session={entry.session}
                  execution={entry.execution}
                  live={liveOutputs(events, entry.session, entry.execution)}
                  newest={entry.key === newestKey}
                  fresh={false}
                />
              );
            }
          }
        })}
      </div>
    </div>
  );
}
