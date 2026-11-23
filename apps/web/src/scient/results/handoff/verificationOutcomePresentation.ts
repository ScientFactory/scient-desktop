import { resultHandoffOutcome } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const labels = {
  "Outputs matched · original inputs unconfirmed": msg(
    "Outputs matched · original inputs unconfirmed",
  ),
  "Checked outputs matched · review figures and unchecked outputs": msg(
    "Checked outputs matched · review figures and unchecked outputs",
  ),
  "Checked outputs matched · figures need review": msg(
    "Checked outputs matched · figures need review",
  ),
  "Checked outputs matched · some outputs unchecked": msg(
    "Checked outputs matched · some outputs unchecked",
  ),
  Verified: msg("Verified"),
  Differs: msg("Differs"),
  Cancelled: msg("Cancelled"),
  "Rerun finished · figures need review": msg("Rerun finished · figures need review"),
  "Rerun finished · figures matched": msg("Rerun finished · figures matched"),
  "Rerun finished · no checkable outputs": msg("Rerun finished · no checkable outputs"),
  "Could not run": msg("Could not run"),
};

export function verificationOutcomeSummary(
  report: Parameters<typeof resultHandoffOutcome>[0],
  resolve: MessageResolver = m,
) {
  const { label, completed } = resultHandoffOutcome(report);
  return { label: resolve(labels[label]), completed };
}
