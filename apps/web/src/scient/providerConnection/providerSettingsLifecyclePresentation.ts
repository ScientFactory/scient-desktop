import type { ProviderManagedRuntimeAction, ServerProvider } from "@t3tools/contracts";

import {
  isActiveProviderConnectionOperation,
  isActiveProviderRuntimeOperation,
  isProviderRuntimePresentedAsInstalled,
  needsManagedRuntimeRecovery,
} from "./providerConnectionPresentation";
import { hasExternalProviderUpdate } from "./providerLifecycleActions";

export type ProviderSettingsLifecycleActionKind =
  | "enable"
  | "runtime"
  | "external-update"
  | "sign-in"
  | "continue"
  | "manage";

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
  readonly actionKind: ProviderSettingsLifecycleActionKind | null;
  readonly runtimeAction: ProviderManagedRuntimeAction | null;
  readonly busy: boolean;
}

function action(input: {
  readonly kind: ProviderSettingsLifecycleActionKind;
  readonly label: string;
  readonly runtimeAction?: ProviderManagedRuntimeAction;
}) {
  return {
    actionKind: input.kind,
    actionLabel: input.label,
    runtimeAction: input.runtimeAction ?? null,
  } as const;
}

const NO_ACTION = {
  actionKind: null,
  actionLabel: null,
  runtimeAction: null,
} as const;

export function providerSettingsLifecyclePresentation(
  provider: ServerProvider | undefined,
  displayName: string,
): ProviderSettingsLifecyclePresentation {
  if (!provider) {
    return {
      kind: "checking",
      statusLabel: null,
      detail: "Checking installation and sign-in status…",
      ...NO_ACTION,
      busy: true,
    };
  }
  if (!provider.enabled) {
    return {
      kind: "disabled",
      statusLabel: "Disabled",
      detail: "Hidden from new conversations.",
      ...action({ kind: "enable", label: "Enable" }),
      busy: false,
    };
  }

  const runtimeOperation = provider.connection?.runtime?.operation ?? null;
  if (runtimeOperation?.status === "failed") {
    const retryableAction = provider.connection?.runtime?.actions.includes(runtimeOperation.action)
      ? runtimeOperation.action
      : null;
    return {
      kind: "failed",
      statusLabel: "Setup failed",
      detail: runtimeOperation.message,
      ...(retryableAction
        ? action({ kind: "runtime", label: "Retry", runtimeAction: retryableAction })
        : action({ kind: "manage", label: "Manage" })),
      busy: false,
    };
  }
  if (runtimeOperation && isActiveProviderRuntimeOperation(runtimeOperation)) {
    return {
      kind: "installing",
      statusLabel: runtimeOperation.status === "removing" ? "Removing" : "Installing",
      detail: runtimeOperation.message,
      ...action({ kind: "continue", label: "Continue" }),
      busy: true,
    };
  }
  if (
    !isProviderRuntimePresentedAsInstalled(provider) ||
    provider.connection?.runtime?.source === "missing"
  ) {
    const canInstall = provider.connection?.runtime?.actions.includes("install") ?? false;
    return {
      kind: "not-installed",
      statusLabel: "Not installed",
      detail:
        provider.driver === "codex"
          ? "Install Codex to connect your ChatGPT account."
          : `Install ${displayName} to connect your account.`,
      ...(canInstall
        ? action({ kind: "runtime", label: "Install", runtimeAction: "install" })
        : action({ kind: "manage", label: "Manage" })),
      busy: false,
    };
  }

  if (provider.connection?.runtime?.actions.includes("update")) {
    return {
      kind: "attention",
      statusLabel: "Update available",
      detail: `A reviewed ${displayName} update is ready to install.`,
      ...action({ kind: "runtime", label: "Update", runtimeAction: "update" }),
      busy: false,
    };
  }
  if (hasExternalProviderUpdate(provider)) {
    return {
      kind: "attention",
      statusLabel: "Update available",
      detail:
        provider.versionAdvisory?.message ??
        `A newer ${displayName} version is available on this computer.`,
      ...action({ kind: "external-update", label: "Update" }),
      busy: false,
    };
  }
  if (needsManagedRuntimeRecovery(provider)) {
    const canRepair = provider.connection?.runtime?.actions.includes("repair") ?? false;
    return {
      kind: "attention",
      statusLabel: "Runtime needs repair",
      detail: provider.message ?? `${displayName} could not start correctly.`,
      ...(canRepair
        ? action({ kind: "runtime", label: "Repair", runtimeAction: "repair" })
        : action({ kind: "manage", label: "Manage" })),
      busy: false,
    };
  }

  if (provider.auth.status === "authenticated" || provider.auth.required === false) {
    if (provider.status !== "ready" || provider.models.length === 0) {
      return {
        kind: "attention",
        statusLabel: "Needs attention",
        detail: provider.message ?? `${displayName} is connected but has no available model.`,
        ...action({ kind: "manage", label: "Manage" }),
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
      ...action({ kind: "manage", label: "Manage" }),
      busy: false,
    };
  }
  const connectionOperation = provider.connection?.operation ?? null;
  if (connectionOperation?.status === "failed") {
    const canRetrySignIn = (provider.connection?.methods.length ?? 0) > 0;
    return {
      kind: "failed",
      statusLabel: "Sign-in failed",
      detail: connectionOperation.message,
      ...(canRetrySignIn
        ? action({ kind: "sign-in", label: "Retry" })
        : action({ kind: "manage", label: "Manage" })),
      busy: false,
    };
  }
  if (connectionOperation && isActiveProviderConnectionOperation(connectionOperation)) {
    return {
      kind: "signing-in",
      statusLabel: connectionOperation.status === "verifying" ? "Verifying" : "Signing in",
      detail: connectionOperation.message,
      ...action({ kind: "continue", label: "Continue" }),
      busy: true,
    };
  }
  if ((provider.connection?.methods.length ?? 0) > 0) {
    return {
      kind: "sign-in-required",
      statusLabel: "Sign-in required",
      detail:
        provider.driver === "codex"
          ? "Connect your ChatGPT account."
          : provider.driver === "droid"
            ? "Sign in with your existing Factory subscription."
            : "Connect your account.",
      ...action({ kind: "sign-in", label: "Sign in" }),
      busy: false,
    };
  }
  return {
    kind: "manual",
    statusLabel: "Manual setup",
    detail: provider.message ?? "Use the provider's advanced configuration.",
    ...NO_ACTION,
    busy: false,
  };
}
