export const PACKAGED_STARTUP_RENDERER_READY_DATASET_KEY = "scientRendererReady";

type RendererReadinessElement = Pick<HTMLElement, "dataset">;

export interface PackagedStartupRendererReadinessState {
  clear: (() => void) | null;
  generation: number;
  disposed: boolean;
}

export function createPackagedStartupRendererReadinessState(): PackagedStartupRendererReadinessState {
  return { clear: null, generation: 0, disposed: false };
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
  const generation = ++input.state.generation;
  input.state.clear?.();
  input.state.clear = null;

  try {
    await input.hydrateShell();
  } catch (error) {
    if (input.state.disposed || input.state.generation !== generation) return;
    throw error;
  }
  if (
    input.state.disposed ||
    input.state.generation !== generation ||
    (input.shouldMark && !input.shouldMark())
  ) {
    return;
  }

  const element = input.element ?? document.documentElement;
  element.dataset[PACKAGED_STARTUP_RENDERER_READY_DATASET_KEY] = "true";
  input.state.clear = () => {
    delete element.dataset[PACKAGED_STARTUP_RENDERER_READY_DATASET_KEY];
  };
}

export function disposePackagedStartupRendererReadiness(
  state: PackagedStartupRendererReadinessState,
): void {
  state.disposed = true;
  state.generation += 1;
  state.clear?.();
  state.clear = null;
}
