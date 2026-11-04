import type { SourceControlAppSignIn } from "@t3tools/source-control-core/shared/definition";

/**
 * Scient's own GitHub App, which Source Control signs in through; the server supplies its client
 * ID. Signing in through it lifts the per-user API rate limit to the app's.
 */
export const SCIENT_APP_SIGN_IN: SourceControlAppSignIn = {
  appName: "Scient for GitHub",
  hosts: ["github.com"],
  installUrl: "https://github.com/apps/scient-for-github/installations/new",
  revokeUrl: "https://github.com/settings/apps/authorizations",
};
