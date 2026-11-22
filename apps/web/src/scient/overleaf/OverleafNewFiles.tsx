// SCIENT-OWNED: the Overleaf tab's per-file decisions. New files send by default; one can be
// kept only here, and a skipped, local-only or conflict-marked file can be sent anyway. A
// decision waits for the tab's next Sync, which carries it.
import type { ScientOverleafReview } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";

import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";

import {
  UNSENDABLE_REASONS,
  newFilesToSend,
  workspacePathOf,
  type OverleafFileDecision,
} from "./overleafModel";

/** Why the rule leaves a new file out, in a few words. */
function skippedReasonText(reason: string, resolve: MessageResolver): string {
  switch (reason) {
    case "build-output":
      return resolve(msg("Build output"));
    case "hidden":
      return resolve(msg("Hidden file"));
    case "scient-project-file":
      return resolve(msg("Scient project file"));
    case "too-large":
      return resolve(msg("Over Overleaf's 50 MB limit"));
    case "lfs-pointer":
      return resolve(msg("Git LFS pointer"));
    default:
      return resolve(msg("Skipped", { $context: "why a new file is not sent to Overleaf" }));
  }
}

function DecisionButton(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly path: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const gt = useGT();
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      disabled={props.disabled}
      aria-label={gt("{action}: {path}", { action: props.label, path: props.path })}
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
  const gt = useGT();
  const messages = useMessages();
  const toggle = (path: string, decision: OverleafFileDecision) =>
    onDecide(path, decisions.get(path) === decision ? null : decision);
  const sending = newFilesToSend(review, decisions);
  const pending = decisions.size > 0;
  return (
    <>
      {review.additions.length > 0 ? (
        <section className="flex flex-col gap-1" aria-label={gt("New files")}>
          <h3 className="flex items-baseline justify-between gap-2 px-1 text-xs font-medium text-muted-foreground">
            <T>New files</T>
            <span className="font-normal" data-overleaf-new-files>
              {pending
                ? gt(
                    "{count, plural, one {{count} will be sent at the next sync} other {{count} will be sent at the next sync}}",
                    { count: sending },
                  )
                : gt("{count, plural, one {{count} will be sent} other {{count} will be sent}}", {
                    count: sending,
                  })}
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
                    label={gt("Keep only here")}
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
                  note={skippedReasonText(addition.skippedBecause ?? "", messages)}
                  onOpenFile={props.onOpenFile}
                >
                  {UNSENDABLE_REASONS.has(addition.skippedBecause ?? "") ? null : (
                    <DecisionButton
                      label={gt("Send this file")}
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
        <section className="flex flex-col gap-1" aria-label={gt("Waiting for conflicts")}>
          <h3 className="px-1 text-xs font-medium text-muted-foreground">
            <T>Waiting for conflicts</T>
          </h3>
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
                  label={gt("Send it anyway")}
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
        <section className="flex flex-col gap-1" aria-label={gt("Kept only here")}>
          <h3 className="px-1 text-xs font-medium text-muted-foreground">
            <T>Kept only here</T>
          </h3>
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
                  label={gt("Send this file")}
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
