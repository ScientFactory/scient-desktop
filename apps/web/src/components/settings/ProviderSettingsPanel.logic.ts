import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  ProjectId,
  ProjectSettingsOverrides,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";

import type { ProviderOperateAccess } from "../../providerOperateAccess";

export {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../../providerOperateAccess";
export type { ProviderOperateAccess } from "../../providerOperateAccess";

export interface ProviderEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function isProviderSettingsEnvironmentAvailable(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
}): boolean {
  return input.connectionPhase === "connected" && input.hasServerConfig;
}

export function buildProviderEnvironmentOptions<T extends ProviderEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
  environmentIds?: readonly EnvironmentId[],
): ReadonlyArray<T> {
  const allowed = environmentIds ? new Set(environmentIds) : null;
  return environments
    .filter((environment) => !allowed || allowed.has(environment.environmentId))
    .toSorted((left, right) => {
      const leftIsPrimary = left.environmentId === primaryEnvironmentId;
      const rightIsPrimary = right.environmentId === primaryEnvironmentId;
      if (leftIsPrimary !== rightIsPrimary) {
        return leftIsPrimary ? -1 : 1;
      }
      return (
        left.label.localeCompare(right.label) ||
        String(left.environmentId).localeCompare(String(right.environmentId))
      );
    });
}

export function resolveSelectedProviderEnvironmentId(
  environments: ReadonlyArray<ProviderEnvironmentOptionLike>,
  selectedEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  if (
    primaryEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === primaryEnvironmentId)
  ) {
    return primaryEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export type ProviderEnvironmentAccess =
  | { readonly kind: "editable" }
  /** `reason` distinguishes waiting on the device from waiting on permissions. */
  | { readonly kind: "loading"; readonly reason: "config" | "permissions" }
  | { readonly kind: "read-only" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

/**
 * The patch for one instance's project override, following the envelope
 * replacement rule for `projectSettingsOverrides`: the returned entry
 * replaces the project's whole override set, and `null` removes it.
 * `value: undefined` resets that single instance back to inheriting the
 * environment's enablement, leaving any other overridden keys untouched.
 *
 * `providerInstances` is always sent explicitly, even as `{}`, because the
 * server keeps a stored `providerInstances` map when an incoming entry omits
 * the key (so older clients that don't know the field cannot wipe it by
 * editing another setting). Omitting it here would undo the very clear this
 * function means to make.
 */
/** Every checkout of a project on one environment shares the same choice. */
export function buildProviderInstanceOverridePatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectIds: readonly ProjectId[],
  instanceId: ProviderInstanceId,
  value: boolean | undefined,
): Record<ProjectId, ProjectSettingsOverrides | null> {
  const patch: Record<ProjectId, ProjectSettingsOverrides | null> = {};
  for (const projectId of projectIds) {
    const current = settings.projectSettingsOverrides[projectId];
    const instances = { ...current?.providerInstances };
    const instance = { ...instances[instanceId] };
    if (value === undefined) delete instance.enabled;
    else instance.enabled = value;
    if (Object.keys(instance).length > 0) instances[instanceId] = instance;
    else delete instances[instanceId];

    const { providerInstances: _omit, ...rest } = current ?? {};
    const nextEntry: ProjectSettingsOverrides = { ...rest, providerInstances: instances };
    patch[projectId] =
      Object.keys(rest).length === 0 && Object.keys(instances).length === 0 ? null : nextEntry;
  }
  return patch;
}

export function classifyProviderEnvironmentAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly operateAccess: ProviderOperateAccess;
}): ProviderEnvironmentAccess {
  if (input.connectionPhase === "error") {
    return { kind: "error" };
  }
  if (input.connectionPhase !== "connected") {
    return { kind: "unavailable" };
  }
  if (!input.hasServerConfig) {
    return { kind: "loading", reason: "config" };
  }
  if (input.operateAccess === "pending") {
    return { kind: "loading", reason: "permissions" };
  }
  if (input.operateAccess === "denied") {
    return { kind: "read-only" };
  }
  return { kind: "editable" };
}
