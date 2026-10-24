// SCIENT-OWNED: the Overleaf tab's per-file decisions. New files go to Overleaf
// by default; one can be kept only on this computer, and a file the rule
// skips, or one kept only here, can be sent anyway. A file waiting for its
// conflict marks can be sent as it is ("Send it anyway"), for a file whose marks
// are its content. A decision waits for the tab's next Sync, which carries it.
import type { ScientOverleafReview } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { UNSENDABLE_REASONS, workspacePathOf, type OverleafFileDecision } from "./overleafModel";

/** Why the rule leaves a new file out, in a few words. */
function skippedReasonText(reason: string): string {
  switch (reason) {
    case "build-output":
      return "Build output";
    case "hidden":
      return "Hidden file";
    case "scient-project-file":
      return "Scient project file";
    case "too-large":
      return "Over Overleaf's 50 MB limit";
    case "lfs-pointer":
      return "Git LFS pointer";
    default:
      return "Skipped";
  }
}

/** How many new files the next sync sends, with the decisions made so far. */
function newFilesToSend(
  review: Pick<ScientOverleafReview, "additions">,
  decisions: ReadonlyMap<string, OverleafFileDecision>,
): number {
  // Without a decision a file goes by the rule: sent unless the rule skips it. A review's
  // `selected` may encode the decision of the sync that produced it, which may since be undone.
  return review.additions.filter((addition) =>
    decisions.has(addition.path)
      ? decisions.get(addition.path) === "send"
      : addition.skippedBecause === null,
  ).length;
}

function DecisionButton(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly path: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      disabled={props.disabled}
      aria-label={`${props.label}: ${props.path}`}
      className={cn(
        "h-5 shrink-0 cursor-pointer rounded px-1.5 text-2xs transition-colors duration-75",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        "disabled:cursor-default disabled:opacity-50",
        props.pressed
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  );
}

function FileRow(props: {
  readonly path: string;
  readonly folder: string;
  readonly note: string | null;
  readonly onOpenFile: (path: string) => void;
  readonly children?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/30">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
        onClick={() => props.onOpenFile(workspacePathOf(props.folder, props.path))}
      >
        {props.path}
      </button>
      {props.note ? (
        <span className="shrink-0 text-2xs text-muted-foreground">{props.note}</span>
      ) : null}
      {props.children}
    </li>
  );
}

export function OverleafNewFiles(props: {
  readonly review: Pick<ScientOverleafReview, "additions" | "localOnly" | "unresolvedMarkers">;
  readonly folder: string;
  readonly decisions: ReadonlyMap<string, OverleafFileDecision>;
  readonly onDecide: (path: string, decision: OverleafFileDecision | null) => void;
  readonly onOpenFile: (path: string) => void;
  /** While a sync runs, decisions wait: one made now wouldn't be in it. */
  readonly disabled?: boolean;
}) {
  const { review, folder, decisions, onDecide } = props;
  const toggle = (path: string, decision: OverleafFileDecision) =>
    onDecide(path, decisions.get(path) === decision ? null : decision);
  const sending = newFilesToSend(review, decisions);
  const pending = decisions.size > 0;
  return (
    <>
      {review.additions.length > 0 ? (
        <section className="flex flex-col gap-1" aria-label="New files">
          <h3 className="flex items-baseline justify-between gap-2 px-1 text-xs font-medium text-muted-foreground">
            New files
            <span className="font-normal" data-overleaf-new-files>
              {sending === 1 ? "1 will be sent" : `${sending} will be sent`}
              {pending ? " at the next sync" : ""}
            </span>
          </h3>
          <ul className="flex flex-col">
            {review.additions.map((addition) =>
              // Rows follow the rule, not this review's selection, which may already carry a
              // decision from the sync that produced it.
              addition.skippedBecause === null ? (
                <FileRow
                  key={addition.path}
                  path={addition.path}
                  folder={folder}
                  note={null}
                  onOpenFile={props.onOpenFile}
                >
                  <DecisionButton
                    label="Keep only on this computer"
                    path={addition.path}
                    pressed={decisions.get(addition.path) === "keep"}
                    disabled={props.disabled ?? false}
                    onPress={() => toggle(addition.path, "keep")}
                  />
                </FileRow>
              ) : (
                <FileRow
                  key={addition.path}
                  path={addition.path}
                  folder={folder}
                  note={skippedReasonText(addition.skippedBecause ?? "")}
                  onOpenFile={props.onOpenFile}
                >
                  {UNSENDABLE_REASONS.has(addition.skippedBecause ?? "") ? null : (
                    <DecisionButton
                      label="Send this file"
                      path={addition.path}
                      pressed={decisions.get(addition.path) === "send"}
                      disabled={props.disabled ?? false}
                      onPress={() => toggle(addition.path, "send")}
                    />
                  )}
                </FileRow>
              ),
            )}
          </ul>
        </section>
      ) : null}
      {review.unresolvedMarkers.length > 0 ? (
        <section className="flex flex-col gap-1" aria-label="Waiting for conflicts">
          <h3 className="px-1 text-xs font-medium text-muted-foreground">Waiting for conflicts</h3>
          <ul className="flex flex-col">
            {review.unresolvedMarkers.map((path) => (
              <FileRow
                key={path}
                path={path}
                folder={folder}
                note={null}
                onOpenFile={props.onOpenFile}
              >
                <DecisionButton
                  label="Send it anyway"
                  path={path}
                  pressed={decisions.get(path) === "release"}
                  disabled={props.disabled ?? false}
                  onPress={() => toggle(path, "release")}
                />
              </FileRow>
            ))}
          </ul>
        </section>
      ) : null}
      {review.localOnly.length > 0 ? (
        <section className="flex flex-col gap-1" aria-label="Kept only here">
          <h3 className="px-1 text-xs font-medium text-muted-foreground">Kept only here</h3>
          <ul className="flex flex-col">
            {review.localOnly.map((path) => (
              <FileRow
                key={path}
                path={path}
                folder={folder}
                note={null}
                onOpenFile={props.onOpenFile}
              >
                <DecisionButton
                  label="Send this file"
                  path={path}
                  pressed={decisions.get(path) === "send"}
                  disabled={props.disabled ?? false}
                  onPress={() => toggle(path, "send")}
                />
              </FileRow>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
