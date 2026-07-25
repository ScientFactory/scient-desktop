// FILE: providerDisconnect.ts
// Purpose: Single source of truth for which providers Scient can sign out of
//          through their own CLI, and the exact logout argv. Consumed by the
//          server (to run the logout) and the web UI (to show the Disconnect
//          action), so the two never drift.
// Layer: Shared runtime utility

import type { ProviderKind } from "@synara/contracts";

/**
 * Each provider CLI's own sign-out argv. Disconnecting always defers to the CLI
 * so credentials stay owned by the provider, never cleared by Scient directly.
 * Antigravity (no login/logout subcommand) and Droid (device pairing) are
 * intentionally absent — no CLI sign-out to defer to.
 */
export const PROVIDER_DISCONNECT_COMMAND_ARGS = {
  codex: ["logout"],
  claudeAgent: ["auth", "logout"],
  cursor: ["logout"],
  grok: ["logout"],
} as const satisfies Partial<Record<ProviderKind, ReadonlyArray<string>>>;

export function providerDisconnectCommandArgs(
  provider: ProviderKind,
): ReadonlyArray<string> | null {
  const map: Partial<Record<ProviderKind, ReadonlyArray<string>>> =
    PROVIDER_DISCONNECT_COMMAND_ARGS;
  return map[provider] ?? null;
}

export function providerSupportsDisconnect(provider: ProviderKind): boolean {
  return providerDisconnectCommandArgs(provider) !== null;
}
