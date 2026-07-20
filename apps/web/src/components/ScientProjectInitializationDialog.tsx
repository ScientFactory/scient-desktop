import type { ScientProjectInitializationPreviewResult } from "@synara/contracts";
import { IconFolder, IconInfoCircle, IconSparkles } from "@tabler/icons-react";
import { useState } from "react";

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

const SCIENT_PROJECT_FILES = [
  {
    path: "PROJECT.md",
    description: "The project's purpose and objective.",
  },
  {
    path: "AGENTS.md",
    description: "Shared guidance for agents working in the project.",
  },
  {
    path: ".scient/project.json",
    description: "A portable Scient project identity.",
  },
  {
    path: ".scient/skills.lock.json",
    description: "Exact identities of the built-in skills selected for this project.",
  },
] as const;

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
  const [showInformation, setShowInformation] = useState(false);
  const name = scientProjectFolderName(props.preview.root);
  const migratingPapiLabProject = props.preview.folderState === "legacy-papilab-compatible";

  if (showInformation) {
    return (
      <>
        <DialogHeader className="pr-10">
          <DialogTitle className="text-xl">Set up “{name}”</DialogTitle>
          <DialogDescription>
            A Scient project adds a small portable foundation that helps agents understand your
            project and records any built-in skills you explicitly select. Setup does not run a
            skill. You can update or delete these files whenever you want.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          <div className="divide-y divide-[color:var(--color-border)] overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)]">
            {SCIENT_PROJECT_FILES.map((file) => (
              <div key={file.path} className="px-3.5 py-3">
                <div className="font-mono text-xs font-medium text-foreground">{file.path}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {file.description}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Existing files are never overwritten.
          </p>
          {props.preview.skills.length > 0 ? (
            <section className="space-y-2">
              <div>
                <div className="text-sm font-medium text-foreground">Built-in skills</div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Select the procedures this project should activate. Activation does not execute
                  them.
                </p>
              </div>
              <div className="divide-y divide-[color:var(--color-border)] overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)]">
                {props.preview.skills.map((skill) => (
                  <label key={`${skill.id}@${skill.version}`} className="flex gap-3 px-3.5 py-3">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-[var(--color-primary)]"
                      checked={skill.selected}
                      onChange={(event) =>
                        props.onDecision({
                          kind: "refresh-skills",
                          skillIds: props.preview.skills.flatMap((candidate) =>
                            candidate.id === skill.id
                              ? event.currentTarget.checked
                                ? [candidate.id]
                                : []
                              : candidate.selected
                                ? [candidate.id]
                                : [],
                          ),
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                        {skill.displayName}
                        {skill.readiness === "latent" ? (
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
                            Needs foundations
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {skill.description}
                      </span>
                      {skill.readiness === "latent" && skill.prerequisites.length > 0 ? (
                        <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                          Needs: {skill.prerequisites.join("; ")}
                        </span>
                      ) : null}
                      <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground">
                        {skill.capabilities.network ? "Network" : "No network"} ·{" "}
                        {skill.capabilities.codeExecution ? "Code execution" : "No code execution"}{" "}
                        ·{" "}
                        {skill.capabilities.projectWrites === "proposal-only"
                          ? "Proposal-only changes"
                          : "No project writes"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowInformation(false)}>
            Back
          </Button>
          <Button onClick={() => props.onDecision("apply")}>
            {migratingPapiLabProject ? "Migrate to Scient" : "Set up a Scient project"}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader className="pr-10">
        <DialogTitle className="text-xl sm:text-2xl">Open “{name}”</DialogTitle>
        <DialogDescription>Choose how you want to use this folder in Scient.</DialogDescription>
      </DialogHeader>

      <DialogPanel className="space-y-3 pt-1">
        <InitializationError error={props.error} />

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            disabled={!props.preview.canApply}
            onClick={() => setShowInformation(true)}
            className="group flex min-h-32 cursor-pointer items-center gap-3.5 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-4 text-left outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="relative flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
              <IconFolder aria-hidden className="size-7" stroke={1.7} />
              <IconSparkles
                aria-hidden
                className="absolute top-[55%] left-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2"
                stroke={1.8}
              />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">
                {migratingPapiLabProject ? "Migrate to Scient" : "Set up a Scient project"}
              </span>
              <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
                {migratingPapiLabProject
                  ? "Keep the same project identity and add the new .scient metadata."
                  : "Add a small portable foundation for your agents."}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => props.onDecision("open-only")}
            className="group flex min-h-32 cursor-pointer items-center gap-3.5 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-4 text-left outline-none transition-colors hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
              <IconFolder aria-hidden className="size-7" stroke={1.7} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">
                Open an empty project
              </span>
              <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
                Write your own agent instructions later.
              </span>
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowInformation(true)}
          className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring/60"
        >
          <IconInfoCircle aria-hidden className="size-4" stroke={1.7} />
          What is a Scient project?
        </button>
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
      <DialogPopup surface="solid" className="max-w-2xl sm:translate-y-[10vh]" showCloseButton>
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
