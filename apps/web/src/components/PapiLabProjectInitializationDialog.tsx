import type { PapiLabProjectInitializationPreviewResult } from "@synara/contracts";

import type { PapiLabProjectInitializationDecision } from "../lib/papilabProjectInitialization";

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

function folderName(root: string): string {
  return root.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? root;
}

export function PapiLabProjectInitializationDialog(props: {
  readonly preview: PapiLabProjectInitializationPreviewResult | null;
  readonly error: string | null;
  readonly onDecision: (decision: PapiLabProjectInitializationDecision) => void;
}) {
  const preview = props.preview;
  const recoveryRequired = preview?.status === "recovery-required";
  const blocked = preview?.status === "blocked";
  const unavailable = preview?.folderState === "unavailable";

  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open) props.onDecision("cancel");
      }}
    >
      <DialogPopup surface="solid" className="max-w-2xl" showCloseButton>
        <DialogHeader>
          <DialogTitle>
            {recoveryRequired
              ? "Finish setting up this PapiLab project?"
              : blocked
                ? "This folder needs attention"
                : "Set up this folder as a PapiLab project?"}
          </DialogTitle>
          <DialogDescription>
            {preview ? (
              <>
                <span className="font-medium text-foreground">{folderName(preview.root)}</span>
                {recoveryRequired
                  ? " contains an interrupted PapiLab initialization. You can safely resume it or roll back only unchanged files from that attempt."
                  : blocked
                    ? unavailable
                      ? " is not currently available for inspection. You can still try opening or creating it without PapiLab setup."
                      : " can still be opened without modification, but PapiLab cannot initialize it safely yet."
                    : " can be opened unchanged, or PapiLab can add its small portable project foundation."}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          {props.error ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
            >
              {props.error}
            </div>
          ) : null}

          {preview?.issues.map((issue) => (
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

          {preview?.operations.map((operation) => (
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
              {operation.contents !== undefined ? (
                <pre className="max-h-48 overflow-auto border-t border-[color:var(--color-border)] bg-background/60 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {operation.contents}
                </pre>
              ) : null}
            </section>
          ))}

          {!recoveryRequired && !blocked ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Existing files are never overwritten. Any suggested AGENTS.md update remains a
              proposal and is not applied during initialization.
            </p>
          ) : null}
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
          {preview?.canApply ? (
            <Button onClick={() => props.onDecision("apply")}>Initialize and open</Button>
          ) : null}
          {preview?.canRecover ? (
            <Button onClick={() => props.onDecision("recover")}>Resume and open</Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
