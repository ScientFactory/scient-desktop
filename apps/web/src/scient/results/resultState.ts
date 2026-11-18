import type { ComputeResultCause, ComputeResultResolution } from "@t3tools/contracts";

import type { EditorResultReference, ResultMarkState } from "../markdownEditor/prosemirror/results";

/** The one state a result shows, most important first: what the reader must act on. */
export function resultMarkState(
  reference: EditorResultReference,
  resolution: ComputeResultResolution | undefined,
): ResultMarkState {
  if (resolution === undefined || resolution._tag === "unrecorded") return "unrecorded";
  const present = reference.kind === "value" ? resolution.value !== null : resolution.figure;
  if (!present) return "missing";
  if (resolution.summary.causes.length > 0) return "stale";
  if (reference.kind === "value" && reference.text !== resolution.value) return "edited";
  if (resultHasNewer(reference, resolution)) return "newer";
  return "current";
}

export function resultHasNewer(
  reference: EditorResultReference,
  resolution: Extract<ComputeResultResolution, { _tag: "resolved" }>,
): boolean {
  const newer = resolution.newer;
  if (newer === null) return false;
  return reference.kind === "figure" ? newer.figure : newer.value !== null;
}

const CAUSE_TEXT: Record<ComputeResultCause["kind"], string> = {
  "script-changed": "changed since this run",
  "script-missing": "is missing",
  "input-changed": "changed since this run",
  "input-missing": "is missing",
  "input-changed-during-run": "changed while the script was running",
};

export const resultCauseText = (cause: ComputeResultCause) =>
  `${cause.path} ${CAUSE_TEXT[cause.kind]}`;

export const RESULT_STATE_LABEL: Record<ResultMarkState, string> = {
  current: "Up to date",
  newer: "New run available",
  stale: "Out of date",
  edited: "Edited in the document",
  missing: "Not in this run",
  unrecorded: "No run record on this computer",
};
