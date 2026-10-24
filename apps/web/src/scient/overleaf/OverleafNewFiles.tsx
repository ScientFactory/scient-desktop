// SCIENT-OWNED: the Overleaf tab's per-file decisions. New files go to Overleaf
// by default; one can be kept only on this computer, and a file the rule
// skips, or one kept only here, can be sent anyway. A decision waits for the
// tab's next Sync, which carries it.
import type { ScientOverleafReview } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { workspacePathOf } from "./overleafModel";

export type OverleafFileDecision = "keep" | "send";

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

/** Overleaf refuses these whatever anyone decides. */
const UNSENDABLE = new Set(["too-large", "lfs-pointer"]);

/** How many new files the next sync sends, with the decisions made so far. */
function newFilesToSend(
  review: Pick<ScientOverleafReview, "additions">,
  decisions: ReadonlyMap<string, OverleafFileDecision>,
): number {
  return review.additions.filter((addition) =>
    decisions.has(addition.path) ? decisions.get(addition.path) === "send" : addition.selected,
  ).length;
}

/**
 * The decisions that still apply to the review shown. A review from a sync
 * that carried decisions already encodes them (a kept file not selected, a
 * sent one selected, a sent local-only file read like a new one), so a
 * decision applies when its file is still where it can be decided:
 * - "keep" for a new file the rule would send (whether or not this review
 *   already leaves it out);
 * - "send" for a new file the rule skips and Overleaf would take, or a file
 *   kept only here.
 * A decision for a file no longer listed, or now impossible (too large), is
 * left out, so it is neither shown nor sent.
 */
export function actionableDecisions(
  review: Pick<ScientOverleafReview, "additions" | "localOnly"> | null,
  decisions: ReadonlyMap<string, OverleafFileDecision>,
): ReadonlyMap<string, OverleafFileDecision> {
  if (review === null || decisions.size === 0) return NO_DECISIONS;
  const additions = new Map(review.additions.map((addition) => [addition.path, addition]));
  const localOnly = new Set(review.localOnly);
  const kept = new Map<string, OverleafFileDecision>();
  for (const [path, decision] of decisions) {
    const addition = additions.get(path);
    const applies =
      decision === "keep"
        ? addition !== undefined && addition.skippedBecause === null
        : localOnly.has(path) ||
          (addition !== undefined &&
            addition.skippedBecause !== null &&
            !UNSENDABLE.has(addition.skippedBecause));
    if (applies) kept.set(path, decision);
  }
  return kept.size === decisions.size ? decisions : kept;
}

const NO_DECISIONS: ReadonlyMap<string, OverleafFileDecision> = new Map();

/** The decisions as a sync request carries them. */
export function fileDecisionsRequest(decisions: ReadonlyMap<string, OverleafFileDecision>) {
  const keepOnlyHere: string[] = [];
  const send: string[] = [];
  for (const [path, decision] of decisions) (decision === "keep" ? keepOnlyHere : send).push(path);
  return { keepOnlyHere, send };
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
  readonly review: Pick<ScientOverleafReview, "additions" | "localOnly">;
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
                  {UNSENDABLE.has(addition.skippedBecause ?? "") ? null : (
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
