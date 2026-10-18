import { ArrowUpIcon, CheckIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { flushSync } from "react-dom";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useUpdateEverythingRun } from "~/components/sidebar/updateEverythingRun";
import {
  Popover,
  PopoverCreateHandle,
  PopoverPopup,
  PopoverTrigger,
} from "~/components/ui/popover";
import { SidebarMenuItem } from "~/components/ui/sidebar";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import {
  isUpdateRunActive,
  otherUpdateProgressLabel,
  otherUpdateVersionLabel,
  stopsThreadsLabel,
  type OtherServerUpdate,
  type OtherUpdateRow,
  type OtherUpdatesCircleState,
} from "./otherUpdates.logic";
import { UpdateTextButton } from "./UpdateTextButton";
import { useOtherUpdates } from "./useOtherUpdates";

/** How long the finished check stays before the circle steps aside. */
const OTHER_UPDATES_DONE_VISIBLE_MS = 2_500;

const CIRCLE_LABELS: Record<OtherUpdatesCircleState, string> = {
  idle: "Other updates available",
  updating: "Other updates in progress",
  failed: "Other update failed",
  done: "Other updates done",
};

const CIRCLE_TONES: Record<OtherUpdatesCircleState, string> = {
  idle: "bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-400/22 dark:text-blue-300 dark:hover:bg-blue-400/30",
  updating:
    "bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-400/22 dark:text-blue-300 dark:hover:bg-blue-400/30",
  failed:
    "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-400/22 dark:text-red-300 dark:hover:bg-red-400/30",
  done: "bg-green-100 text-green-700 dark:bg-green-400/20 dark:text-green-300",
};

function ExclamationGlyph() {
  return (
    <svg aria-hidden="true" className="size-3" fill="none" viewBox="0 0 24 24">
      <path d="M12 6v8M12 18h.01" stroke="currentColor" strokeLinecap="round" strokeWidth={3} />
    </svg>
  );
}

function ProgressRing() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute -inset-0.5 size-6 animate-spin motion-reduce:animate-none"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="11" stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5} />
      <path
        d="M12 1a11 11 0 0 1 9.53 5.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </svg>
  );
}

const MUTED = "shrink-0 text-muted-foreground tabular-nums";

/** An action that stops running threads asks once, inline, before it runs. */
function AskingAction({
  label,
  stops,
  asking,
  onAsk,
  onRun,
  emphasis = false,
}: {
  readonly label: string;
  readonly stops: number;
  readonly asking: boolean;
  readonly onAsk: () => void;
  readonly onRun: () => void;
  readonly emphasis?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {asking ? (
        <span className={MUTED} data-other-update-ask>
          {stopsThreadsLabel(stops)}
        </span>
      ) : null}
      <UpdateTextButton emphasis={emphasis} onClick={stops > 0 && !asking ? onAsk : onRun}>
        {label}
      </UpdateTextButton>
    </span>
  );
}

function RowEnd({
  row,
  stops,
  asking,
  onAsk,
  onUpdate,
  onRetry,
}: {
  readonly row: OtherUpdateRow;
  readonly stops: number;
  readonly asking: boolean;
  readonly onAsk: () => void;
  readonly onUpdate: () => void;
  readonly onRetry: () => void;
}) {
  const muted = MUTED;
  switch (row.state.status) {
    case "idle":
      return (
        <AskingAction asking={asking} label="Update" stops={stops} onAsk={onAsk} onRun={onUpdate} />
      );
    case "updating":
      return <span className={muted}>{otherUpdateProgressLabel(row.state.progress)}</span>;
    case "waiting":
      return <span className={muted}>waiting for idle</span>;
    case "failed":
      return row.state.retry ? (
        <AskingAction asking={asking} label="Retry" stops={stops} onAsk={onAsk} onRun={onRetry} />
      ) : (
        <span className="shrink-0 text-destructive">failed</span>
      );
    case "done":
      return <span className={muted}>done</span>;
  }
}

/**
 * The footer circle for updates other than this app's own: other machines' servers and apps,
 * one-click provider CLIs and Scient-managed runtimes. It stays until they are updated; its card lists
 * each one and updates them in place, since none of them restarts this app. `standalone`
 * gives it its own footer item when this app's update pill is absent.
 */
export function SidebarOtherUpdates({
  servers,
  updateAll,
  standalone = false,
}: {
  readonly servers: ReadonlyArray<OtherServerUpdate>;
  /** A pass without this app, so it needs no confirmation. */
  readonly updateAll: () => Promise<void>;
  readonly standalone?: boolean;
}) {
  const updates = useOtherUpdates(servers);
  const runActive = isUpdateRunActive(useUpdateEverythingRun());
  const [handle] = useState(() => PopoverCreateHandle());
  const triggerId = useId();
  const [open, setOpen] = useState(false);
  /** The row key, or "all", whose action is asking before it stops running threads. */
  const [asking, setAsking] = useState<string | null>(null);
  const { rows, circle, forget, stoppedThreads } = updates;
  const doneKeys = rows.flatMap(({ item, state }) => (state.status === "done" ? [item.key] : []));
  const finishedKey = circle === "done" && !open ? doneKeys.join("\n") : null;

  useEffect(() => {
    if (finishedKey === null) return;
    const timer = window.setTimeout(
      () => forget(finishedKey.split("\n")),
      OTHER_UPDATES_DONE_VISIBLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [finishedKey, forget]);

  if (circle === null) {
    // The card unmounts with the circle, without reporting that it closed.
    if (open) setOpen(false);
    return null;
  }
  const idleRows = rows.filter(({ state }) => state.status === "idle");
  const canUpdateAll = !runActive && idleRows.length > 0;
  const updateAllStops = idleRows.reduce((count, { item }) => count + stoppedThreads(item), 0);
  const runUpdateAll = async () => {
    setAsking(null);
    const result = await settlePromise(updateAll);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    }
  };

  const control = (
    <Popover
      handle={handle}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setAsking(null);
          forget(doneKeys);
        }
      }}
    >
      <PopoverTrigger
        closeDelay={150}
        handle={handle}
        id={triggerId}
        openOnHover
        render={
          <button
            aria-label={CIRCLE_LABELS[circle]}
            className={cn(
              "relative grid size-5 shrink-0 cursor-pointer place-items-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
              !standalone && "mr-1.5",
              CIRCLE_TONES[circle],
            )}
            data-other-updates={circle}
            // Narrow footers fold their secondary actions to make room, as for the app pill.
            data-update-active
            type="button"
            onFocus={(event) => {
              // Hover-open popovers do not open on focus; keyboard users get the same card.
              if (event.currentTarget.matches(":focus-visible")) {
                flushSync(() => handle.open(triggerId));
              }
            }}
          />
        }
      >
        {circle === "updating" ? <ProgressRing /> : null}
        {circle === "failed" ? (
          <ExclamationGlyph />
        ) : circle === "done" ? (
          <CheckIcon aria-hidden="true" className="size-3" strokeWidth={2.75} />
        ) : (
          <ArrowUpIcon aria-hidden="true" className="size-3" strokeWidth={2.6} />
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" initialFocus={false} padding="compact" side="top" width="sm">
        <div className="flex flex-col gap-2.5 text-xs">
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const secondary = [row.item.machine, otherUpdateVersionLabel(row.item)]
                .filter((part) => part !== null)
                .join(" · ");
              return (
                <li className="flex min-w-0 flex-col" data-other-update-row key={row.item.key}>
                  <div className="flex min-h-5 items-center justify-between gap-3">
                    <span className="min-w-0 truncate">{row.item.name}</span>
                    <RowEnd
                      asking={asking === row.item.key}
                      row={row}
                      stops={stoppedThreads(row.item)}
                      onAsk={() => setAsking(row.item.key)}
                      onRetry={() => {
                        setAsking(null);
                        updates.retry(row);
                      }}
                      onUpdate={() => {
                        setAsking(null);
                        updates.update(row.item);
                      }}
                    />
                  </div>
                  {secondary ? (
                    <span className="truncate text-muted-foreground tabular-nums">{secondary}</span>
                  ) : null}
                  {row.state.status === "failed" ? (
                    <span className="break-words text-destructive">{row.state.reason}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canUpdateAll ? (
            <div className="flex justify-end">
              <AskingAction
                asking={asking === "all"}
                emphasis
                label="Update all"
                stops={updateAllStops}
                onAsk={() => setAsking("all")}
                onRun={() => void runUpdateAll()}
              />
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );

  return standalone ? (
    <SidebarMenuItem className="ml-auto shrink-0">{control}</SidebarMenuItem>
  ) : (
    control
  );
}
