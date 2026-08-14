/**
 * The card a document shows instead of a PDF when this computer has no LaTeX
 * engine: an offer to install the one Scient pins, the progress of that
 * install, or — where Scient has nothing to offer — what to install by hand.
 */
import { Download, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import { useMemo } from "react";

import { latexSetupCardModel } from "./latexToolchainSetupModel";
import type { LatexBuildStatus } from "./scientLatexSurfaceModel";

export function LatexToolchainSetupCard(props: {
  readonly status: LatexBuildStatus;
  readonly onInstall: () => void;
}) {
  const { canInstallManaged, managedInstall, installRequesting } = props.status;
  const model = useMemo(
    () =>
      latexSetupCardModel({
        canInstallManaged,
        install: managedInstall,
        requesting: installRequesting,
      }),
    [canInstallManaged, installRequesting, managedInstall],
  );

  return (
    <div className="scient-latex-placeholder" aria-live="polite">
      {model.busy ? (
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      ) : model.kind === "failed" ? (
        <TriangleAlert className="size-5 text-destructive" aria-hidden="true" />
      ) : model.kind === "offer" ? (
        <Download className="size-5 text-muted-foreground" aria-hidden="true" />
      ) : null}
      <h2>{model.title}</h2>
      <p role={model.kind === "failed" ? "alert" : undefined}>{model.body}</p>
      {model.progressPercent === null ? null : (
        <div
          className="scient-latex-progress"
          role="progressbar"
          aria-label="TinyTeX installation progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={model.progressPercent}
        >
          <div
            className="scient-latex-progress-fill"
            style={{ width: `${model.progressPercent}%` }}
          />
        </div>
      )}
      {model.actionLabel === null ? null : (
        <button
          type="button"
          className="scient-latex-setup-action"
          disabled={model.busy}
          onClick={props.onInstall}
        >
          {model.kind === "failed" ? <RotateCw className="size-3.5" aria-hidden="true" /> : null}
          {model.actionLabel}
        </button>
      )}
    </div>
  );
}
