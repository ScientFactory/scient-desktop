import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ComputeResultCause, ComputeResultParameter } from "@t3tools/contracts";
import type { ResultReferenceState } from "@t3tools/shared/computeResults";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const CAUSE_TEXT: Record<ComputeResultCause["kind"], string> = {
  "script-changed": msg("{path} changed since this run"),
  "script-missing": msg("{path} is missing"),
  "script-unconfirmed": msg("Notebook source unconfirmed"),
  "input-changed": msg("{path} changed since this run"),
  "input-missing": msg("{path} is missing"),
  "input-changed-during-run": msg("{path} changed while the script was running"),
  "lockfile-changed": msg("Environment may differ ({path} changed since this run)"),
};

export const resultCauseText = (cause: ComputeResultCause, resolve: MessageResolver = m) =>
  resolve(CAUSE_TEXT[cause.kind], { path: cause.path });

/** `msg()` strings: resolve them with `useMessages()` where they show. */
export const RESULT_STATE_LABEL: Record<ResultReferenceState, string> = {
  current: msg("Up to date"),
  incomplete: msg("Freshness partly unknown"),
  newer: msg("New run available"),
  stale: msg("Out of date"),
  edited: msg("Edited in the document"),
  missing: msg("Not in this run"),
  unrecorded: msg("No run record on this computer"),
};

export function resultErrorMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function resultTime(iso: string, timeStyle: "short" | "medium" = "short") {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle });
}

export function resultParameters(parameters: ReadonlyArray<ComputeResultParameter> | undefined) {
  return parameters?.map(({ name, value }) => `${name} = ${value}`).join(", ") ?? "";
}
