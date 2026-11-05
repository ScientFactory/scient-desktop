import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";
import { type LucideIcon, LockIcon, PenLineIcon, ShieldOffIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

const compatibleModeSets = Array.from({ length: 1 << runtimeModeOptions.length }, (_, mask) =>
  runtimeModeOptions.filter((_, index) => mask & (1 << index)),
);
type ResolvedRuntimeModeOption = {
  mode: RuntimeMode;
  disabledReason?: string;
} & (typeof runtimeModeConfig)[RuntimeMode];
const unmanagedPolicyKey = {};
const optionsByPolicy = new WeakMap<
  object,
  WeakMap<ReadonlyArray<RuntimeMode>, ResolvedRuntimeModeOption[]>
>();

/** The modes a provider supports (all when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? compatibleModeSets[
          runtimeModeOptions.reduce(
            (mask, mode, index) => mask | (supportedRuntimeModes.includes(mode) ? 1 << index : 0),
            0,
          )
        ]!
      : runtimeModeOptions;
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
): ReadonlyArray<ResolvedRuntimeModeOption> {
  const key = managedPolicy ?? unmanagedPolicyKey;
  let cache = optionsByPolicy.get(key);
  if (!cache) {
    cache = new WeakMap();
    optionsByPolicy.set(key, cache);
  }
  const cached = cache.get(modes);
  if (cached) return cached;
  const options = modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    const disabledReason = managedRuntimeModeDenial(managedPolicy, mode);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
  cache.set(modes, options);
  return options;
}
