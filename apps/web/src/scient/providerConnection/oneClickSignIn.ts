import type { ProviderConnectionMethod, ServerProvider } from "@t3tools/contracts";

/**
 * Methods that sign in through a page Scient opens, with nothing to choose or
 * enter first. Any other method shows a choice, a code or a pairing in its
 * setup view.
 */
const BROWSER_SIGN_IN_METHODS: ReadonlySet<ProviderConnectionMethod> = new Set([
  "codex_browser",
  "cursor_browser",
  "antigravity_google",
]);

/** The one method a single click can start for this provider, if there is exactly one. */
export function oneClickSignInMethod(provider: ServerProvider): ProviderConnectionMethod | null {
  const methods = (provider.connection?.methods ?? []).filter((method) =>
    BROWSER_SIGN_IN_METHODS.has(method),
  );
  return methods.length === 1 ? methods[0]! : null;
}
