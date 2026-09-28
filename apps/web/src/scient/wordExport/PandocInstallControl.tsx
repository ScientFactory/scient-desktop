import { Button } from "../../components/ui/button";
import type { PandocToolController } from "./usePandocTool";

/** The install offer, progress, or failure, and the one button that acts on it. */
export function PandocInstallStatus(props: {
  readonly controller: PandocToolController;
  readonly showReady?: boolean;
}) {
  const { view, act } = props.controller;
  if (view.kind === "ready" && props.showReady !== true) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p
        className={
          view.kind === "failed" ? "text-destructive text-xs" : "text-muted-foreground text-xs"
        }
        role={view.kind === "failed" ? "alert" : "status"}
      >
        {view.detail}
      </p>
      {view.actionLabel !== null ? (
        <Button type="button" size="xs" variant="outline" disabled={view.busy} onClick={act}>
          {view.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
