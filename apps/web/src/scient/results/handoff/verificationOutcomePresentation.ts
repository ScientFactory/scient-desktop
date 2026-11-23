import type { ResultHandoffVerification } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export interface VerificationOutcomeSummary {
  readonly label: string;
  readonly completed: boolean;
}

/**
 * Turns a verification report into an honest headline without changing the
 * underlying comparison policy or `verification.json` status contract.
 */
export function verificationOutcomeSummary(
  report: Pick<
    ResultHandoffVerification,
    "status" | "rerunCompleted" | "message" | "environment" | "outputs"
  >,
  resolve: MessageResolver = m,
): VerificationOutcomeSummary {
  const hasReviewOutputs = report.outputs.some(
    (output) => output.status === "differs" || output.status === "missing",
  );
  const hasUncheckedOutputs = report.outputs.some((output) => output.status === "unchecked");
  const hasMatchedOutputs = report.outputs.some((output) => output.status === "matched");

  if (report.status === "verified") {
    if (hasReviewOutputs && hasUncheckedOutputs) {
      return {
        label: resolve(msg("Checked outputs matched · review figures and unchecked outputs")),
        completed: true,
      };
    }
    if (hasReviewOutputs) {
      return {
        label: resolve(msg("Checked outputs matched · figures need review")),
        completed: true,
      };
    }
    if (hasUncheckedOutputs || report.message !== undefined) {
      return {
        label: resolve(msg("Checked outputs matched · some outputs unchecked")),
        completed: true,
      };
    }
    return { label: resolve(msg("Verified")), completed: true };
  }
  if (report.status === "differs") {
    return { label: resolve(msg("Differs")), completed: false };
  }
  if (report.status === "cancelled") {
    return { label: resolve(msg("Cancelled")), completed: false };
  }
  const completedWithoutDeciding =
    report.rerunCompleted ??
    // Older reports only record the completion in their output checks and message.
    (report.environment !== null &&
      (hasReviewOutputs ||
        hasMatchedOutputs ||
        report.message?.startsWith("The rerun finished") === true));
  if (completedWithoutDeciding) {
    if (hasReviewOutputs) {
      return { label: resolve(msg("Rerun finished · figures need review")), completed: true };
    }
    if (hasMatchedOutputs) {
      return { label: resolve(msg("Rerun finished · figures matched")), completed: true };
    }
    return { label: resolve(msg("Rerun finished · no checkable outputs")), completed: true };
  }
  return { label: resolve(msg("Could not run")), completed: false };
}
