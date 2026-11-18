import type { ComputeResultCause } from "@t3tools/contracts";
import type { ResultReferenceState } from "@t3tools/shared/computeResults";

const CAUSE_TEXT: Record<ComputeResultCause["kind"], string> = {
  "script-changed": "changed since this run",
  "script-missing": "is missing",
  "input-changed": "changed since this run",
  "input-missing": "is missing",
  "input-changed-during-run": "changed while the script was running",
};

export const resultCauseText = (cause: ComputeResultCause) =>
  `${cause.path} ${CAUSE_TEXT[cause.kind]}`;

export const RESULT_STATE_LABEL: Record<ResultReferenceState, string> = {
  current: "Up to date",
  newer: "New run available",
  stale: "Out of date",
  edited: "Edited in the document",
  missing: "Not in this run",
  unrecorded: "No run record on this computer",
};
