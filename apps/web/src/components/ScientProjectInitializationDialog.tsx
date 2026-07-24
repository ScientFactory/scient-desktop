import type { ScientProjectInitializationPreviewResult } from "@synara/contracts";
import { IconFolder, IconSparkles } from "@tabler/icons-react";

import {
  scientProjectFolderName,
  type ScientProjectInitializationDecision,
} from "../lib/scientProjectInitialization";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const OPERATION_LABELS = {
  create: "Will create",
  preserve: "Will keep",
  propose: "Suggested only",
  conflict: "Needs attention",
} as const;

const readyProjectChoiceButtonClassName =
  "flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-[var(--color-background-elevated-primary-opaque)] p-3 text-left outline-none transition-colors hover:border-border hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

function InitializationError({ error }: { readonly error: string | null }) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
    >
      {error}
    </div>
  );
}

function ReadyProjectChoice(props: {
  readonly preview: ScientProjectInitializationPreviewResult;
  readonly error: string | null;
  readonly onDecision: (decision: ScientProjectInitializationDecision) => void;
}) {
  const name = scientProjectFolderName(props.preview.root);
  const migratingPapiLabProject = props.preview.folderState === "legacy-papilab-compatible";

  return (
    <>
      <DialogHeader className="pr-10">
        <DialogTitle>Open “{name}”</DialogTitle>
        <DialogDescription>Choose how you want to use this folder in Scient.</DialogDescription>
      </DialogHeader>

      <DialogPanel className="space-y-2.5 pt-1">
        <InitializationError error={props.error} />

        <div className="grid gap-2.5 sm:grid-cols-2">
          <button
            type="button"
            disabled={!props.preview.canApply}
            onClick={() => props.onDecision("apply")}
            className={readyProjectChoiceButtonClassName}
          >
            <span className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
              <IconFolder aria-hidden className="size-5.5" stroke={1.7} />
              <IconSparkles
                aria-hidden
                className="absolute top-[55%] left-1/2 size-3 -translate-x-1/2 -translate-y-1/2"
                stroke={1.8}
              />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold leading-5 text-foreground">
                {migratingPapiLabProject ? "Migrate to Scient" : "Set up a Scient project"}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                {migratingPapiLabProject
                  ? "Keep the same project identity and add the new .scient metadata."
                  : "Add a small portable foundation for your agents."}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => props.onDecision("open-only")}
            className={readyProjectChoiceButtonClassName}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
              <IconFolder aria-hidden className="size-5.5" stroke={1.7} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold leading-5 text-foreground">
                Open an empty project
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                Write your own agent instructions later.
              </span>
            </span>
          </button>
        </div>

        {migratingPapiLabProject ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Existing legacy <code>.papilab/</code> metadata remains untouched during the supported
            rollback window.
          </p>
        ) : null}
      </DialogPanel>
    </>
  );
}

function ExceptionalProjectInitialization(props: {
  readonly preview: ScientProjectInitializationPreviewResult;
  readonly error: string | null;
  readonly onDecision: (decision: ScientProjectInitializationDecision) => void;
}) {
  const recoveryRequired = props.preview.status === "recovery-required";
  const unavailable = props.preview.folderState === "unavailable";

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {recoveryRequired
            ? "Finish setting up this Scient project?"
            : "This folder needs attention"}
        </DialogTitle>
        <DialogDescription>
          <span className="font-medium text-foreground">
            {scientProjectFolderName(props.preview.root)}
          </span>
          {recoveryRequired
            ? " contains an interrupted Scient project setup. You can safely resume it or roll back only unchanged files from that attempt."
            : unavailable
              ? " is not currently available for inspection. You can still try opening or creating it without Scient project setup."
              : " can still be opened without modification, but Scient cannot set it up safely yet."}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel className="space-y-3">
        <InitializationError error={props.error} />

        {props.preview.issues.map((issue) => (
          <div
            key={`${issue.code}:${issue.path}`}
            className="rounded-lg border border-amber-500/25 bg-amber-500/6 px-3 py-2"
          >
            <div className="font-mono text-xs text-foreground">{issue.path}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {issue.message}
            </div>
          </div>
        ))}

        {props.preview.operations.map((operation) => (
          <section
            key={`${operation.kind}:${operation.path}`}
            className="overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)]"
          >
            <div className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-foreground">{operation.path}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {operation.reason}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
                {OPERATION_LABELS[operation.kind]}
              </span>
            </div>
          </section>
        ))}
      </DialogPanel>

      <DialogFooter className="sm:flex-wrap">
        {recoveryRequired ? (
          <Button variant="destructive-outline" onClick={() => props.onDecision("rollback")}>
            Roll back attempt
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => props.onDecision("open-only")}>
          {unavailable ? "Continue without setup" : "Open without setup"}
        </Button>
        {props.preview.canRecover ? (
          <Button onClick={() => props.onDecision("recover")}>Resume and open</Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

export function ScientProjectInitializationDialog(props: {
  readonly preview: ScientProjectInitializationPreviewResult | null;
  readonly error: string | null;
  readonly onDecision: (decision: ScientProjectInitializationDecision) => void;
}) {
  const preview = props.preview;
  const ready = preview?.status === "ready";

  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) props.onDecision("cancel");
      }}
    >
      <DialogPopup surface="solid" className={ready ? "max-w-xl" : "max-w-2xl"} showCloseButton>
        {preview ? (
          ready ? (
            <ReadyProjectChoice
              key={preview.root}
              preview={preview}
              error={props.error}
              onDecision={props.onDecision}
            />
          ) : (
            <ExceptionalProjectInitialization
              preview={preview}
              error={props.error}
              onDecision={props.onDecision}
            />
          )
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
