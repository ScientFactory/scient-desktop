import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { CheckIcon, CircleDotIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { ComposerBanner } from "~/components/chat/ComposerBanner";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { formatDuration } from "~/session-logic";

import { selectThreadTaskList, type ThreadTaskList } from "./threadTasks";

type TaskStep = ThreadTaskList["steps"][number];

const DISMISSED_LISTS_KEY = "scient:thread-tasks-dismissed:v1";
const DismissedLists = Schema.Array(Schema.String);
const NO_DISMISSED_LISTS: readonly string[] = [];
const MAX_DISMISSED_LISTS = 200;
const MAX_TASK_SEGMENTS = 10;

const stepStatusLabels = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
} satisfies Record<TaskStep["status"], string>;

function TaskSegments({ steps }: { readonly steps: readonly TaskStep[] }) {
  if (steps.length <= 1 || steps.length > MAX_TASK_SEGMENTS) return null;
  return (
    <span aria-hidden className="hidden w-20 shrink-0 items-center gap-0.5 @min-[560px]:flex">
      {steps.map((step) => (
        <span
          key={step.id}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-full",
            step.status === "completed"
              ? "bg-success"
              : step.status === "running"
                ? "bg-primary"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function TaskRow({ step }: { readonly step: TaskStep }) {
  return (
    <ComposerBanner.Row render={<li />} className="items-start py-1 pe-2">
      <ComposerBanner.Icon
        className={cn(
          "h-4",
          step.status === "completed"
            ? "text-success"
            : step.status === "running"
              ? "text-primary"
              : "text-muted-foreground/40",
        )}
      >
        {step.status === "completed" ? (
          <CheckIcon />
        ) : step.status === "running" ? (
          <CircleDotIcon />
        ) : (
          <CircleIcon />
        )}
      </ComposerBanner.Icon>
      <ComposerBanner.Content
        className={cn(
          "block wrap-anywhere",
          step.status === "completed"
            ? "text-muted-foreground/55"
            : step.status === "running"
              ? "text-foreground/90"
              : "text-muted-foreground/70",
        )}
      >
        <span className="sr-only">{stepStatusLabels[step.status]}: </span>
        {step.text}
      </ComposerBanner.Content>
      {step.durationMs === undefined ? null : (
        <ComposerBanner.Actions>
          <span className="text-3xs/4 whitespace-nowrap text-muted-foreground/45 tabular-nums">
            {formatDuration(step.durationMs)}
          </span>
        </ComposerBanner.Actions>
      )}
    </ComposerBanner.Row>
  );
}

/** The thread's unfinished tasks, held on the composer so they stay in view while the thread moves. */
export function ThreadTasksBar({ projection }: { readonly projection: ThreadStructure | null }) {
  const [expanded, setExpanded] = useState(false);
  const [dismissedLists, setDismissedLists] = useLocalStorage(
    DISMISSED_LISTS_KEY,
    NO_DISMISSED_LISTS,
    DismissedLists,
  );

  const list = selectThreadTaskList(projection);
  if (list === null) return null;
  const listKey = `${list.threadId}:${list.id}`;
  if (dismissedLists.includes(listKey)) return null;

  const completed = list.steps.filter((step) => step.status === "completed").length;
  const total = list.steps.length;
  const current =
    list.steps.find((step) => step.status === "running") ??
    list.steps.find((step) => step.status === "pending");

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-scient-thread-tasks="true">
        <div className="flex min-w-0 items-center">
          <ComposerBanner.Row
            render={<button type="button" />}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse tasks" : "Tasks"}: ${completed} of ${total} complete. Current task: ${current?.text}`}
            className="min-w-0 flex-1"
            onClick={() => setExpanded((open) => !open)}
            // Opening the list must not take focus from the message being typed.
            onPointerDown={(event) => event.preventDefault()}
          >
            <ComposerBanner.Icon>
              <ListTodoIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="shrink-0 text-muted-foreground">Tasks</span>
              <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80">
                {current?.text}
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ComposerBanner.Count>
                {completed}/{total}
              </ComposerBanner.Count>
              <TaskSegments steps={list.steps} />
              <ComposerBanner.ToggleIcon expanded={expanded} />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
          <ComposerBanner.Dismiss
            aria-label="Dismiss tasks"
            className="rounded-se-xl"
            onClick={() =>
              setDismissedLists((dismissed) => [...dismissed, listKey].slice(-MAX_DISMISSED_LISTS))
            }
            onPointerDown={(event) => event.preventDefault()}
          />
        </div>
        {expanded ? (
          <ComposerBanner.Scroll>
            <ComposerBanner.Children
              render={<ul role="list" />}
              aria-label={`Task list. ${completed} of ${total} complete.`}
            >
              {list.steps.map((step) => (
                <TaskRow key={step.id} step={step} />
              ))}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
