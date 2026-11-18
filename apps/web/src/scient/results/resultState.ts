import type { ComputeResultCause } from "@t3tools/contracts";
import type { ResultReferenceState } from "@t3tools/shared/computeResults";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const CAUSE_TEXT: Record<ComputeResultCause["kind"], string> = {
  "script-changed": msg("{path} changed since this run"),
  "script-missing": msg("{path} is missing"),
  "input-changed": msg("{path} changed since this run"),
  "input-missing": msg("{path} is missing"),
  "input-changed-during-run": msg("{path} changed while the script was running"),
};

export const resultCauseText = (cause: ComputeResultCause, resolve: MessageResolver = m) =>
  resolve(CAUSE_TEXT[cause.kind], { path: cause.path });

/** `msg()` strings: resolve them with `useMessages()` where they show. */
export const RESULT_STATE_LABEL: Record<ResultReferenceState, string> = {
  current: msg("Up to date"),
  newer: msg("New run available"),
  stale: msg("Out of date"),
  edited: msg("Edited in the document"),
  missing: msg("Not in this run"),
  unrecorded: msg("No run record on this computer"),
};
