import { msg, T, useGT, Var } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import type { ScientSourceImportOperation } from "@t3tools/contracts";
import {
  Activity as ActivityIcon,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Hourglass,
  Info,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { randomUUID } from "../../lib/utils";
import { ScientTooltip } from "../presentation/ScientTooltip";
import {
  importPreparationLabel,
  importProgressLabel,
  sourcesResultReducer,
  type SourcesActivity,
  type SourcesActivityItem,
  type SourcesActivityTone,
  type SourcesResult,
  type SourcesResultAction,
  type SourcesResultContent,
  type SourcesResultState,
} from "./sourcesFeedback";
import type { ImportPreparation } from "./sourcesWorkflow";

export interface SourcesResultControls {
  /** The result shown for this project, or null. */
  readonly result: SourcesResult | null;
  /** A new operation the person started: clears the result and returns its id. */
  readonly begin: () => string;
  /** False when a newer start or a change of project superseded the operation. */
  readonly settle: (operationId: string, content: SourcesResultContent | null) => boolean;
  /** Begins, waits for `work`, and shows what `present` makes of its answer or its failure. */
  readonly track: <A>(
    work: () => Promise<A>,
    present: (value: A) => SourcesResultContent | null,
    presentFailure?: (cause: unknown) => SourcesResultContent | null,
  ) => Promise<A>;
  readonly dismiss: () => void;
}

/**
 * The one result slot of a project's Library. `begin` when the person starts something, then
 * `settle` with what it did: a completion that a newer start superseded changes nothing. The
 * result stays until dismissed, the next start, or a change of project or environment.
 */
export function useSourcesResult(context: string): SourcesResultControls {
  const [state, setState] = useState<SourcesResultState>(() => ({
    context,
    newest: null,
    shown: null,
  }));
  // Starts and completions arrive from async work between renders; they read the newest state.
  const latest = useRef(state);
  const apply = (action: SourcesResultAction) => {
    const next = sourcesResultReducer(latest.current, action);
    latest.current = next;
    setState(next);
    return next;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new project or environment drops the result and every start begun under the old one
  useLayoutEffect(() => {
    const next = sourcesResultReducer(latest.current, { type: "contextChanged", context });
    if (next === latest.current) return;
    latest.current = next;
    setState(next);
  }, [context]);

  const begin = () => {
    const operationId = randomUUID();
    apply({ type: "begin", context, operationId });
    return operationId;
  };
  const settle = (operationId: string, content: SourcesResultContent | null) =>
    apply({ type: "settle", operationId, content }).newest === operationId;
  return {
    result: state.context === context ? state.shown : null,
    begin,
    settle,
    track: (work, present, presentFailure) => {
      const operationId = begin();
      return work().then(
        (value) => {
          settle(operationId, present(value));
          return value;
        },
        (cause: unknown) => {
          if (presentFailure) settle(operationId, presentFailure(cause));
          throw cause;
        },
      );
    },
    dismiss: () => void apply({ type: "dismiss" }),
  };
}

const RESULT_ICON = {
  success: <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />,
  error: <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />,
  info: <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden />,
} as const;

/** The finished action's result above the list: two lines at most, with Details and Dismiss. */
export function SourcesResultSlot(props: {
  readonly result: SourcesResult | null;
  /** Opens Activity, where the whole receipt is; offered when the result has details. */
  readonly onDetails?: () => void;
  readonly onDismiss: () => void;
}) {
  const { result } = props;
  if (!result) return null;
  return (
    <div
      role={result.tone === "error" ? "alert" : "status"}
      className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs"
    >
      {RESULT_ICON[result.tone]}
      <div className="line-clamp-2 min-w-0 flex-1 break-words">{result.summary}</div>
      <div className="flex shrink-0 items-center gap-1">
        {result.actions}
        {result.details && props.onDetails ? (
          <Button size="xs" variant="ghost" onClick={props.onDetails}>
            <T context="noun, more information">Details</T>
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={props.onDismiss}>
          <T>Dismiss</T>
        </Button>
      </div>
    </div>
  );
}

const TONE_ICON: Record<SourcesActivityTone, ReactNode> = {
  running: <Hourglass className="size-4 shrink-0 text-muted-foreground" aria-hidden />,
  error: <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />,
  decision: <CircleHelp className="size-4 shrink-0 text-warning" aria-hidden />,
  advisory: <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden />,
};

function ActivitySection(props: {
  readonly title: string;
  readonly items: ReadonlyArray<SourcesActivityItem>;
}) {
  if (props.items.length === 0) return null;
  return (
    <section aria-label={props.title} className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      <ul className="space-y-2">
        {props.items.map((item) => (
          <li
            key={item.key}
            className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs break-words tabular-nums"
          >
            {TONE_ICON[item.tone]}
            <div className="min-w-0 flex-1">{item.body}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The header's Activity button and its one dialog: running work, what needs the person, and
 * the current result. Nothing opens it on its own, and closing it only closes the view.
 */
export function SourcesActivityButton(props: {
  readonly activity: SourcesActivity;
  readonly result: SourcesResult | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDismissResult: () => void;
}) {
  const gt = useGT();
  const { activity, result } = props;
  if (activity.count === 0 && !result && !props.open) return null;
  const choices = activity.issues.filter((item) => item.tone !== "advisory");
  const notices = activity.issues.filter((item) => item.tone === "advisory");
  const button = (
    <Button
      size="xs"
      variant="ghost"
      aria-label={
        activity.count > 0
          ? gt("Activity: {count}", { count: activity.count })
          : gt("Activity", { $context: "running and finished Library work" })
      }
      onClick={() => props.onOpenChange(true)}
    >
      <ActivityIcon />
      <span className="@max-[20rem]:hidden">
        <T context="running and finished Library work">Activity</T>
      </span>
      {activity.count > 0 ? <span className="tabular-nums">{activity.count}</span> : null}
    </Button>
  );
  return (
    <>
      {activity.summary ? (
        <ScientTooltip content={activity.summary}>{button}</ScientTooltip>
      ) : (
        button
      )}
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              <T context="running and finished Library work">Activity</T>
            </DialogTitle>
            <DialogDescription>
              {activity.summary ??
                (activity.count === 0 ? gt("Nothing is running and nothing needs you.") : null)}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ActivitySection
              title={gt("Running", { $context: "status of a task" })}
              items={activity.running}
            />
            <ActivitySection title={gt("Needs you")} items={choices} />
            <ActivitySection title={gt("Other notices")} items={notices} />
            {result ? (
              <section aria-label={gt("Latest result")} className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  <T>Latest result</T>
                </h3>
                <div className="space-y-2 rounded-md bg-muted/40 px-3 py-2 text-xs break-words">
                  <div className="flex items-start gap-2">
                    {RESULT_ICON[result.tone]}
                    <div className="min-w-0 flex-1">{result.summary}</div>
                  </div>
                  {result.details}
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {result.actions}
                    <Button size="xs" variant="ghost" onClick={props.onDismissResult}>
                      <T>Dismiss</T>
                    </Button>
                  </div>
                </div>
              </section>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** Activity items from the Library's own state: import work, an action's error, a failed read. */
export function sourcesStateActivity(
  input: {
    readonly importPreparation: ImportPreparation | null;
    readonly operation: ScientSourceImportOperation | null;
    /** The running import's own view, with its Cancel; its progress line otherwise. */
    readonly operationBody?: ReactNode;
    readonly error: string | null;
    readonly onDismissError: () => void;
    /** Pass only while a list is shown: with none, the panel shows the load failure itself. */
    readonly overviewError: string | null;
    readonly onRetryOverview: () => void;
  },
  resolve: MessageResolver = m,
): ReadonlyArray<SourcesActivityItem> {
  const items: SourcesActivityItem[] = [];
  if (input.importPreparation) {
    const label = importPreparationLabel(input.importPreparation, resolve);
    items.push({ key: "import-preparation", tone: "running", label, body: <p>{label}…</p> });
  }
  if (input.operation?.state === "running") {
    const label = importProgressLabel(input.operation, resolve);
    items.push({
      key: `import:${input.operation.operationId}`,
      tone: "running",
      label,
      body: input.operationBody ?? <p>{label}.</p>,
    });
  }
  if (input.error) {
    items.push({
      key: "action-error",
      tone: "error",
      label: input.error,
      body: (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-destructive">{input.error}</p>
          <Button size="xs" variant="ghost" onClick={input.onDismissError}>
            <T>Dismiss</T>
          </Button>
        </div>
      ),
    });
  }
  if (input.overviewError) {
    items.push({
      key: "overview-error",
      tone: "error",
      label: resolve(msg("The list could not be read again")),
      body: (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1">
            <T>
              The list could not be read again, so it may be out of date:{" "}
              <Var>{input.overviewError}</Var>
            </T>
          </p>
          <Button size="xs" variant="ghost" onClick={input.onRetryOverview}>
            <T>Try again</T>
          </Button>
        </div>
      ),
    });
  }
  return items;
}
