export const PACKAGED_MAIN_WINDOW_HIDDEN_MARKER = "packaged main window hidden";
export const PACKAGED_MAIN_WINDOW_CLOSED_MARKER = "packaged main window closed";

interface PackagedStartupWindowLifecycleSource {
  on(event: "hide" | "closed", listener: () => void): unknown;
}

export function attachPackagedStartupWindowLifecycleProof(input: {
  readonly window: PackagedStartupWindowLifecycleSource;
  readonly enabled: boolean;
  readonly writeFailureMarker: (marker: string) => void;
}): void {
  if (!input.enabled) return;
  input.window.on("hide", () => {
    input.writeFailureMarker(PACKAGED_MAIN_WINDOW_HIDDEN_MARKER);
  });
  input.window.on("closed", () => {
    input.writeFailureMarker(PACKAGED_MAIN_WINDOW_CLOSED_MARKER);
  });
}
