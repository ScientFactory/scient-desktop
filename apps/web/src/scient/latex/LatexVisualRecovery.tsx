import { useMemo, useState } from "react";

import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

import {
  compareRecoveredSource,
  isRecoveryUnstored,
  type LatexVisualRecovery,
} from "./visualRecovery";

const displayLines = (lines: readonly string[]) =>
  lines.map((line) => line.replace(/\r$/u, "") || " ").join("\n");

interface Props {
  readonly recovery: LatexVisualRecovery;
  /** The file as the editor currently shows it. */
  readonly currentSource: string;
  /** False for a document assembled from several files: it cannot be replaced in one save. */
  readonly applicable: boolean;
  readonly disabled: boolean;
  /** Replace the compared file with the recovered work. False when nothing was replaced. */
  readonly onApply: (comparedSource: string) => boolean;
  readonly onDiscard: () => void;
}

/**
 * Unsaved work found when the document opened, shown as one line in the
 * editor's footer. The file changes only after the user has opened the
 * comparison and chosen the recovered version there.
 */
export function LatexVisualRecoveryBar({
  recovery,
  currentSource,
  applicable,
  disabled,
  onApply,
  onDiscard,
}: Props) {
  const [open, setOpen] = useState(false);
  const [notApplied, setNotApplied] = useState(false);
  const differences = useMemo(
    () =>
      open && recovery.source !== null
        ? compareRecoveredSource(currentSource, recovery.source)
        : [],
    [open, currentSource, recovery.source],
  );
  const convertible = recovery.source !== null;
  // Said on the line itself, for as long as the offer lasts: closing loses it.
  const unstored = isRecoveryUnstored(recovery);
  const message = `${convertible ? "Unsaved changes" : "Unsaved text"}${unstored ? " · keep this document open" : ""}`;
  const detail = unstored
    ? "This copy could not be stored on this device. It is lost if the document is closed before you use or discard it."
    : !convertible
      ? "This writing can't be placed in the file automatically. View it and copy what you need."
      : !applicable
        ? "This document has several files. Compare and copy what you need."
        : recovery.parked
          ? "Found from an earlier session. Compare to use or discard them."
          : "Found from an earlier session. Editing resumes once you use or discard them.";
  return (
    <div className="scient-latex-visual-recovery" role="status">
      <ScientTooltip content={detail}>
        <span className="scient-latex-visual-recovery-message">
          {notApplied ? `${message} · not applied, compare again` : message}
        </span>
      </ScientTooltip>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide" : convertible ? "Compare" : "View"}
      </button>
      <button type="button" onClick={onDiscard}>
        Discard
      </button>
      {open ? (
        <div className="scient-latex-visual-recovery-panel">
          {!convertible ? (
            <pre aria-label="Recovered writing">{recovery.text}</pre>
          ) : differences.length === 0 ? (
            <p>No differences from the file.</p>
          ) : (
            <ol aria-label="Differences between the file and the recovered changes">
              {differences.map((difference) => (
                <li key={difference.line}>
                  <span className="scient-latex-visual-recovery-line">Line {difference.line}</span>
                  {difference.current.length > 0 ? (
                    <pre data-side="current">
                      <span className="sr-only">File: </span>
                      {displayLines(difference.current)}
                    </pre>
                  ) : null}
                  {difference.recovered.length > 0 ? (
                    <pre data-side="recovered">
                      <span className="sr-only">Recovered: </span>
                      {displayLines(difference.recovered)}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          <div className="scient-latex-visual-recovery-actions">
            {differences.length > 0 ? (
              <span className="scient-latex-visual-recovery-legend" aria-hidden="true">
                <span data-side="current">File</span>
                <span data-side="recovered">Recovered</span>
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(recovery.text).catch(() => {});
              }}
            >
              Copy
            </button>
            {applicable && differences.length > 0 ? (
              <button
                type="button"
                data-primary=""
                disabled={disabled}
                onClick={() => setNotApplied(!onApply(currentSource))}
              >
                Use recovered
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
