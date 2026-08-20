import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  Loader2,
  PanelRight,
  Play,
  Power,
  Square,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { COMPUTE_FIXTURE_FIGURE_DATA_URL } from "./computeFigureFixture";
import type {
  ComputeEditorAction,
  ComputeEditorContext,
  ComputeExperienceFixture,
} from "./computeExperienceFixtures";

/**
 * The editor compute strip, and the latest-execution dock above it.
 *
 * The proposal asks for a slim strip at the bottom of a supported source editor
 * that expands into a dock showing the latest execution, so the scientist keeps
 * editing while code runs. I think the strip is clearly right and the dock is
 * right only if it is kept honest about its job, so this implementation differs
 * from the proposal in two ways, both marked REVISION.
 */

const ACTION_LABEL: Record<ComputeEditorAction, string> = {
  "run-selection": "Run selection",
  "run-cell": "Run cell",
  "run-file": "Run file",
};

function actionDetail(editor: ComputeEditorContext, action: ComputeEditorAction): string | null {
  switch (action) {
    case "run-selection":
      return editor.selectionLabel;
    case "run-cell":
      return editor.caretCellLabel;
    case "run-file":
      return editor.bufferState === "dirty" ? "current buffer, unsaved" : "current buffer";
  }
}

/** The whole surface when the capability is off: one line, one verb, no alarm. */
function OffStrip() {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
      <Power className="size-3 shrink-0" aria-hidden="true" />
      <span>Python compute is off</span>
      <button
        className="font-medium text-foreground underline-offset-2 hover:underline"
        type="button"
      >
        Enable
      </button>
      {/*
        The proposal's copy stops here, and I would keep it that way. The
        temptation is to explain what enabling does; the strip is the wrong
        density for that sentence, and the settings page it links to already
        says "Scient will not download or modify a runtime."
      */}
    </div>
  );
}

function LatestRow({
  latest,
  compact,
}: {
  readonly latest: NonNullable<ComputeEditorContext["latest"]>;
  readonly compact: boolean;
}) {
  const icon =
    latest.status === "running" || latest.status === "queued" ? (
      <Loader2 className="size-3 shrink-0 animate-spin text-sky-500" aria-hidden="true" />
    ) : latest.status === "failed" ? (
      <CircleX className="size-3 shrink-0 text-red-500" aria-hidden="true" />
    ) : (
      <CircleCheck className="size-3 shrink-0 text-emerald-500" aria-hidden="true" />
    );

  return (
    <div className="flex min-w-0 items-center gap-2">
      {icon}
      <span
        className={`min-w-0 truncate text-[11px] ${
          latest.status === "failed"
            ? "font-medium text-red-600 dark:text-red-400"
            : "text-foreground"
        }`}
      >
        {latest.detail}
      </span>
      {compact ? null : (
        <>
          <span className="shrink-0 text-[11px] text-muted-foreground">·</span>
          <button
            className="shrink-0 truncate text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            type="button"
          >
            {latest.sourceLabel}
          </button>
          {/*
            The proposal appends "· Unsaved buffer" as a third neutral segment.
            At 11px, in a row of grey text, that is the segment a reader skips --
            and it is the one that changes what the record means, because the
            file on disk no longer matches what ran. It gets its own colour.
          */}
          {latest.bufferState === "dirty" ? (
            <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              unsaved buffer
            </span>
          ) : null}
        </>
      )}
      {latest.elapsedLabel === null ? null : (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {latest.elapsedLabel}
        </span>
      )}
    </div>
  );
}

export function ScientComputeEditorDock({
  fixture,
  panelVisible,
}: {
  readonly fixture: ComputeExperienceFixture;
  readonly panelVisible: boolean;
}) {
  const { editor, session, enablement } = fixture;
  const [expanded, setExpanded] = useState(false);

  if (enablement === "off") return <OffStrip />;

  const running = editor.latest?.status === "running" || editor.latest?.status === "queued";
  const sessionLabel =
    session === null
      ? "No session"
      : session.status === "ready"
        ? session.activity === "busy"
          ? "Session busy"
          : "Session ready"
        : session.status === "lost" || session.status === "failed"
          ? "Session lost"
          : session.status;

  /*
   * REVISION 1 — the dock does not expand while the Compute panel is open.
   *
   * The proposal has three places that can show an execution: the strip, the
   * dock, and the panel. Two of them are visible at once in the default desktop
   * layout, and they are showing the same execution with different chrome, one
   * of them in the same eyeline as the other. The panel already scrolls, already
   * holds the console, already holds session controls. When it is open the dock
   * is a second answer to a question that has one.
   *
   * So the dock earns its place exactly when the panel is closed -- which is
   * most of the time, because the panel competes with the file tree and the
   * chat for that slot. It is not a smaller panel; it is what you get instead
   * of one.
   */
  const dockAvailable = editor.latest !== null && !panelVisible;
  const dockOpen = dockAvailable && expanded;

  return (
    <div className="border-t border-border bg-muted/20">
      {dockOpen && editor.latest !== null ? (
        <div className="border-b border-border/60 px-3 py-2">
          <LatestRow compact={false} latest={editor.latest} />

          {/*
            REVISION 2 — the dock shows the shape of the result, not the result.
            One figure thumbnail, one error headline, one output line. The
            proposal's "latest output, error, or figure thumbnail" slides easily
            into a full renderer below the editor, and then a 400-line traceback
            or 40 lines of stdout pushes the source off the screen -- which is
            the exact thing the dock exists to prevent. Anything longer than a
            glance is a reason to open the panel.
          */}
          {editor.latest.figure ? (
            <button
              className="mt-2 block overflow-hidden rounded border border-border transition hover:border-primary/50"
              type="button"
            >
              <img
                alt="Latest figure"
                className="h-16 w-auto"
                src={COMPUTE_FIXTURE_FIGURE_DATA_URL}
              />
            </button>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              type="button"
            >
              <PanelRight className="size-3" aria-hidden="true" />
              Open full history
            </button>
            <span className="text-[10px] text-muted-foreground">
              session output · not yet a project result
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {editor.languageLabel} · {sessionLabel}
        </span>

        {dockOpen || editor.latest === null ? null : (
          <div className="min-w-0 flex-1">
            <LatestRow compact={panelVisible} latest={editor.latest} />
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {dockAvailable ? (
            <Button
              className="h-7 px-2 text-[11px]"
              onClick={() => setExpanded((value) => !value)}
              size="sm"
              variant="ghost"
            >
              {dockOpen ? (
                <ChevronDown className="size-3" aria-hidden="true" />
              ) : (
                <ChevronUp className="size-3" aria-hidden="true" />
              )}
              {dockOpen ? "Collapse" : "Latest"}
            </Button>
          ) : null}

          {/*
            Interrupt replaces Run while something is running, here for the same
            reason it does in the panel: Run is the reflex, and queueing work
            behind a cell you are trying to stop is the one outcome nobody wants.
          */}
          {running ? (
            <Button className="h-7 px-2 text-[11px]" size="sm" variant="secondary">
              <Square className="size-3" aria-hidden="true" />
              Interrupt
            </Button>
          ) : (
            <>
              <Button
                className="h-7 px-2 text-[11px]"
                disabled={session === null || session.status !== "ready"}
                size="sm"
              >
                <Play className="size-3" aria-hidden="true" />
                {ACTION_LABEL[editor.primaryAction]}
              </Button>
              <details className="relative">
                <summary className="flex h-7 cursor-pointer list-none items-center rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted">
                  <ChevronUp className="size-3" aria-hidden="true" />
                </summary>
                <div className="absolute right-0 bottom-[calc(100%+0.25rem)] z-10 w-56 rounded-md border border-border bg-background p-1 shadow-lg">
                  {editor.availableActions.map((action) => {
                    const detail = actionDetail(editor, action);
                    return (
                      <button
                        className={`flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-muted ${
                          action === editor.primaryAction ? "bg-muted/60" : ""
                        }`}
                        key={action}
                        type="button"
                      >
                        <span className="text-[11px] font-medium">{ACTION_LABEL[action]}</span>
                        {detail === null ? null : (
                          <span className="text-[10px] text-muted-foreground">{detail}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </details>
            </>
          )}
        </div>
      </div>

      {/*
        The one thing the strip says about the buffer even when nothing has run.
        Run file uses what is on screen; a user who believes it runs the saved
        file will misread every result until they notice.
      */}
      {editor.bufferState === "dirty" && editor.latest === null ? (
        <p className="px-3 pb-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          Unsaved changes will be run as-is. Scient does not save first.
        </p>
      ) : null}
    </div>
  );
}
