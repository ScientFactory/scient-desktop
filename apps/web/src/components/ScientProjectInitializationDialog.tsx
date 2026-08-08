import type { ScientProjectInspection } from "@t3tools/contracts";
import { FolderIcon, SparklesIcon } from "lucide-react";

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

const choiceClassName =
  "flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-[var(--color-background-elevated-primary-opaque)] p-3 text-left outline-none transition-colors hover:border-border hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

export function ScientProjectInitializationDialog(props: {
  readonly inspection: ScientProjectInspection | null;
  readonly onDecision: (decision: ScientProjectInitializationDecision) => void;
}) {
  const inspection = props.inspection;
  const ready = inspection?.state === "ordinary" || inspection?.state === "recoverable";
  const recovering = inspection?.state === "recoverable";

  return (
    <Dialog
      open={inspection !== null}
      onOpenChange={(open) => {
        if (!open) props.onDecision("cancel");
      }}
    >
      <DialogPopup className={ready ? "max-w-xl" : "max-w-lg"} showCloseButton>
        {inspection ? (
          <>
            <DialogHeader className="pr-10">
              <DialogTitle>
                {recovering
                  ? "Finish setting up this Scient project?"
                  : inspection.state === "conflicting"
                    ? "This folder needs attention"
                    : `Open “${scientProjectFolderName(inspection.root)}”`}
              </DialogTitle>
              <DialogDescription>
                {recovering
                  ? "A previous setup stopped before it finished. Scient can safely continue it without replacing your files."
                  : inspection.state === "conflicting"
                    ? "Scient will not replace or repair these files automatically. You can still open the folder normally."
                    : "Choose whether to add Scient's small, portable project foundation."}
              </DialogDescription>
            </DialogHeader>

            <DialogPanel className="space-y-3 pt-1">
              {inspection.state === "conflicting" ? (
                inspection.issues.map((issue) => (
                  <div
                    key={`${issue.path}:${issue.message}`}
                    className="rounded-lg border border-amber-500/25 bg-amber-500/6 px-3 py-2"
                  >
                    <div className="font-mono text-xs text-foreground">{issue.path}</div>
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {issue.message}
                    </div>
                  </div>
                ))
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={!inspection.canInitialize}
                    onClick={() => props.onDecision("initialize")}
                    className={choiceClassName}
                  >
                    <span className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FolderIcon aria-hidden className="size-5.5" strokeWidth={1.7} />
                      <SparklesIcon
                        aria-hidden
                        className="absolute top-[58%] left-[58%] size-3"
                        strokeWidth={1.8}
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold leading-5 text-foreground">
                        {recovering ? "Finish setup" : "Set up a Scient project"}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {recovering
                          ? "Continue only the unchanged setup files."
                          : "Create PROJECT.md, AGENTS.md, and a durable local identity."}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => props.onDecision("open-only")}
                    className={choiceClassName}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
                      <FolderIcon aria-hidden className="size-5.5" strokeWidth={1.7} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold leading-5 text-foreground">
                        Open without setup
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        Keep using the folder as an ordinary project.
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </DialogPanel>

            {inspection.state === "conflicting" ? (
              <DialogFooter>
                <Button onClick={() => props.onDecision("open-only")}>Open without setup</Button>
              </DialogFooter>
            ) : null}
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
