import { useState } from "react";

import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

import {
  compareRecoveredSource,
  isRecoveryUnstored,
  type LatexVisualRecovery,
} from "./visualRecovery";
import { T, useGT, Var } from "gt-react";

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
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [notApplied, setNotApplied] = useState(false);
  const differences =
    open && recovery.source !== null ? compareRecoveredSource(currentSource, recovery.source) : [];
  const convertible = recovery.source !== null;
  // Said on the line itself, for as long as the offer lasts: closing loses it.
  const unstored = isRecoveryUnstored(recovery);
  // The footer has no other place that says why typing does nothing.
  const message = convertible
    ? unstored
      ? gt("Unsaved changes · keep this document open")
      : recovery.parked
        ? gt("Unsaved changes")
        : gt("Unsaved changes · editing paused")
    : unstored
      ? gt("Unsaved text · keep this document open")
      : recovery.parked
        ? gt("Unsaved text")
        : gt("Unsaved text · editing paused");
  const detail = unstored
    ? gt(
        "This copy could not be stored on this device. It is lost if the document is closed before you use or discard it.",
      )
    : !convertible
      ? gt(
          "This writing can't be placed in the file automatically. View it and copy what you need.",
        )
      : !applicable
        ? gt("This document has several files. Compare and copy what you need.")
        : recovery.parked
          ? gt("Found from an earlier session. Compare to use or discard them.")
          : gt("Found from an earlier session. Editing resumes once you use or discard them.");
  const shown = notApplied
    ? gt("{status} · not applied, compare again", { status: message })
    : message;
  const toggle = () => setOpen((value) => !value);
  return (
    <div className="scient-latex-visual-recovery" role="status">
      <ScientTooltip content={detail}>
        <span className="scient-latex-visual-recovery-message">{shown}</span>
      </ScientTooltip>
      <button
        type="button"
        data-wide=""
        // The button keeps the width of its longer label, so Discard never moves.
        data-closed-label={convertible ? gt("Compare") : gt("View", { $context: "verb" })}
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? gt("Hide") : convertible ? gt("Compare") : gt("View", { $context: "verb" })}
      </button>
      <button type="button" data-wide="" onClick={onDiscard}>
        <T>Discard</T>
      </button>
      {/* In a narrow footer the line is one action, and Discard moves into the comparison. */}
      <ScientTooltip content={detail}>
        <button type="button" data-compact="" aria-expanded={open} onClick={toggle}>
          {/* Whole words: where there is no room, later words drop out of sight. */}
          {shown.split(" ").map((word, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- words of one short label, in order.
            <span key={index}>{index === 0 ? word : ` ${word}`}</span>
          ))}
        </button>
      </ScientTooltip>
      {open ? (
        <div className="scient-latex-visual-recovery-panel">
          {!convertible ? (
            <pre aria-label={gt("Recovered writing")}>{recovery.text}</pre>
          ) : differences.length === 0 ? (
            <p>
              <T>No differences from the file.</T>
            </p>
          ) : (
            <ol aria-label={gt("Differences between the file and the recovered changes")}>
              {differences.map((difference) => (
                <li key={difference.line}>
                  <span className="scient-latex-visual-recovery-line">
                    <T>
                      Line <Var>{difference.line}</Var>
                    </T>
                  </span>
                  {difference.current.length > 0 ? (
                    <pre data-side="current">
                      <span className="sr-only">
                        <T>File:</T>{" "}
                      </span>
                      {displayLines(difference.current)}
                    </pre>
                  ) : null}
                  {difference.recovered.length > 0 ? (
                    <pre data-side="recovered">
                      <span className="sr-only">
                        <T>Recovered:</T>{" "}
                      </span>
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
                <span data-side="current">
                  <T context="file version in a comparison">File</T>
                </span>
                <span data-side="recovered">
                  <T context="recovered version in a comparison">Recovered</T>
                </span>
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(recovery.text).catch(() => {});
              }}
            >
              <T>Copy</T>
            </button>
            <button type="button" data-compact="" onClick={onDiscard}>
              <T>Discard</T>
            </button>
            {applicable && differences.length > 0 ? (
              <button
                type="button"
                data-primary=""
                disabled={disabled}
                onClick={() => setNotApplied(!onApply(currentSource))}
              >
                <T>Use recovered</T>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
