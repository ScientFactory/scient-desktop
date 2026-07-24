// FILE: providerConnectionPresentation.ts
// Purpose: Maps provider health and connection progress to plain-language setup actions.
// Layer: Web presentation logic

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderConnectionMethod,
  type ServerProviderInstallPlan,
  type ServerProviderStatus,
} from "@synara/contracts";
import { compareSemverVersions } from "@synara/shared/providerVersions";

const PROVIDER_INSTALL_URLS: Partial<Record<ProviderKind, string>> = {
  codex: "https://help.openai.com/en/articles/11096431",
  claudeAgent: "https://code.claude.com/docs/en/installation",
  cursor: "https://docs.cursor.com/en/cli/installation",
  antigravity: "https://antigravity.google/docs/cli-using",
  grok: "https://docs.x.ai/build/overview",
  droid: "https://docs.factory.ai/cli/getting-started/quickstart.md",
  kilo: "https://kilo.ai/docs/cli",
  opencode: "https://opencode.ai/docs/",
  pi: "https://pi.dev/docs/latest",
};

export function providerConnectionMethod(
  provider: ProviderKind,
): ServerProviderConnectionMethod | null {
  if (provider === "codex") return "codex_browser";
  if (provider === "claudeAgent") return "claude_account";
  if (provider === "cursor") return "cursor_browser";
  if (provider === "antigravity") return "antigravity_browser";
  if (provider === "grok") return "grok_browser";
  if (provider === "droid") return "droid_device_pairing";
  return null;
}

export const CLAUDE_CONNECTION_METHOD_OPTIONS: ReadonlyArray<{
  readonly method: Extract<
    ServerProviderConnectionMethod,
    "claude_account" | "claude_sso" | "claude_console"
  >;
  readonly label: string;
  readonly description: string;
}> = [
  {
    method: "claude_account",
    label: "Claude account",
    description: "Use the same account Claude uses in your terminal.",
  },
  {
    method: "claude_sso",
    label: "Work or organization SSO",
    description: "Force your organization's SSO sign-in.",
  },
  {
    method: "claude_console",
    label: "Anthropic Console / API",
    description: "Use a Console account with API billing.",
  },
];

export function providerInstallUrl(provider: ProviderKind): string | null {
  return PROVIDER_INSTALL_URLS[provider] ?? null;
}

export function providerConnectionTitle(provider: ProviderKind): string {
  return `Connect ${PROVIDER_DISPLAY_NAMES[provider] ?? provider}`;
}

export type ProviderConnectionPrimaryAction =
  | "install"
  | "sign_in"
  | "open_install_guide"
  | "check_again"
  | "done"
  | "none";

export interface ProviderConnectionPresentation {
  readonly title: string;
  readonly description: string;
  readonly primaryAction: ProviderConnectionPrimaryAction;
  readonly primaryLabel: string;
  readonly busy: boolean;
  readonly canCancel: boolean;
  readonly canRestart?: boolean;
}

export function describeManagedProviderUpdate(input: {
  readonly provider: ProviderKind;
  readonly status: ServerProviderStatus;
  readonly plan: ServerProviderInstallPlan | null;
  readonly updateStarted: boolean;
}): ProviderConnectionPresentation {
  const label = PROVIDER_DISPLAY_NAMES[input.provider] ?? input.provider;
  const title = `Update ${label}`;
  const installation = input.status.installationState;
  if (
    input.updateStarted &&
    installation &&
    !["installed", "succeeded", "failed", "cancelled"].includes(installation.status)
  ) {
    return {
      title,
      description: installation.message,
      primaryAction: "none",
      primaryLabel: "Updating…",
      busy: true,
      canCancel: true,
    };
  }
  if (input.updateStarted && installation?.status === "installed") {
    return {
      title,
      description:
        `${label} ${installation.version ?? ""} is installed, verified, and ready to use.`.replace(
          /\s+/gu,
          " ",
        ),
      primaryAction: "done",
      primaryLabel: "Done",
      busy: false,
      canCancel: false,
    };
  }
  if (
    input.updateStarted &&
    !input.plan &&
    (installation?.status === "failed" || installation?.status === "cancelled")
  ) {
    return {
      title,
      description: installation.message,
      primaryAction: "install",
      primaryLabel: "Try again",
      busy: false,
      canCancel: false,
    };
  }
  const currentVersion = input.status.runtime?.managedVersion;
  if (input.plan && currentVersion) {
    const comparison = compareSemverVersions(input.plan.version, currentVersion);
    if (comparison <= 0) {
      return {
        title,
        description:
          comparison === 0
            ? `${label} ${currentVersion} is already the latest stable version.`
            : `${label} ${currentVersion} is newer than the provider's current stable version ${input.plan.version}. Scient will not downgrade it.`,
        primaryAction: "done",
        primaryLabel: "Done",
        busy: false,
        canCancel: false,
      };
    }
  }
  return {
    title,
    description: input.plan
      ? `Scient found ${label} ${input.plan.version} on the provider's trusted stable channel. The verified download is ready below.`
      : `Scient will check ${label}'s trusted stable channel and prepare the latest compatible version.`,
    primaryAction: "install",
    primaryLabel: input.plan ? `Update ${label}` : "Check latest version",
    busy: false,
    canCancel: false,
  };
}

export function describeProviderConnection(
  provider: ProviderKind,
  status: ServerProviderStatus | null | undefined,
  options?: { readonly forceReconnect?: boolean },
): ProviderConnectionPresentation {
  const title = providerConnectionTitle(provider);
  const label = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  const operation = status?.connectionState;
  const installation = status?.installationState;

  if (
    installation &&
    !["installed", "succeeded", "failed", "cancelled"].includes(installation.status)
  ) {
    return {
      title,
      description: installation.message,
      primaryAction: "none",
      primaryLabel: "Installing…",
      busy: true,
      canCancel: true,
    };
  }

  if (
    operation &&
    (operation.status === "starting" ||
      operation.status === "waiting_for_browser" ||
      operation.status === "verifying")
  ) {
    return {
      title,
      description: operation.message,
      primaryAction: "done",
      primaryLabel: "Continue in background",
      busy: true,
      canCancel: true,
      canRestart: true,
    };
  }

  if (options?.forceReconnect && provider === "codex") {
    if (status?.available && status.requiresProviderAccount === true) {
      if (operation?.status === "failed" || operation?.status === "cancelled") {
        return {
          title,
          description: operation.message,
          primaryAction: "sign_in",
          primaryLabel: "Try again",
          busy: false,
          canCancel: false,
        };
      }
      return {
        title,
        description:
          "Codex reported that its account session is no longer authorized. Reconnect in the browser, then press Send again; your draft and attachments stay here.",
        primaryAction: "sign_in",
        primaryLabel: "Reconnect Codex",
        busy: false,
        canCancel: false,
      };
    }
    return {
      title,
      description:
        "Scient needs to verify that this Codex runtime uses your OpenAI account before opening account recovery.",
      primaryAction: "check_again",
      primaryLabel: "Check again",
      busy: false,
      canCancel: false,
    };
  }

  if (status?.available && status.authStatus === "authenticated") {
    if (status.status !== "ready") {
      return {
        title,
        description:
          status.message ?? `${label} is connected, but Scient cannot load it right now.`,
        primaryAction: "check_again",
        primaryLabel: "Check again",
        busy: false,
        canCancel: false,
      };
    }
    return {
      title,
      description: `${label} is connected and ready to use.`,
      primaryAction: "done",
      primaryLabel: "Done",
      busy: false,
      canCancel: false,
    };
  }

  if (operation) {
    switch (operation.status) {
      case "starting":
      case "waiting_for_browser":
      case "verifying":
        break;
      case "connected":
        return {
          title,
          description: `${label} needs to be verified again.`,
          primaryAction: "check_again",
          primaryLabel: "Check again",
          busy: false,
          canCancel: false,
        };
      case "failed":
      case "cancelled": {
        const canRetrySignIn =
          providerConnectionMethod(provider) !== null &&
          (status?.available === true ||
            installation?.status === "installed" ||
            status?.runtime?.source === "managed");
        return {
          title,
          description: operation.message,
          primaryAction: canRetrySignIn ? "sign_in" : "open_install_guide",
          primaryLabel: canRetrySignIn ? "Try again" : "Open installation guide",
          busy: false,
          canCancel: false,
        };
      }
    }
  }

  if (!status) {
    return {
      title,
      description: `Scient is checking whether ${label} is available on this computer.`,
      primaryAction: "check_again",
      primaryLabel: "Check again",
      busy: false,
      canCancel: false,
    };
  }

  if (!status.available) {
    if (
      (installation?.status === "failed" || installation?.status === "cancelled") &&
      status.runtime?.source === "missing" &&
      status.runtime.canInstall
    ) {
      return {
        title,
        description: installation.message,
        primaryAction: "install",
        primaryLabel: "Try installation again",
        busy: false,
        canCancel: false,
      };
    }
    if (status.installationState?.status === "installed" && providerConnectionMethod(provider)) {
      return {
        title,
        description: `${label} is installed and verified. Continue to the provider's secure browser sign-in.`,
        primaryAction: "sign_in",
        primaryLabel: "Continue in browser",
        busy: false,
        canCancel: false,
      };
    }
    if (status.runtime?.source === "custom" && status.runtime.message) {
      return {
        title,
        description: status.runtime.message,
        primaryAction: "check_again",
        primaryLabel: "Check again",
        busy: false,
        canCancel: false,
      };
    }
    if (status.runtime?.canInstall) {
      return {
        title,
        description: `${label} is not installed. Scient can download a verified, private copy for this app—no Homebrew, Node.js, npm, terminal, or administrator password required.`,
        primaryAction: "install",
        primaryLabel: `Install ${label}`,
        busy: false,
        canCancel: false,
      };
    }
    return {
      title,
      description: `${label} needs to be installed first. Scient will check again when you return.`,
      primaryAction: providerInstallUrl(provider) ? "open_install_guide" : "check_again",
      primaryLabel: providerInstallUrl(provider) ? "Open installation guide" : "Check again",
      busy: false,
      canCancel: false,
    };
  }

  if (status.authStatus === "unauthenticated") {
    const method = providerConnectionMethod(provider);
    if (provider === "claudeAgent" && method) {
      return {
        title,
        description:
          "Scient uses Claude's official sign-in and automatically detects an account already connected in your terminal. Claude keeps your credentials.",
        primaryAction: "sign_in",
        primaryLabel: "Connect Claude",
        busy: false,
        canCancel: false,
      };
    }
    return {
      title,
      description: method
        ? `Scient will start ${label}'s secure sign-in and open your browser. Your account credentials stay with ${label}.`
        : `${label} is installed but still needs its own account sign-in.`,
      primaryAction: method
        ? "sign_in"
        : providerInstallUrl(provider)
          ? "open_install_guide"
          : "check_again",
      primaryLabel: method
        ? "Continue in browser"
        : providerInstallUrl(provider)
          ? "Open sign-in instructions"
          : "Check again",
      busy: false,
      canCancel: false,
    };
  }

  return {
    title,
    description: status.message ?? `Scient could not confirm ${label}'s connection yet.`,
    primaryAction: "check_again",
    primaryLabel: "Check again",
    busy: false,
    canCancel: false,
  };
}
