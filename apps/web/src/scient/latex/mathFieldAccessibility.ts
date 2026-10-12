import type { MathfieldElement } from "mathlive";

/** Value changes do not refresh MathLive's focus-generated spoken label. */
export function refreshMathFieldAccessibleLabel(math: MathfieldElement): void {
  const input = math.shadowRoot?.querySelector(".ML__keyboard-sink");
  if (!input) return;
  // Read the existing model so document macros and live drafts stay accurate.
  // Updating only its label leaves focus, selection, history and input events alone.
  const spoken = math.getValue("spoken-text");
  if (input.getAttribute("aria-label") !== spoken) input.setAttribute("aria-label", spoken);
}
