// FILE: providerSignOut.ts
// Purpose: Keep provider CLI sign-out support and fixed argv consistent across server and web.
// Layer: Shared runtime utility

import type { ProviderKind } from "@synara/contracts";

export const PROVIDER_SIGN_OUT_COMMAND_ARGS = {
  codex: ["logout"],
  claudeAgent: ["auth", "logout"],
  cursor: ["logout"],
  grok: ["logout"],
} as const satisfies Partial<Record<ProviderKind, ReadonlyArray<string>>>;

export function providerSignOutCommandArgs(provider: ProviderKind): ReadonlyArray<string> | null {
  const commands: Partial<Record<ProviderKind, ReadonlyArray<string>>> =
    PROVIDER_SIGN_OUT_COMMAND_ARGS;
  return commands[provider] ?? null;
}

export function providerSupportsSignOut(provider: ProviderKind): boolean {
  return providerSignOutCommandArgs(provider) !== null;
}
