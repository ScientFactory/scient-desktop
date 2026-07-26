export const PACKAGED_STARTUP_RENDERER_READY_DATASET_KEY = "scientRendererReady";

type RendererReadinessElement = Pick<HTMLElement, "dataset">;

export async function markPackagedStartupRendererReadyAfterShellHydration(input: {
  readonly hydrateShell: () => Promise<void>;
  readonly element?: RendererReadinessElement;
  readonly shouldMark?: () => boolean;
}): Promise<() => void> {
  await input.hydrateShell();
  if (input.shouldMark && !input.shouldMark()) return () => undefined;
  const element = input.element ?? document.documentElement;
  element.dataset[PACKAGED_STARTUP_RENDERER_READY_DATASET_KEY] = "true";
  return () => {
    delete element.dataset[PACKAGED_STARTUP_RENDERER_READY_DATASET_KEY];
  };
}
