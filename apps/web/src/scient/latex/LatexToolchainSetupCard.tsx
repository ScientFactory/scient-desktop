/**
 * The card a document shows instead of a PDF when this computer has no LaTeX
 * engine: an offer to install the one Scient pins, the progress of that
 * install, or — where Scient has nothing to offer — what to install by hand.
 */
import type { ScientLatexManagedInstallState } from "@t3tools/contracts";
import { Download, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import { useMemo } from "react";

import { latexSetupCardModel } from "./latexToolchainSetupModel";

export function LatexToolchainSetupCard(props: {
  readonly canInstallManaged: boolean;
  readonly managedInstall: ScientLatexManagedInstallState | null;
  readonly installRequesting: boolean;
  /** The probe still finds no engine, which is why this card is on screen. */
  readonly toolchainMissing: boolean;
  readonly onInstall: () => void;
}) {
  const { canInstallManaged, managedInstall, installRequesting, toolchainMissing } = props;
  const model = useMemo(
    () =>
      latexSetupCardModel({
        canInstallManaged,
        install: managedInstall,
        requesting: installRequesting,
        toolchainMissing,
      }),
    [canInstallManaged, installRequesting, managedInstall, toolchainMissing],
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
      {model.warning === null ? null : (
        <p className="scient-latex-placeholder-note">{model.warning}</p>
      )}
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
