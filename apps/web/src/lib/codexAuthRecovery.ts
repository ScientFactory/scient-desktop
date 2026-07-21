import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";

export function findCodexAuthenticationRecoveryActivityId(input: {
  readonly provider: ProviderKind;
  readonly sessionStatus: string | null | undefined;
  readonly sessionLastErrorEventId: string | null | undefined;
  readonly sessionLastErrorClass: string | null | undefined;
  readonly providerStatus: ServerProviderStatus | null | undefined;
}): string | null {
  if (
    input.provider !== "codex" ||
    input.sessionStatus !== "error" ||
    !input.sessionLastErrorEventId ||
    input.sessionLastErrorClass !== "authentication_error" ||
    !input.providerStatus ||
    input.providerStatus.requiresProviderAccount !== true
  ) {
    return null;
  }

  return input.sessionLastErrorEventId;
}
