import type {
  ComputeOperationError,
  ComputeRuntimeProfile,
  ComputeRuntimeVerification,
} from "@scientfactory/compute";
import * as Effect from "effect/Effect";

export interface CheckedRuntime {
  readonly profile: ComputeRuntimeProfile;
  readonly verification: ComputeRuntimeVerification;
}

/**
 * A choice made for this project comes first, then the project's own environment, then a choice
 * for this machine, then the best ready runtime. A choice and a project's environment are intent:
 * they are used or their failure is shown, never silently replaced by another runtime.
 */
export interface RuntimeChoice {
  readonly mode: "automatic" | "explicit" | "project";
  readonly selected: CheckedRuntime | null;
  /** The runtime that should have run and why it cannot. */
  readonly blocker: CheckedRuntime | null;
  readonly problem: string | null;
}

const ready = (runtime: CheckedRuntime) => runtime.verification.readiness === "ready";

/** Verifies lazily, in discovery order, only as far as the decision needs. */
export const chooseRuntime = Effect.fn("RuntimeSelection.chooseRuntime")(function* (
  profiles: ReadonlyArray<ComputeRuntimeProfile>,
  explicitExecutable: string | null,
  verify: (profile: ComputeRuntimeProfile) => Effect.Effect<CheckedRuntime, ComputeOperationError>,
  options: { readonly chosenForProject?: boolean } = {},
): Effect.fn.Return<RuntimeChoice, ComputeOperationError> {
  const decide = (mode: RuntimeChoice["mode"], runtime: CheckedRuntime): RuntimeChoice =>
    ready(runtime)
      ? { mode, selected: runtime, blocker: null, problem: null }
      : {
          mode,
          selected: null,
          blocker: runtime,
          problem: runtime.verification.message ?? `${runtime.profile.displayName} cannot run.`,
        };
  const project = profiles.find((profile) => profile.source === "project");
  if (project !== undefined && options.chosenForProject !== true)
    return decide("project", yield* verify(project));
  if (explicitExecutable !== null) {
    const chosen =
      profiles.find((profile) => profile.executable === explicitExecutable) ??
      profiles.find((profile) => profile.source === "configured");
    if (chosen === undefined)
      return {
        mode: "explicit",
        selected: null,
        blocker: null,
        problem: "The selected runtime was not found. Choose another one.",
      };
    return decide("explicit", yield* verify(chosen));
  }
  let first: CheckedRuntime | null = null;
  for (const profile of profiles) {
    const checked = yield* verify(profile);
    if (ready(checked))
      return { mode: "automatic", selected: checked, blocker: null, problem: null };
    first ??= checked;
  }
  return first === null
    ? { mode: "automatic", selected: null, blocker: null, problem: null }
    : decide("automatic", first);
});

/** The chosen (or blocking) runtime first, then the rest in discovery order. */
export function orderByChoice<T extends { readonly profile: ComputeRuntimeProfile }>(
  runtimes: ReadonlyArray<T>,
  choice: RuntimeChoice,
): ReadonlyArray<T> {
  const lead = (choice.selected ?? choice.blocker)?.profile.executable;
  const index = runtimes.findIndex((runtime) => runtime.profile.executable === lead);
  return index <= 0 ? runtimes : [runtimes[index]!, ...runtimes.filter((_, at) => at !== index)];
}
