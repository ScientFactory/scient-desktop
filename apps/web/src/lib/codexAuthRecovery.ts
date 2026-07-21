import type {
  OrchestrationThreadActivity,
  ProviderKind,
  ServerProviderStatus,
} from "@synara/contracts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function findCodexAuthenticationRecoveryActivityId(input: {
  readonly provider: ProviderKind;
  readonly sessionStatus: string | null | undefined;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly providerStatus: ServerProviderStatus | null | undefined;
}): string | null {
  if (
    input.provider !== "codex" ||
    input.sessionStatus !== "error" ||
    !input.providerStatus ||
    input.providerStatus.requiresProviderAccount === false
  ) {
    return null;
  }

  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index];
    if (activity?.kind !== "runtime.error") continue;
    return asObject(activity.payload)?.class === "authentication_error"
      ? String(activity.id)
      : null;
  }

  return null;
}
