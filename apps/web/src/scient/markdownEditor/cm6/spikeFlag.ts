const SPIKE_FLAG_KEY = "scient.cm6spike";

/**
 * Dev-only toggle for the CodeMirror live-preview spike. Enable from the
 * browser console with
 * `localStorage.setItem("scient.cm6spike", "1")` and reopen a Markdown file.
 */
export function isCm6SpikeEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SPIKE_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
