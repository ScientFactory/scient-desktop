import type { ServerProvider } from "@t3tools/contracts";

export type ProviderSettingsLifecycleKind =
  | "checking"
  | "disabled"
  | "not-installed"
  | "installing"
  | "sign-in-required"
  | "signing-in"
  | "ready"
  | "attention"
  | "failed"
  | "manual";

export interface ProviderSettingsLifecyclePresentation {
  readonly kind: ProviderSettingsLifecycleKind;
  readonly statusLabel: string | null;
  readonly detail: string | null;
  readonly actionLabel: string | null;
  readonly busy: boolean;
}

const ACTIVE_RUNTIME_STATUSES = new Set([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
  "removing",
]);
const ACTIVE_CONNECTION_STATUSES = new Set([
  "starting",
  "waiting_for_browser",
  "waiting_for_device_code",
  "verifying",
]);

export function providerSettingsLifecyclePresentation(
  provider: ServerProvider | undefined,
  displayName: string,
): ProviderSettingsLifecyclePresentation {
  if (!provider) {
    return {
      kind: "checking",
      statusLabel: null,
      detail: "Checking installation and sign-in status…",
      actionLabel: null,
      busy: true,
    };
  }
  if (!provider.enabled) {
    return {
      kind: "disabled",
      statusLabel: "Disabled",
      detail: "Hidden from new conversations.",
      actionLabel: null,
      busy: false,
    };
  }

  const runtimeOperation = provider.connection?.runtime?.operation ?? null;
  if (runtimeOperation?.status === "failed") {
    return {
      kind: "failed",
      statusLabel: "Setup failed",
      detail: runtimeOperation.message,
      actionLabel: "Retry",
      busy: false,
    };
  }
  if (runtimeOperation && ACTIVE_RUNTIME_STATUSES.has(runtimeOperation.status)) {
    return {
      kind: "installing",
      statusLabel: runtimeOperation.status === "removing" ? "Removing" : "Installing",
      detail: runtimeOperation.message,
      actionLabel: "Continue",
      busy: true,
    };
  }
  if (!provider.installed || provider.connection?.runtime?.source === "missing") {
    return {
      kind: "not-installed",
      statusLabel: "Not installed",
      detail:
        provider.driver === "codex"
          ? "Install Codex to connect your ChatGPT account."
          : `Install ${displayName} to connect your account.`,
      actionLabel: "Install",
      busy: false,
    };
  }

  if (provider.auth.status === "authenticated" || provider.auth.required === false) {
    if (provider.status !== "ready" || provider.models.length === 0) {
      return {
        kind: "attention",
        statusLabel: "Needs attention",
        detail: provider.message ?? `${displayName} is connected but has no available model.`,
        actionLabel: "Manage",
        busy: false,
      };
    }
    return {
      kind: "ready",
      statusLabel: "Ready",
      detail:
        provider.auth.required === false
          ? "Ready without account sign-in."
          : (provider.auth.label ?? provider.auth.email ?? "Account connected."),
      actionLabel: "Manage",
      busy: false,
    };
  }
  const connectionOperation = provider.connection?.operation ?? null;
  if (connectionOperation?.status === "failed") {
    return {
      kind: "failed",
      statusLabel: "Sign-in failed",
      detail: connectionOperation.message,
      actionLabel: "Retry",
      busy: false,
    };
  }
  if (connectionOperation && ACTIVE_CONNECTION_STATUSES.has(connectionOperation.status)) {
    return {
      kind: "signing-in",
      statusLabel: connectionOperation.status === "verifying" ? "Verifying" : "Signing in",
      detail: connectionOperation.message,
      actionLabel: "Continue",
      busy: true,
    };
  }
  if ((provider.connection?.methods.length ?? 0) > 0) {
    return {
      kind: "sign-in-required",
      statusLabel: "Sign-in required",
      detail:
        provider.driver === "codex" ? "Connect your ChatGPT account." : "Connect your account.",
      actionLabel: "Sign in",
      busy: false,
    };
  }
  return {
    kind: "manual",
    statusLabel: "Manual setup",
    detail: provider.message ?? "Use the provider's advanced configuration.",
    actionLabel: null,
    busy: false,
  };
}
