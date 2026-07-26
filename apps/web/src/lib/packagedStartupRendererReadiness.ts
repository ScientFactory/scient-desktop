export const PACKAGED_STARTUP_RENDERER_READY_DATASET_KEY = "scientRendererReady";

type RendererReadinessElement = Pick<HTMLElement, "dataset">;

export interface PackagedStartupRendererReadinessState {
  clear: (() => void) | null;
  inFlight: Promise<() => void> | null;
}

export function createPackagedStartupRendererReadinessState(): PackagedStartupRendererReadinessState {
  return { clear: null, inFlight: null };
}

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

export async function hydrateShellForPackagedStartupRenderer(input: {
  readonly hydrateShell: () => Promise<void>;
  readonly state: PackagedStartupRendererReadinessState;
  readonly element?: RendererReadinessElement;
  readonly shouldMark?: () => boolean;
}): Promise<void> {
  if (input.state.clear) {
    await input.hydrateShell();
    return;
  }

  input.state.inFlight ??= markPackagedStartupRendererReadyAfterShellHydration(input);
  const readiness = input.state.inFlight;
  try {
    input.state.clear ??= await readiness;
  } finally {
    if (input.state.inFlight === readiness) {
      input.state.inFlight = null;
    }
  }
}
